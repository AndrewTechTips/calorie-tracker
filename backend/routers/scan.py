import json
import logging
from io import BytesIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from PIL import Image
from pydantic import ValidationError

from auth import get_current_user, rate_limit_key
from models import DescriptionScanRequest, IngredientItem, ScanResult
from rate_limit import limiter
from services import ai_usage_service, quota_service
from services.gemini_service import InvalidFoodInputError, analyze_food_image, estimate_from_description

logger = logging.getLogger("scan")

router = APIRouter(prefix="/scan", tags=["scan"])

ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic"}
# Stock Pillow (no extra codec plugin) can't decode HEIC, so we only run a real
# pixel-level verification on the formats it actually supports. HEIC is still
# gated by content-type + size above, same as before — not weaker than it was.
PIL_VERIFIABLE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB
# 300, not a looser number: gemini_service.analyze_food_image truncates this to
# 300 chars anyway before it ever reaches Gemini, so a bigger cap here only
# used to invite a confusing "why was the rest of my context ignored" gap
# between what the frontend accepted and what actually got used.
MAX_CONTEXT_CHARS = 300
# Matches DescriptionScanRequest.attached_items' own max_length in models.py —
# repeated here because this multipart path parses its own JSON-encoded copy
# of the same shape rather than going through that Pydantic model directly.
MAX_ATTACHED_ITEMS = 3


# ---------------------------------------------------------------------------
# Barcode-attachment merge — shared by both AI paths below. Deliberately NOT
# routed through Gemini for the arithmetic: the attached item(s) already carry
# exact, user-confirmed macros from a barcode lookup (frontend scales them to
# the confirmed weight before sending, same "known values, not a guess"
# convention as DailyLogCorrection in models.py), so summing them in here is
# strictly more reliable than trusting a second model call to add them up
# correctly. Gemini is still told about these items (see attached_item_names
# passed into analyze_food_image/estimate_from_description) so it excludes
# them from its own estimate instead of double-counting a component it can
# also see/read in the photo or description text.
# ---------------------------------------------------------------------------
def _merge_attached_items(data: dict, attached: list[IngredientItem]) -> dict:
    if not attached:
        return data
    extra = [item.model_dump() for item in attached]
    # ScanResult.ingredients caps at 15 total — leave room for the attached
    # items rather than risk exceeding it (Gemini's own list is already
    # schema-capped at 12, so this rarely trims anything in practice).
    ai_ingredients = (data.get("ingredients") or [])[: max(0, 15 - len(extra))]
    data["ingredients"] = ai_ingredients + extra
    data["weight_g"] = round(data.get("weight_g", 0) + sum(i.weight_g for i in attached), 1)
    data["calories"] = round(data.get("calories", 0) + sum(i.calories for i in attached), 1)
    data["protein"] = round(data.get("protein", 0) + sum(i.protein for i in attached), 1)
    data["carbs"] = round(data.get("carbs", 0) + sum(i.carbs for i in attached), 1)
    data["fats"] = round(data.get("fats", 0) + sum(i.fats for i in attached), 1)
    data["fiber"] = round(data.get("fiber", 0) + sum(i.fiber for i in attached), 1)
    data["sugar"] = round(data.get("sugar", 0) + sum(i.sugar for i in attached), 1)
    data["sodium"] = round(data.get("sodium", 0) + sum(i.sodium for i in attached), 1)
    return data


def _sum_attached_items(attached: list[IngredientItem]) -> dict:
    """The no-AI-call path: the user attached barcode item(s) but left the
    description blank (POST /scan/describe only — POST /scan always has an
    image, so it always calls Gemini). Purely deterministic, costs no Gemini
    quota, and returns the exact same ScanResult shape either way."""
    return {
        "food_name": " + ".join(item.food_name for item in attached),
        "weight_g": round(sum(i.weight_g for i in attached), 1),
        "calories": round(sum(i.calories for i in attached), 1),
        "protein": round(sum(i.protein for i in attached), 1),
        "carbs": round(sum(i.carbs for i in attached), 1),
        "fats": round(sum(i.fats for i in attached), 1),
        "fiber": round(sum(i.fiber for i in attached), 1),
        "sugar": round(sum(i.sugar for i in attached), 1),
        "sodium": round(sum(i.sodium for i in attached), 1),
        "confidence_note": None,
        "ingredients": [item.model_dump() for item in attached],
    }


