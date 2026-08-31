from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import DailyLogResponse, SavedMealCreate, SavedMealLogRequest, SavedMealResponse
from routers.day import get_day_context
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
async def log_saved_meal(
    meal_id: str,
    payload: SavedMealLogRequest | None = None,
    user=Depends(get_current_user),
):
    """Instantly writes a saved meal into today's daily_logs. No AI call at all —
    this is the 'fast logging' path.

    The optional body is Phase 2's "closing the loop" hook: the Discover
    recipe-log path (frontend/js/discover.js) sends
    {"discover_recipe_id": "<recipe id>"} so the resulting row is tagged as
    a Discover "cook" for GET /discover/activity. Every other caller (the
    Saved Meals quick-log button, offline write replay) sends no body and
    the row's discover_recipe_id stays null."""
    supabase = get_supabase()
    meal = await run_in_threadpool(
        lambda: supabase.table("saved_meals").select("*").eq("id", meal_id).eq("user_id", user.id).maybe_single().execute()
    )
    # maybe_single() returns None outright (not .data=None) on no match —
    # covers a wrong/foreign meal_id.
    if meal is None or not meal.data:
        raise HTTPException(status_code=404, detail="Saved meal not found")

    day = await get_day_context(supabase, user.id)
    if day["ended"]:
        raise HTTPException(status_code=409, detail="Today has been ended — logging resumes at midnight")

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
        "sugar": m.get("sugar", 0),
        "sodium": m.get("sodium", 0),
        "source": "saved_meal",
        "log_date": day["date"].isoformat(),
        # Carries the saved meal's own breakdown (if any) into the new log
        # row, so instant-logging a favorite doesn't lose its ingredients.
        "ingredients": m.get("ingredients"),
        # None for every non-Discover caller. write_tolerant() drops this key
        # and retries on a project that hasn't run the discover_recipe_id
        # migration yet (sql/schema.sql), same as fiber/sugar/sodium.
        "discover_recipe_id": payload.discover_recipe_id if payload else None,
    }
    result = await write_tolerant(lambda data: supabase.table("daily_logs").insert(data).execute(), row)
    return result.data[0]


@router.put("/{meal_id}", response_model=SavedMealResponse)
async def update_saved_meal(meal_id: str, payload: SavedMealCreate, user=Depends(get_current_user)):
    """Full replace of an existing saved meal's fields — the 'edit' action on
    a saved meal card (frontend/js/app.js), so a weight/macro snapshot saved
    before fiber was tracked (or just entered wrong) can be corrected the
    same way a daily log entry already could. The frontend recomputes the
    proportional macro/fiber rescale itself before submitting (same
    nutritionMath.js helpers PATCH /logs/{id}'s editor uses) — this endpoint
    just persists whatever it's given, no guessing."""
    supabase = get_supabase()
    row = payload.model_dump()
    result = await write_tolerant(
        lambda data: supabase.table("saved_meals").update(data).eq("id", meal_id).eq("user_id", user.id).execute(), row
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Saved meal not found")
    return result.data[0]


@router.delete("/{meal_id}", status_code=204)
async def delete_saved_meal(meal_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("saved_meals").delete().eq("id", meal_id).eq("user_id", user.id).execute()
    )
    return None
