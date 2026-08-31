from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from auth import get_current_user, rate_limit_key
from database import get_supabase
from models import AccountActionConfirm
from rate_limit import limiter
from services.db_tolerance import UNDEFINED_TABLE_CODES

router = APIRouter(prefix="/account", tags=["account"])

# "Logged history" tables only — the ones a user would recognize as "my
# activity", not "my account". Deliberately excludes saved_meals (reusable
# templates/favorites, not a log of past events) and profiles itself (targets,
# display_name, avatar_url, timezone — account configuration, not history).
# weight_logs/body_measurements/workout_logs/workout_sessions are normally
# kept indefinitely (never touched by the retention cleanup job, see
# cleanup_service.py) — a user-initiated "start fresh" is the one deliberate
# exception to that. workout_sets isn't listed separately: it has its own
# `on delete cascade` from session_id -> workout_sessions.id (sql/schema.sql),
# so deleting a user's sessions here removes their sets as a side effect.
RESET_TABLES = ("daily_logs", "water_logs", "weight_logs", "body_measurements", "workout_logs", "workout_sessions")


@router.post("/reset", status_code=204)
@limiter.limit("3/minute;1/10 seconds", key_func=rate_limit_key)
async def reset_progress(request: Request, response: Response, payload: AccountActionConfirm, user=Depends(get_current_user)):
    """Wipes every row of the user's own logged history (see RESET_TABLES)
    while leaving their account, targets, and saved meals/products untouched
    — the account keeps existing, it just looks brand new. `payload.confirm`
    must be explicitly true (see AccountActionConfirm's own docstring)."""
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="Confirmation required")

    supabase = get_supabase()
    for table in RESET_TABLES:
        await run_in_threadpool(lambda t=table: supabase.table(t).delete().eq("user_id", user.id).execute())
    # Clears any "today already ended" lock left over from the now-wiped
    # history — without this, a user who just reset everything would still
    # be blocked from logging today until real local midnight (see
    # routers/day.py::end_day), which would read as the reset having failed.
    await run_in_threadpool(
        lambda: supabase.table("profiles").update({"day_ended_date": None}).eq("id", user.id).execute()
    )
    # Not in RESET_TABLES above (that list is the blind-delete history
    # tables) since pet_state is lazily recreated at hearts=3 on next
    # GET /pet/state rather than needing an explicit re-insert here — a
    # delete alone is enough to give Ollie a fresh start alongside the
    # wiped logs pet_scheduler.py judges him against.
    await run_in_threadpool(lambda: supabase.table("pet_state").delete().eq("user_id", user.id).execute())
    # Same reasoning for the Phase 3 weekly-challenge state (progress + any
    # banked completions/badges): a "start fresh" reset clears it too, and
    # pet_scheduler.py's sweep lazily recreates this week's row on its next
    # pass. Wrapped tolerantly so a project without the Phase 3 migration
    # doesn't fail the whole reset.
    try:
        await run_in_threadpool(
            lambda: supabase.table("discover_challenges").delete().eq("user_id", user.id).execute()
        )
    except APIError as exc:
        if exc.code not in UNDEFINED_TABLE_CODES:
            raise
    return None


@router.delete("", status_code=204)
@limiter.limit("3/minute;1/10 seconds", key_func=rate_limit_key)
async def delete_account(request: Request, response: Response, payload: AccountActionConfirm, user=Depends(get_current_user)):
    """Full account teardown. Deletes the auth.users row itself via the
    Supabase Admin API — reachable through get_supabase() because that
    client is already constructed with the service-role (secret) key, which
    is what the Admin API requires (see database.py's get_supabase()
    docstring). Every public.* table this user ever wrote to (profiles,
    daily_logs, saved_meals, water_logs, weight_logs, body_measurements,
    workout_logs, workout_sessions, workout_sets) declares
    `references auth.users(id) on delete cascade` in sql/schema.sql, so
    Postgres removes every row for this user as an
    automatic side effect of this single call — there is no separate manual
    delete-each-table pass here, deliberately: doing that first would open a
    window where a failure partway through (or a failure on this final call
    itself) leaves an account that still exists but has already lost some or
    all of its data, which is a strictly worse state than either "fully
    intact" or "fully gone". This call is atomic from the caller's
    perspective — it either fully succeeds or changes nothing.
    """
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="Confirmation required")

    supabase = get_supabase()
    # should_soft_delete=False is already the library default — passed
    # explicitly so "permanently deletes... can't be undone" (the promise
    # made in the frontend's confirmation sheet) stays true even if a future
    # supabase-py/gotrue version ever changes that default.
    await run_in_threadpool(lambda: supabase.auth.admin.delete_user(user.id, should_soft_delete=False))
    return None