def _parse_attached_items_form(raw: str) -> list[IngredientItem]:
    """Parses POST /scan's JSON-encoded attached_items form field into the
    same shape DescriptionScanRequest.attached_items validates directly —
    multipart form data has no native way to carry a nested array, so the
    frontend JSON-encodes it into one text field instead."""
    try:
        raw_items = json.loads(raw or "[]")
        if not isinstance(raw_items, list):
            raise ValueError("attached_items must be a JSON array")
        return [IngredientItem.model_validate(item) for item in raw_items[:MAX_ATTACHED_ITEMS]]
    except (json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid attached item data.") from exc


@router.post("", response_model=ScanResult)
# Two clauses, not one: "10/minute" is the sustained/quota-aware ceiling
# (unchanged); "3/10 seconds" is the burst clause. A route-level
# @limiter.limit(...) decorator replaces rate_limit.py's app-wide defaults
# for this route rather than adding to them (see that file's long comment on
# why) — without a burst clause re-stated here, THIS endpoint specifically
# (the one that spends real Gemini quota per call) would be the one route
# with no flood protection at all.
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
# `response: Response` is required, not optional — see correct_log's own
# comment in routers/logs.py for why every key_func=rate_limit_key route
# needs this now that rate_limit.py sets headers_enabled=True.
async def scan_food(
    request: Request,
    response: Response,
    image: UploadFile = File(...),
    context_text: str = Form(default="", max_length=MAX_CONTEXT_CHARS),
    attached_items: str = Form(default="[]"),
    language: str = Form(default="en", max_length=5),
    user=Depends(get_current_user),
):
    parsed_attached_items = _parse_attached_items_form(attached_items)

    # Checked before touching the image at all: if the shared Gemini quota is
    # already spent, there's no point making the user upload/wait first.
    if not quota_service.has_capacity("gemini"):
        raise HTTPException(
            status_code=503,
            detail="AI scanning is at capacity for today — try again tomorrow, or log this meal manually.",
        )

    # Per-user daily ceiling on top of the shared provider capacity check
    # above (services/ai_usage_service.py) — that one protects the shared
    # Gemini key from every user combined; this one protects it from any
    # single user monopolizing it. Also checked before touching the image.
    if not await ai_usage_service.has_capacity(user.id, "scan"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "scan"))

    if image.content_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")

    # Content-Length covers the whole multipart body, not just the image part,
    # hence the small buffer — this is a cheap early rejection before we ever
    # read the body into memory; the authoritative check is still the actual
    # byte count below (a missing/wrong header can't be used to bypass it).
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_IMAGE_BYTES + 65_536:
        raise HTTPException(status_code=413, detail="Image too large (max 8MB)")

    image_bytes = await image.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 8MB)")

    # Defense-in-depth: the content-type header is client-supplied and can be
    # spoofed, so confirm the bytes actually decode as the image they claim to
    # be before spending a Gemini call on them.
    if image.content_type in PIL_VERIFIABLE_TYPES:
        try:
            with Image.open(BytesIO(image_bytes)) as img:
                img.verify()
        except Exception:
            raise HTTPException(status_code=415, detail="That file doesn't look like a valid image")

    # Atomic check-and-spend right before the real attempt (mirrors
    # quota_service.record_call's own positioning) — this, not the earlier
    # has_capacity() pre-check, is the airtight gate: see ai_usage_service's
    # module docstring for why the earlier check alone can't safely stop a
    # burst of concurrent requests from the same user.
    if not await ai_usage_service.try_consume(user.id, "scan"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "scan"))

    # context_text is free user input — it is treated as untrusted data inside
    # gemini_service, never concatenated into the system prompt itself.
    try:
        result = await analyze_food_image(
            image_bytes,
            image.content_type,
            context_text,
            attached_item_names=[item.food_name for item in parsed_attached_items],
            language="ro" if language == "ro" else "en",
        )
    except InvalidFoodInputError:
        raise HTTPException(
            status_code=422,
            detail="Couldn't identify food in that image. Try a clearer photo of your plate.",
        )
    except Exception:
        # Never echo raw exception text back to the client — it can leak
        # internals (library errors, partial stack info, etc.). Log it
        # server-side with the actual detail and return a generic message.
        logger.exception("Unexpected error analyzing scanned image")
        raise HTTPException(status_code=500, detail="Could not analyze that photo right now. Please try again.")

    return _merge_attached_items(result, parsed_attached_items)


@router.post("/describe", response_model=ScanResult)
# See scan_food's burst-clause comment above — same reasoning applies here.
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
# See scan_food's own comment above — same fix, same reason.
async def scan_description(request: Request, response: Response, payload: DescriptionScanRequest, user=Depends(get_current_user)):
    """The no-photo logging path: the user types (or voice-dictates, see
    frontend/js/scan.js) a description instead of taking a photo, optionally
    with barcode-scanned product(s) attached (payload.attached_items). Text
    estimation is Task B (Groq, falling back to native Gemini as a last
    resort — see gemini_service.py's _task_b_chain) — it doesn't touch
    Gemini's vision quota (a separate pool — see Settings.gemini_text_models),
    and (unlike Task A above) has no proactive "at capacity" gate: there's
    no realistic "everything is exhausted" state left to guard against
    here."""
    description = payload.description.strip()
    attached = payload.attached_items

    if not description and not attached:
        raise HTTPException(
            status_code=422,
            detail="Describe what you ate, or attach at least one scanned product.",
        )

    # Attached item(s) with no text at all: nothing to estimate, so skip the
    # call entirely — deterministic sum, zero AI quota cost.
    if not description:
        return _sum_attached_items(attached)

    # Checked-and-spent atomically, only on this real-attempt path — never
    # for the deterministic attached-items-only path above, which never
    # touches an AI provider at all (see this module's own docstring on
    # services/ai_usage_service.py for why a non-attempt must never spend
    # quota).
    if not await ai_usage_service.try_consume(user.id, "scan_describe"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "scan_describe"))

    try:
        result = await estimate_from_description(
            description,
            attached_item_names=[item.food_name for item in attached],
            language=payload.language,
        )
    except InvalidFoodInputError:
        raise HTTPException(
            status_code=422,
            detail="Couldn't recognize a food in that description. Try rephrasing, or log it manually.",
        )
    except Exception:
        logger.exception("Unexpected error estimating from description")
        raise HTTPException(status_code=500, detail="Could not process that description right now. Please try again.")

    return _merge_attached_items(result, attached)
