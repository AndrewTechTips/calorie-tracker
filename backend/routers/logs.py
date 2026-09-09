import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user, rate_limit_key
from config import get_settings
from database import get_supabase
from models import DailyLogCorrection, DailyLogCreate, DailyLogResponse
from rate_limit import limiter
from routers.day import get_day_context
from services import ai_usage_service, custom_food_service
from services.db_tolerance import write_tolerant
from services.gemini_service import InvalidFoodInputError, estimate_macros_for_food_name

logger = logging.getLogger("logs")

router = APIRouter(prefix="/logs", tags=["logs"])

# Hard ceiling on the food-rename re-estimate (Diagnostic F6). Sits under
# api.js::correctLog's own 25s client abort so the server always answers
# first — the frontend showing "the server is taking too long" while the
# backend keeps walking a provider chain, on a credit the user was already
# charged for, was the exact failure this bounds.
RENAME_ESTIMATE_TIMEOUT_SECONDS = 18.0


@router.get("", response_model=list[DailyLogResponse])
async def list_logs(
    days: int | None = Query(default=None, ge=1),
    user=Depends(get_current_user),
):
    """Returns logs from the retained window (last settings.retention_days).
    The frontend further filters this down to 'today' for the dashboard view.

    `days` lets a caller (e.g. the export feature) ask for a *smaller* slice
    of that same window — it's clamped to retention_days since nothing older
    than that is ever kept, so a bigger value couldn't return more anyway.
    """
    retention_days = get_settings().retention_days
    effective_days = min(days, retention_days) if days else retention_days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=effective_days)).isoformat()
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("daily_logs")
        .select("*")
        .eq("user_id", user.id)
        .gte("logged_at", cutoff)
        .order("logged_at", desc=True)
        .execute()
    )
    return result.data


@router.post("", response_model=DailyLogResponse, status_code=201)
async def create_log(payload: DailyLogCreate, user=Depends(get_current_user)):
    """Logs food for today, or — if payload.log_date is set — backdates it
    into a past day (the Daily History "edit a past day" flow). A future
    date, or one older than the retained window, is rejected outright; a
    same-day log is rejected if the user has already ended today (see
    routers/day.py::end_day) — that's the only case actually blocked, since
    backdating a *different* date is never affected by today's lock."""
    supabase = get_supabase()
    day = await get_day_context(supabase, user.id)
    retention_days = get_settings().retention_days
    target_date = payload.log_date or day["date"]
    if target_date > day["date"]:
        raise HTTPException(status_code=422, detail="Can't log a future date")
    if target_date < day["date"] - timedelta(days=retention_days - 1):
        raise HTTPException(status_code=422, detail=f"Can't log a date older than {retention_days} days ago")
    if target_date == day["date"] and day["ended"]:
        raise HTTPException(status_code=409, detail="Today has been ended — logging resumes at midnight")

    row = {
        **payload.model_dump(exclude={"log_date"}),
        "user_id": user.id,
        "log_date": target_date.isoformat(),
    }
    # fiber is a newer column (sql/schema.sql) — write_tolerant() drops it and
    # retries if this Supabase project hasn't had that migration run yet,
    # rather than every food log failing outright until it is.
    result = await write_tolerant(lambda data: supabase.table("daily_logs").insert(data).execute(), row)
    return result.data[0]


