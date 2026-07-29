from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import WorkoutLogCreate, WorkoutLogResponse, WorkoutLogUpdate

router = APIRouter(prefix="/workouts", tags=["workouts"])

# Unlike weight_logs/body_measurements (typically ~1 entry/day), a single gym
# session can produce several workout_logs rows at once (one per exercise),
# so this can accumulate meaningfully faster over a long-term user's history.
# Capped rather than truly unbounded like its siblings, to keep this
# endpoint's payload (and the Supabase read behind it) bounded regardless of
# how long someone's been using the app — 500 rows is generous headroom for
# the list/filter UI and the PDF export (both show recent history, not a
# multi-year archive) while still protecting against runaway growth.
MAX_WORKOUT_ROWS = 500


@router.get("", response_model=list[WorkoutLogResponse])
async def list_workouts(user=Depends(get_current_user)):
    """Kept indefinitely (see sql/schema.sql) — no retention window to clamp
    against, but capped at MAX_WORKOUT_ROWS (see above). No per-exercise
    filter param: a user's own training history is small enough that the
    frontend fetches everything once and groups/filters it client-side, same
    pattern as /measurements."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("workout_logs")
        .select("*")
        .eq("user_id", user.id)
        .order("logged_at", desc=True)
        .limit(MAX_WORKOUT_ROWS)
        .execute()
    )
    return result.data


@router.post("", response_model=WorkoutLogResponse, status_code=201)
async def add_workout(payload: WorkoutLogCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {
        "user_id": user.id,
        "exercise_name": payload.exercise_name.strip(),
        "sets": payload.sets,
        "reps": payload.reps,
        "weight_kg": payload.weight_kg,
    }
    # logged_at is user-specified (the whole point of this feature — see
    # models.py) rather than always "now"; only set it when provided so the
    # column's own `default now()` covers the omitted case.
    if payload.logged_at is not None:
        row["logged_at"] = payload.logged_at.isoformat()
    result = await run_in_threadpool(lambda: supabase.table("workout_logs").insert(row).execute())
    return result.data[0]


@router.patch("/{entry_id}", response_model=WorkoutLogResponse)
async def update_workout(entry_id: str, payload: WorkoutLogUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    updates = {}
    if payload.exercise_name is not None:
        updates["exercise_name"] = payload.exercise_name.strip()
    if payload.sets is not None:
        updates["sets"] = payload.sets
    if payload.reps is not None:
        updates["reps"] = payload.reps
    if payload.weight_kg is not None:
        updates["weight_kg"] = payload.weight_kg
    if payload.logged_at is not None:
        updates["logged_at"] = payload.logged_at.isoformat()

    result = await run_in_threadpool(
        lambda: supabase.table("workout_logs").update(updates).eq("id", entry_id).eq("user_id", user.id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Workout entry not found")
    return result.data[0]


@router.delete("/{entry_id}", status_code=204)
async def delete_workout(entry_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("workout_logs").delete().eq("id", entry_id).eq("user_id", user.id).execute()
    )
    return None
