from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ..database import get_supabase
from ..models import DailyLogCorrection, DailyLogCreate, DailyLogResponse
from ..services.gemini_service import InvalidFoodInputError, estimate_macros_for_food_name

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
async def correct_log(log_id: str, payload: DailyLogCorrection, user=Depends(get_current_user)):
    """Manual correction of an AI-scanned (or any) log entry.

    - Weight-only change: macros are rescaled locally from the existing
      per-gram ratios. No AI call at all.
    - Food-name change: a TEXT-ONLY Gemini call estimates fresh per-100g
      macros for the new food name, then scales to the (possibly also
      updated) weight. The original image is never re-sent.
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
        # Weight-only edit: rescale existing macros proportionally, no AI call.
        ratio = new_weight / current["weight_g"] if current["weight_g"] else 1
        update = {
            "weight_g": new_weight,
            "calories": round(current["calories"] * ratio, 1),
            "protein": round(current["protein"] * ratio, 1),
            "carbs": round(current["carbs"] * ratio, 1),
            "fats": round(current["fats"] * ratio, 1),
            "source": "manual",
        }

    result = supabase.table("daily_logs").update(update).eq("id", log_id).eq("user_id", user.id).execute()
    return result.data[0]


@router.delete("/{log_id}", status_code=204)
async def delete_log(log_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    supabase.table("daily_logs").delete().eq("id", log_id).eq("user_id", user.id).execute()
    return None
