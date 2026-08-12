from datetime import date
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import DayStateResponse, TimezoneUpdate
from services.daytime_service import is_day_ended, local_today

router = APIRouter(prefix="/day", tags=["day"])


async def get_day_context(supabase, user_id: str) -> dict:
    """Read-only: today's local date, the user's timezone, and whether today
    has been manually ended. Nothing here is ever lazily advanced or
    persisted — "today" is now a pure function of wall-clock time plus the
    stored timezone, so there's no counter/boundary to keep in sync (unlike
    the old day_number/day_boundary model this replaces). Shared with
    routers/logs.py, water.py, meals.py, trends.py."""
    profile = await run_in_threadpool(
        lambda: supabase.table("profiles")
        .select("timezone,day_ended_date")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    # maybe_single().execute() returns None outright (not an object with
    # .data = None) when zero rows match — must guard before touching .data.
    data = (profile.data if profile else None) or {}
    tz_name = data.get("timezone") or "UTC"
    today = local_today(tz_name)
    ended_date = date.fromisoformat(data["day_ended_date"]) if data.get("day_ended_date") else None
    return {"date": today, "timezone": tz_name, "ended": is_day_ended(ended_date, today)}


@router.get("", response_model=DayStateResponse)
async def get_day_state(user=Depends(get_current_user)):
    """Today's local date and whether it's been manually ended — the
    frontend filters today's logs by `log_date == this date` and shows the
    locked-day banner when `ended` is true."""
    context = await get_day_context(get_supabase(), user.id)
    return {"date": context["date"].isoformat(), "ended": context["ended"]}


@router.post("/end", response_model=DayStateResponse)
async def end_day(user=Depends(get_current_user)):
    """Manually ends today: no new logging is allowed for today's date until
    real local midnight passes and a new date naturally begins. Nothing is
    deleted or reset — every log made today stays visible on the dashboard,
    and editing/deleting an existing entry is still allowed (routers/logs.py
    never checks this flag) — only *new* logs/water for today are blocked
    (see the 409 checks in logs.py/water.py/meals.py)."""
    supabase = get_supabase()
    context = await get_day_context(supabase, user.id)
    await run_in_threadpool(
        lambda: supabase.table("profiles")
        .update({"day_ended_date": context["date"].isoformat()})
        .eq("id", user.id)
        .execute()
    )
    return {"date": context["date"].isoformat(), "ended": True}


@router.post("/reopen", response_model=DayStateResponse)
async def reopen_day(user=Depends(get_current_user)):
    """Undoes end_day: clears day_ended_date so today's logging unlocks again
    immediately, no confirmation required (unlike end_day, which is a
    destructive-feeling forward action gated behind its own summary sheet on
    the frontend — reopening is trivially reversible by ending again, so it
    doesn't need the same friction). Only ever clears *today's* lock: if
    day_ended_date is from a previous day already (real midnight passed since
    it was set), this still safely no-ops it to null rather than leaving a
    stale past date around."""
    supabase = get_supabase()
    context = await get_day_context(supabase, user.id)
    await run_in_threadpool(
        lambda: supabase.table("profiles").update({"day_ended_date": None}).eq("id", user.id).execute()
    )
    return {"date": context["date"].isoformat(), "ended": False}


@router.put("/timezone", response_model=DayStateResponse)
async def update_timezone(payload: TimezoneUpdate, user=Depends(get_current_user)):
    """The frontend calls this once per session, only when the browser's
    detected timezone (Intl.DateTimeFormat().resolvedOptions().timeZone)
    differs from what's already stored. Validated against the real IANA
    database before being stored — an invalid string here would otherwise
    silently degrade every later "today" computation for this user to
    daytime_service's UTC fallback."""
    if payload.timezone not in available_timezones():
        raise HTTPException(status_code=422, detail="Not a recognized IANA timezone name")
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("profiles").update({"timezone": payload.timezone}).eq("id", user.id).execute()
    )
    context = await get_day_context(supabase, user.id)
    return {"date": context["date"].isoformat(), "ended": context["ended"]}
