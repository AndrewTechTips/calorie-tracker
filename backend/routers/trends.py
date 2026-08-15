import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import TrendsResponse
from routers.day import get_day_context
from services.db_tolerance import read_tolerant
from services.trends_service import compute_trends

router = APIRouter(prefix="/trends", tags=["trends"])


@router.get("", response_model=TrendsResponse)
async def get_trends(user=Depends(get_current_user)):
    """Aggregates the retained window (daily_logs/water_logs,
    settings.retention_days) into one row per calendar date (in the user's
    own timezone — see routers/day.py), plus the current adherence streak.
    Deliberately computed at read time from the same rows the dashboard
    already stores — no separate summary table, so this adds zero extra
    storage (see sql/schema.sql / the retention decision). The actual
    aggregation math lives in services/trends_service.py so it can be
    unit-tested without a Supabase connection."""
    settings = get_settings()
    retention_days = settings.retention_days
    supabase = get_supabase()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()

    # These reads are independent of each other, so run them concurrently
    # (each still off the event loop via run_in_threadpool, since supabase-py's
    # client is synchronous) instead of sequential round-trips to Supabase —
    # this is the single most request-heavy endpoint in the app.
    day, profile, logs, water, weight, workouts = await asyncio.gather(
        get_day_context(supabase, user.id),
        run_in_threadpool(
            lambda: supabase.table("profiles").select("daily_calories").eq("id", user.id).maybe_single().execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("daily_logs")
            .select("calories,protein,carbs,fats,logged_at,log_date")
            .eq("user_id", user.id)
            .gte("logged_at", cutoff)
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("water_logs")
            .select("amount_ml,logged_at,log_date")
            .eq("user_id", user.id)
            .gte("logged_at", cutoff)
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("weight_logs")
            .select("weight_kg,logged_at")
            .eq("user_id", user.id)
            .gte("logged_at", cutoff)
            .execute()
        ),
        # workout_sessions is kept indefinitely (not part of the retention
        # window like daily_logs/water_logs above — see sql/schema.sql), but
        # narrowed to the same cutoff here anyway since DayTrend only ever
        # renders `retention_days` worth of dates regardless. read_tolerant
        # (not a bare run_in_threadpool like the others) because this route
        # predates the Workout Diary and must keep working for any project
        # that hasn't yet pasted the new workout_sessions/workout_sets tables
        # from sql/schema.sql into Supabase — see db_tolerance.py.
        read_tolerant(
            lambda: supabase.table("workout_sessions")
            .select("session_date,calories_burned")
            .eq("user_id", user.id)
            .gte("session_date", cutoff[:10])
            .execute()
        ),
    )
    # maybe_single() returns None outright (not .data=None) on no match.
    target_calories = ((profile.data if profile else None) or {}).get("daily_calories") or 2200

    return compute_trends(
        logs.data or [],
        water.data or [],
        weight.data or [],
        workouts.data or [],
        retention_days=retention_days,
        target_calories=target_calories,
        today=day["date"],
        timezone_name=day["timezone"],
    )
