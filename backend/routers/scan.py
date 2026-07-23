import logging
from io import BytesIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from PIL import Image

from auth import get_current_user
from models import ScanResult, UsageStatus
from rate_limit import limiter
from services import quota_service
from services.gemini_service import InvalidFoodInputError, analyze_food_image

logger = logging.getLogger("scan")

router = APIRouter(prefix="/scan", tags=["scan"])

ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic"}
# Stock Pillow (no extra codec plugin) can't decode HEIC, so we only run a real
# pixel-level verification on the formats it actually supports. HEIC is still
# gated by content-type + size above, same as before — not weaker than it was.
PIL_VERIFIABLE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB
MAX_CONTEXT_CHARS = 1000


@router.get("/usage", response_model=UsageStatus)
async def get_scan_usage(user=Depends(get_current_user)):
    """Shared (not per-user) daily Gemini call count vs. the soft cap this
    backend enforces — see services/quota_service.py. Every signed-in user
    sees the same numbers, by design (there's one shared free-tier API key
    behind all of them)."""
    return quota_service.get_usage()


@router.post("", response_model=ScanResult)
@limiter.limit("10/minute")
async def scan_food(
    request: Request,
    image: UploadFile = File(...),
    context_text: str = Form(default="", max_length=MAX_CONTEXT_CHARS),
    user=Depends(get_current_user),
):
    # Checked before touching the image at all: if the shared quota is
    # already spent, there's no point making the user upload/wait first.
    if not quota_service.has_capacity():
        raise HTTPException(
            status_code=503,
            detail="AI scanning is at capacity for today — try again tomorrow, or log this meal manually.",
        )

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

    # context_text is free user input — it is treated as untrusted data inside
    # gemini_service, never concatenated into the system prompt itself.
    try:
        result = await analyze_food_image(image_bytes, image.content_type, context_text)
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

    return result
