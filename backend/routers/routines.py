import functools
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from auth import get_current_user
from database import get_supabase
from models import (
    RoutineCreate,
    RoutineResponse,
    RoutineUpdate,
    WeeklyPlanDayAssign,
    WeeklyPlanDayResponse,
)
from services.db_tolerance import UNDEFINED_TABLE_CODES

router = APIRouter(prefix="/routines", tags=["routines"])

_NOT_MIGRATED_DETAIL = (
    "The Weekly Plan Builder needs a one-time database update that hasn't been applied to this "
    "project yet. Ask your administrator to run the latest sql/schema.sql against Supabase."
)


def _503_if_not_migrated(fn):
    """Same "the feature IS the route, so fail loudly with a clear reason"
    shape as routers/workouts.py's identical decorator — workout_routines/
    weekly_plan_days are new tables a not-yet-migrated project simply
    doesn't have yet, unlike an existing table's new column."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except APIError as exc:
            if exc.code in UNDEFINED_TABLE_CODES:
                raise HTTPException(status_code=503, detail=_NOT_MIGRATED_DETAIL) from exc
            raise

    return wrapper


# Template data, not history — generous but bounded so the picker/management
# list in the Plan Builder never has to paginate.
MAX_ROUTINES = 100


@router.get("", response_model=list[RoutineResponse])
@_503_if_not_migrated
async def list_routines(user=Depends(get_current_user)):
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("workout_routines")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at")
        .limit(MAX_ROUTINES)
        .execute()
    )
    return result.data or []


@router.post("", response_model=RoutineResponse, status_code=201)
@_503_if_not_migrated
async def create_routine(payload: RoutineCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {
        "user_id": user.id,
        "name": payload.name.strip(),
        "exercises": [e.model_dump() for e in payload.exercises],
    }
    result = await run_in_threadpool(lambda: supabase.table("workout_routines").insert(row).execute())
    return result.data[0]


@router.patch("/{routine_id}", response_model=RoutineResponse)
@_503_if_not_migrated
async def update_routine(routine_id: str, payload: RoutineUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    updates: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if payload.name is not None:
        updates["name"] = payload.name.strip()
    if payload.exercises is not None:
        updates["exercises"] = [e.model_dump() for e in payload.exercises]

    result = await run_in_threadpool(
        lambda: supabase.table("workout_routines").update(updates).eq("id", routine_id).eq("user_id", user.id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Routine not found")
    return result.data[0]


@router.delete("/{routine_id}", status_code=204)
@_503_if_not_migrated
async def delete_routine(routine_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    # weekly_plan_days rows pointing at this routine cascade-delete via their
    # routine_id -> workout_routines.id foreign key (sql/schema.sql) —
    # deleting a routine simply clears whichever day(s) it was assigned to,
    # no separate cleanup pass needed here.
    await run_in_threadpool(
        lambda: supabase.table("workout_routines").delete().eq("id", routine_id).eq("user_id", user.id).execute()
    )
    return None


@router.get("/weekly-plan", response_model=list[WeeklyPlanDayResponse])
@_503_if_not_migrated
async def get_weekly_plan(user=Depends(get_current_user)):
    """Sparse — only the weekdays that actually have a routine assigned come
    back; a missing weekday is a rest day. Joined against workout_routines in
    Python rather than a PostgREST embedded-resource select, matching how
    routers/workouts.py already merges workout_sessions/workout_sets by hand."""
    supabase = get_supabase()
    days_result = await run_in_threadpool(
        lambda: supabase.table("weekly_plan_days").select("*").eq("user_id", user.id).execute()
    )
    days = days_result.data or []
    if not days:
        return []

    routine_ids = list({d["routine_id"] for d in days})
    routines_result = await run_in_threadpool(
        lambda: supabase.table("workout_routines").select("*").in_("id", routine_ids).execute()
    )
    routines_by_id = {r["id"]: r for r in routines_result.data or []}

    out = []
    for day in days:
        routine = routines_by_id.get(day["routine_id"])
        if not routine:
            continue  # deleted out from under this day; its own cascade-delete just hasn't landed as a read yet
        out.append(
            {
                "weekday": day["weekday"],
                "routine_id": routine["id"],
                "routine_name": routine["name"],
                "exercises": routine["exercises"],
            }
        )
    return out


@router.put("/weekly-plan/{weekday}", response_model=WeeklyPlanDayResponse)
@_503_if_not_migrated
async def assign_weekly_plan_day(weekday: int, payload: WeeklyPlanDayAssign, user=Depends(get_current_user)):
    if not 0 <= weekday <= 6:
        raise HTTPException(status_code=422, detail="weekday must be between 0 (Monday) and 6 (Sunday)")
    supabase = get_supabase()
    routine_result = await run_in_threadpool(
        lambda: supabase.table("workout_routines")
        .select("*")
        .eq("id", payload.routine_id)
        .eq("user_id", user.id)
        .maybe_single()
        .execute()
    )
    if routine_result is None or not routine_result.data:
        raise HTTPException(status_code=404, detail="Routine not found")
    routine = routine_result.data

    row = {"user_id": user.id, "weekday": weekday, "routine_id": payload.routine_id}
    # Upsert on (user_id, weekday): reassigning an already-planned day
    # overwrites it instead of erroring on the unique constraint.
    result = await run_in_threadpool(
        lambda: supabase.table("weekly_plan_days").upsert(row, on_conflict="user_id,weekday").execute()
    )
    saved = result.data[0]
    return {
        "weekday": saved["weekday"],
        "routine_id": routine["id"],
        "routine_name": routine["name"],
        "exercises": routine["exercises"],
    }


@router.delete("/weekly-plan/{weekday}", status_code=204)
@_503_if_not_migrated
async def clear_weekly_plan_day(weekday: int, user=Depends(get_current_user)):
    if not 0 <= weekday <= 6:
        raise HTTPException(status_code=422, detail="weekday must be between 0 (Monday) and 6 (Sunday)")
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("weekly_plan_days").delete().eq("user_id", user.id).eq("weekday", weekday).execute()
    )
    return None
