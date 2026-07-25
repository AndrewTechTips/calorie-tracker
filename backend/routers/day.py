from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import DayStateResponse
from services.day_service import compute_effective_day_state

router = APIRouter(prefix="/day", tags=["day"])


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def sync_day_state(supabase, user_id: str) -> dict:
    """Reads the profile's stored day state, lazily advances it if a real
    midnight has passed since it was last touched, persists that if so, and
    returns the up-to-date {day_number, day_boundary}. Shared with
    routers/water.py so /water/today applies the exact same cutoff."""
    profile = await run_in_threadpool(
        lambda: supabase.table("profiles")
        .select("current_day_number,day_boundary")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    data = profile.data or {}
    stored_number = data.get("current_day_number") or 1
    stored_boundary = (
        _parse_timestamp(data["day_boundary"]) if data.get("day_boundary") else datetime.now(timezone.utc)
    )

    day_number, boundary, changed = compute_effective_day_state(stored_number, stored_boundary)
    if changed:
        await run_in_threadpool(
            lambda: supabase.table("profiles")
            .update({"current_day_number": day_number, "day_boundary": boundary.isoformat()})
            .eq("id", user_id)
            .execute()
        )

    return {"day_number": day_number, "day_boundary": boundary}


@router.get("", response_model=DayStateResponse)
async def get_day_state(user=Depends(get_current_user)):
    """The current 'Day N' and the cutoff that defines 'today' for this
    user — the frontend uses this to filter today's logs client-side with
    the same cutoff /water/today applies server-side."""
    return await sync_day_state(get_supabase(), user.id)


@router.post("/end", response_model=DayStateResponse)
async def end_day(user=Depends(get_current_user)):
    """Manually closes out the current day: bumps the day counter and moves
    the 'today' cutoff to this exact moment. Nothing is deleted — every log
    made today is still stored and still counted correctly by trends/streak
    (which key off each entry's own calendar date, not this cutoff); this
    only changes what the *live* dashboard shows as 'today' from now on, so
    it reads as a fresh Day N+1 immediately instead of waiting for midnight.
    """
    supabase = get_supabase()
    current = await sync_day_state(supabase, user.id)
    new_number = current["day_number"] + 1
    now = datetime.now(timezone.utc)
    await run_in_threadpool(
        lambda: supabase.table("profiles")
        .update({"current_day_number": new_number, "day_boundary": now.isoformat()})
        .eq("id", user.id)
        .execute()
    )
    return {"day_number": new_number, "day_boundary": now}
