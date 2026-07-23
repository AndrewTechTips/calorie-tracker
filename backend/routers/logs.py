from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user
from database import get_supabase
from models import DailyLogCorrection, DailyLogCreate, DailyLogResponse
from rate_limit import limiter
from services.gemini_service import InvalidFoodInputError, estimate_macros_for_food_name

router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("", response_model=list[DailyLogResponse])
async def list_logs(user=Depends(get_current_user)):
    """Returns logs from the retained window (last 3 days). The frontend further
    filters this down to 'today' for the dashboard view."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    supabase = get_supabase()
    result = (
        supabase.table("daily_logs")
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
    row = {**payload.model_dump(), "user_id": user.id}
    result = supabase.table("daily_logs").insert(row).execute()
    return result.data[0]


@router.patch("/{log_id}", response_model=DailyLogResponse)
@limiter.limit("20/minute")
async def correct_log(request: Request, log_id: str, payload: DailyLogCorrection, user=Depends(get_current_user)):
    """Edits an existing log entry.

    - Food-name change: a TEXT-ONLY Gemini call estimates fresh macros for the
      new food name at the (possibly also updated) weight. The original image
      is never re-sent, and any calories/protein/carbs/fats sent alongside the
      rename are ignored (they describe the old food, not the new one).
    - Otherwise: a plain direct edit. Whichever of weight_g/calories/protein/
      carbs/fats were provided are written as-is — no guessing. The frontend
      handles "just change the weight, scale everything else" by rescaling
      those fields itself before submitting, so by the time a request lands
      here it's always a complete, intentional set of values.
    """
    supabase = get_supabase()
    existing = (
        supabase.table("daily_logs").select("*").eq("id", log_id).eq("user_id", user.id).maybe_single().execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="Log entry not found")

    current = existing.data
    new_weight = payload.weight_g or current["weight_g"]

    if payload.food_name and payload.food_name.strip() and payload.food_name.strip() != current["food_name"]:
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
            "source": "manual",
        }
    else:
        update = {"weight_g": new_weight, "source": "manual"}
        for field in ("calories", "protein", "carbs", "fats"):
            value = getattr(payload, field)
            update[field] = value if value is not None else current[field]

    result = supabase.table("daily_logs").update(update).eq("id", log_id).eq("user_id", user.id).execute()
    return result.data[0]


@router.delete("/{log_id}", status_code=204)
async def delete_log(log_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    supabase.table("daily_logs").delete().eq("id", log_id).eq("user_id", user.id).execute()
    return None