@router.patch("/{log_id}", response_model=DailyLogResponse)
# Burst clause alongside the sustained one for the same reason as
# routers/scan.py's decorators — a route-level limit here replaces (not adds
# to) rate_limit.py's app-wide burst default, and this route can trigger a
# Gemini call on a food-name change.
@limiter.limit("20/minute;6/10 seconds", key_func=rate_limit_key)
# `response: Response` is required by every @limiter.limit(...) route — see
# rate_limit.py's "SECOND gotcha" comment.
async def correct_log(request: Request, response: Response, log_id: str, payload: DailyLogCorrection, user=Depends(get_current_user)):
    """Edits an existing log entry.

    - Food-name change: a TEXT-ONLY AI call (Task B — Groq, falling back to
      native Gemini, see services/gemini_service.py's _task_b_chain) estimates fresh macros for
      the new food name at the (possibly also updated) weight. The original
      image is never re-sent, and any calories/protein/carbs/fats/fiber sent
      alongside the rename are ignored (they describe the old food, not the
      new one).
    - Otherwise: a plain direct edit. Whichever of weight_g/calories/protein/
      carbs/fats/fiber were provided are written as-is — no guessing. The
      frontend handles "just change the weight, scale everything else" by
      rescaling those fields itself before submitting, so by the time a
      request lands here it's always a complete, intentional set of values.
    """
    supabase = get_supabase()
    existing = await run_in_threadpool(
        lambda: supabase.table("daily_logs").select("*").eq("id", log_id).eq("user_id", user.id).maybe_single().execute()
    )
    # maybe_single() returns None outright (not .data=None) on no match —
    # covers a wrong/foreign log_id.
    if existing is None or not existing.data:
        raise HTTPException(status_code=404, detail="Log entry not found")

    current = existing.data
    new_weight = payload.weight_g or current["weight_g"]
    # Only the direct-edit branch below can set this; a rename re-estimates
    # from the AI/database chain rather than from anything the user measured,
    # so there is nothing of theirs to remember.
    custom_food_saved = False

    if payload.food_name and payload.food_name.strip() and payload.food_name.strip() != current["food_name"]:
        # Per-user daily cap on food-rename corrections (services/
        # ai_usage_service.py, feature "log_correction"). Gated on the
        # rename attempt itself, not on whether estimate_macros_for_food_name
        # ends up serving a food_cache_service hit underneath — that cache is
        # keyed by normalized food name, not by user, and this router has no
        # visibility into a hit/miss from here without reaching into that
        # service's internals. The limit is set generously high (30/day, see
        # config.py) specifically because most renames DO hit that cache in
        # practice, so this is a backstop against genuine abuse, not a tight
        # per-real-AI-call budget.
        if not await ai_usage_service.try_consume(user.id, "log_correction"):
            raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "log_correction"))
        try:
            # Bounded, like every other AI entry point (Diagnostic F6). This
            # path reaches gemini_service's full Task B chain — Mistral's
            # models, then Groq's, then native Gemini — and each candidate
            # carries its own 15s read timeout, so an unbounded walk could
            # run past two minutes while the frontend gave up at 25s
            # (api.js::correctLog). 18s leaves the client real headroom and
            # still lets a healthy first candidate (~1-3s) answer easily.
            recalculated = await asyncio.wait_for(
                estimate_macros_for_food_name(
                    payload.food_name.strip(),
                    new_weight,
                    # Checks this user's own saved figures before USDA/Open
                    # Food Facts or the model — renaming to a food they have
                    # already corrected once reuses their label, not a guess.
                    user_id=user.id,
                ),
                timeout=RENAME_ESTIMATE_TIMEOUT_SECONDS,
            )
        except InvalidFoodInputError:
            # A real, billed provider answer — negative, but an answer. Keep
            # charging for it (see ai_usage_service.refund's docstring).
            raise HTTPException(status_code=422, detail="That doesn't look like a recognizable food name")
        except Exception:
            # Every non-answer: the deadline above expiring, a provider 5xx,
            # the whole chain exhausted. try_consume() already spent the
            # unit, so give it back before surfacing the error.
            logger.exception("Food-name re-estimate failed for log %s", log_id)
            await ai_usage_service.refund(user.id, "log_correction")
            raise HTTPException(
                status_code=503,
                detail="Couldn't recalculate macros for that name right now. Please try again.",
            )
        update = {
            "food_name": recalculated["food_name"],
            "weight_g": recalculated["weight_g"],
            "calories": recalculated["calories"],
            "protein": recalculated["protein"],
            "carbs": recalculated["carbs"],
            "fats": recalculated["fats"],
            "fiber": recalculated["fiber"],
            "sugar": recalculated["sugar"],
            "sodium": recalculated["sodium"],
            "source": "manual",
            # A rename is a full identity swap to a different food — any
            # prior per-ingredient breakdown described the OLD food, so it's
            # cleared rather than left mismatched with the new totals. The
            # text-only re-estimate call only ever returns one implicit
            # ingredient anyway (see estimate_macros_for_food_name).
            "ingredients": None,
        }
    else:
        update = {"weight_g": new_weight, "source": "manual"}
        for field in ("calories", "protein", "carbs", "fats", "fiber", "sugar", "sodium"):
            value = getattr(payload, field)
            update[field] = value if value is not None else current.get(field, 0)
        if payload.ingredients is not None:
            update["ingredients"] = [item.model_dump() for item in payload.ingredients]

        # ------------------------------------------------------------------
        # Remember what the user just told us (Diagnostic F8).
        #
        # This is the single most authoritative nutrition input the app ever
        # receives — a person reading the label of the product in their hand —
        # and until now it was written onto this ONE log row and discarded.
        # The same branded product was re-estimated from scratch tomorrow and
        # got the same wrong number, forever. Saving it per-100g means one
        # correction prices every future portion of any size.
        #
        # Gated on the user having actually SENT macro values: a pure weight
        # edit or a workout retag also lands in this branch (the fields are
        # backfilled from `current` above), and persisting a reference value
        # off the back of a retag would silently promote an old AI estimate to
        # "the user's own figure". `explicitly_corrected` is what tells the
        # two apart. Best-effort — save_from_portion never raises, so a
        # storage problem can never turn a successful edit into an error.
        # ------------------------------------------------------------------
        explicitly_corrected = any(
            getattr(payload, field) is not None
            for field in ("calories", "protein", "carbs", "fats")
        )
        if explicitly_corrected:
            custom_food_saved = await custom_food_service.save_from_portion(
                user.id,
                current["food_name"],
                new_weight,
                {
                    "calories_per_100g": update["calories"],
                    "protein_per_100g": update["protein"],
                    "carbs_per_100g": update["carbs"],
                    "fats_per_100g": update["fats"],
                    "fiber_per_100g": update["fiber"],
                    "sugar_per_100g": update["sugar"],
                    "sodium_per_100g": update["sodium"],
                },
            )

    # workout_tag is independent of the food-name-change branch above (a
    # retag never re-triggers a macro re-estimate) — applied to either branch
    # uniformly, only when the caller actually sent one.
    if payload.workout_tag is not None:
        update["workout_tag"] = payload.workout_tag

    # fiber/sugar/sodium/workout_tag are newer columns (sql/schema.sql) —
    # write_tolerant() drops whichever isn't migrated yet and retries.
    result = await write_tolerant(
        lambda data: supabase.table("daily_logs").update(data).eq("id", log_id).eq("user_id", user.id).execute(), update
    )
    # custom_food_saved is a response-only signal, not a stored column — the
    # frontend uses it to confirm "we'll remember this next time" rather than
    # re-deriving save_from_portion's own rules client-side (see
    # DailyLogResponse's own comment).
    return {**result.data[0], "custom_food_saved": custom_food_saved}


@router.delete("/{log_id}", status_code=204)
async def delete_log(log_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("daily_logs").delete().eq("id", log_id).eq("user_id", user.id).execute()
    )
    return None
