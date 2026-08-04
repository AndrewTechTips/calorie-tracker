import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user, rate_limit_key
from config import get_settings
from database import get_supabase
from models import WeeklyRecapResponse
from rate_limit import limiter
from routers.day import get_day_context
from services import coach_cache_service, quota_service
from services.gemini_service import generate_weekly_recap
from services.trends_service import compute_trends

logger = logging.getLogger("coach")

router = APIRouter(prefix="/coach", tags=["coach"])


@router.get("/weekly-recap", response_model=WeeklyRecapResponse)
# Same burst-clause reasoning as scan.py's routes — this one spends shared
# Gemini quota on a cache miss. Generous ceiling (this is a once-a-week
# action per user, gated further by coach_cache_service's own TTL) rather
# than scan's tighter limit, since the cache already absorbs any real repeat
# traffic — the rate limit here is just a backstop, not the primary guard.
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
# `response: Response` is required, not optional — see logs.py::correct_log's
# comment for why every key_func=rate_limit_key route needs this.
async def get_weekly_recap(request: Request, response: Response, language: str = "en", user=Depends(get_current_user)):
    """Natural-language summary of the user's own past 7 days — the
    cacheable half of the AI coach (see frontend/js/aiCoach.js for the other
    half: instant, zero-cost client-side math for structural questions like
    "what's my streak"). Reuses the exact same trends_service.compute_trends
    aggregation GET /trends already uses, so the numbers this recap talks
    about are guaranteed to match what Progress shows — never a second,
    independently-computed set of stats that could drift from it."""
    lang = "ro" if language == "ro" else "en"
    cached = coach_cache_service.get(user.id, lang)
    if cached is not None:
        return WeeklyRecapResponse(recap_text=cached, cached=True)

    # Checked before doing any of the aggregation work below: if the shared
    # quota is already spent, there's no point running four Supabase reads
    # first just to find that out at the last step.
    if not quota_service.has_capacity():
        raise HTTPException(
            status_code=503,
            detail="The AI coach is at capacity for today — try again tomorrow.",
        )

    settings = get_settings()
    retention_days = settings.retention_days
    supabase = get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()

    # Same concurrent-read pattern as routers/trends.py's GET /trends (this
    # endpoint needs the identical inputs to compute_trends).
    day, profile, logs, water, weight = await asyncio.gather(
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
            lambda: supabase.table("weight_logs").select("weight_kg,logged_at").eq("user_id", user.id).gte("logged_at", cutoff).execute()
        ),
    )
    target_calories = (profile.data or {}).get("daily_calories") or 2200

    trends = compute_trends(
        logs.data or [],
        water.data or [],
        weight.data or [],
        retention_days=retention_days,
        target_calories=target_calories,
        today=day["date"],
        timezone_name=day["timezone"],
    )

    logged_days = [d for d in trends.days if d.calories > 0 or d.protein > 0 or d.carbs > 0 or d.fats > 0]
    stats = {
        "target_calories": round(target_calories),
        "logged_days": len(logged_days),
        "total_days_in_window": len(trends.days),
        "adherent_days": sum(1 for d in trends.days if d.adherent),
        "current_streak": trends.streak,
        "average_calories_on_logged_days": round(sum(d.calories for d in logged_days) / len(logged_days)) if logged_days else 0,
    }

    try:
        recap_text = await generate_weekly_recap(stats, language=lang)
    except Exception:
        logger.exception("Unexpected error generating weekly recap")
        raise HTTPException(status_code=500, detail="Could not generate your weekly recap right now. Please try again.")

    coach_cache_service.put(user.id, lang, recap_text)
    return WeeklyRecapResponse(recap_text=recap_text, cached=False)
