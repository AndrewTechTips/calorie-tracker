from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import DailyLogResponse, SavedMealCreate, SavedMealResponse
from routers.day import sync_day_state
from services.db_tolerance import write_tolerant

router = APIRouter(prefix="/meals", tags=["saved meals"])


@router.get("", response_model=list[SavedMealResponse])
async def list_saved_meals(user=Depends(get_current_user)):
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("saved_meals").select("*").eq("user_id", user.id).order("created_at", desc=True).execute()
    )
    return result.data


@router.post("", response_model=SavedMealResponse, status_code=201)
async def save_meal(payload: SavedMealCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {**payload.model_dump(), "user_id": user.id}
    # fiber is a newer column (sql/schema.sql) — write_tolerant() drops it and
    # retries if this Supabase project hasn't had that migration run yet.
    result = await write_tolerant(lambda data: supabase.table("saved_meals").insert(data).execute(), row)
    return result.data[0]


@router.post("/{meal_id}/log", response_model=DailyLogResponse, status_code=201)
async def log_saved_meal(meal_id: str, user=Depends(get_current_user)):
    """Instantly writes a saved meal into today's daily_logs. No AI call at all —
    this is the 'fast logging' path."""
    supabase = get_supabase()
    meal = await run_in_threadpool(
        lambda: supabase.table("saved_meals").select("*").eq("id", meal_id).eq("user_id", user.id).maybe_single().execute()
    )
    if not meal.data:
        raise HTTPException(status_code=404, detail="Saved meal not found")

    day_state = await sync_day_state(supabase, user.id)
    m = meal.data
    row = {
        "user_id": user.id,
        "food_name": m["name"],
        "weight_g": m["weight_g"],
        "calories": m["calories"],
        "protein": m["protein"],
        "carbs": m["carbs"],
        "fats": m["fats"],
        "fiber": m.get("fiber", 0),
        "source": "saved_meal",
        "day_number": day_state["day_number"],
    }
    result = await write_tolerant(lambda data: supabase.table("daily_logs").insert(data).execute(), row)
    return result.data[0]


@router.delete("/{meal_id}", status_code=204)
async def delete_saved_meal(meal_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("saved_meals").delete().eq("id", meal_id).eq("user_id", user.id).execute()
    )
    return None
