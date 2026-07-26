from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import DailyLogCorrection, DailyLogCreate, DailyLogResponse
from rate_limit import limiter
from routers.day import sync_day_state
from services import quota_service
from services.db_tolerance import write_tolerant
from services.gemini_service import InvalidFoodInputError, estimate_macros_for_food_name

router = APIRouter(prefix="/logs", tags=["logs"])


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
    supabase = get_supabase()
    day_state = await sync_day_state(supabase, user.id)
    row = {**payload.model_dump(), "user_id": user.id, "day_number": day_state["day_number"]}
    # fiber is a newer column (sql/schema.sql) — write_tolerant() drops it and
    # retries if this Supabase project hasn't had that migration run yet,
    # rather than every food log failing outright until it is.
    result = await write_tolerant(lambda data: supabase.table("daily_logs").insert(data).execute(), row)
    return result.data[0]


@router.patch("/{log_id}", response_model=DailyLogResponse)
@limiter.limit("20/minute")
async def correct_log(request: Request, log_id: str, payload: DailyLogCorrection, user=Depends(get_current_user)):
    """Edits an existing log entry.

    - Food-name change: a TEXT-ONLY Gemini call estimates fresh macros for the
      new food name at the (possibly also updated) weight. The original image
      is never re-sent, and any calories/protein/carbs/fats/fiber sent
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
    if not existing.data:
        raise HTTPException(status_code=404, detail="Log entry not found")

    current = existing.data
    new_weight = payload.weight_g or current["weight_g"]

    if payload.food_name and payload.food_name.strip() and payload.food_name.strip() != current["food_name"]:
        if not quota_service.has_capacity():
            raise HTTPException(
                status_code=503,
                detail="AI re-estimation is at capacity for today — try again tomorrow, or edit the numbers directly.",
            )
        try:
            recalculated = await estimate_macros_for_food_name(payload.food_name.strip(), new_weight)
        except InvalidFoodInputError:
            raise HTTPException(status_code=422, detail="That doesn't look like a recognizable food name")
        update = {
            "food_name": recalculated["food_name"],
            "weight_g": recalculated["weight_g"],
            "calories": recalculated["calories"],
            "protein": recalculated["protein"],
            "carbs": recalculated["carbs"],
            "fats": recalculated["fats"],
            "fiber": recalculated["fiber"],
            "source": "manual",
        }
    else:
        update = {"weight_g": new_weight, "source": "manual"}
        for field in ("calories", "protein", "carbs", "fats", "fiber"):
            value = getattr(payload, field)
            update[field] = value if value is not None else current.get(field, 0)

    # fiber is a newer column (sql/schema.sql) — write_tolerant() drops it and
    # retries if this Supabase project hasn't had that migration run yet.
    result = await write_tolerant(
        lambda data: supabase.table("daily_logs").update(data).eq("id", log_id).eq("user_id", user.id).execute(), update
    )
    return result.data[0]


@router.delete("/{log_id}", status_code=204)
async def delete_log(log_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("daily_logs").delete().eq("id", log_id).eq("user_id", user.id).execute()
    )
    return None
