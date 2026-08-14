import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import AnalyticsInsightsResponse, TargetsResponse
from services import analytics_service
from services.db_tolerance import write_tolerant

router = APIRouter(prefix="/analytics", tags=["analytics"])


async def _fetch_profile_and_history(supabase, user_id: str, retention_days: int):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    # Weight history looks back further than the daily_logs retention window
    # (weight_logs is kept indefinitely, see sql/schema.sql) — 120 days is
    # ample for MIN_WEIGHT_SPAN_DAYS_FOR_REGRESSION while staying "recent"
    # enough that body-composition drift from a year ago doesn't skew today's
    # TDEE estimate.
    weight_cutoff = (datetime.now(timezone.utc) - timedelta(days=120)).isoformat()

    # select("*") (not an explicit column list), same as routers/targets.py's
    # get_targets — the new biometric/locked_macro columns are optional and
    # may not exist yet on a project that hasn't pasted in the latest
    # sql/schema.sql (see CLAUDE.md's note on schema changes needing manual
    # application); an explicit select naming them would 400 outright on a
    # not-yet-migrated project, where select("*") just omits them from the
    # returned row and the .get()s below fall back to sensible defaults.
    profile, weight_rows, log_rows = await asyncio.gather(
        run_in_threadpool(
            lambda: supabase.table("profiles").select("*").eq("id", user_id).maybe_single().execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("weight_logs")
            .select("weight_kg,logged_at")
            .eq("user_id", user_id)
            .gte("logged_at", weight_cutoff)
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("daily_logs")
            .select("calories,log_date")
            .eq("user_id", user_id)
            .gte("logged_at", cutoff)
            .execute()
        ),
    )
    if profile is None or not profile.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile.data, weight_rows.data or [], log_rows.data or []


def _sum_calories_by_day(log_rows: list[dict]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for row in log_rows:
        totals[row["log_date"]] = totals.get(row["log_date"], 0.0) + row["calories"]
    return totals


@router.get("/insights", response_model=AnalyticsInsightsResponse)
async def get_insights(user=Depends(get_current_user)):
    """Weight forecast (30/60/90 day, with under-logging days flagged and
    excluded) + the weekly Adaptive Goals evaluation, computed fresh from
    daily_logs/weight_logs/profiles — no separate storage, same "compute at
    read time" philosophy as GET /trends. See services/analytics_service.py
    for the actual math; this route is just the Supabase plumbing."""
    settings = get_settings()
    supabase = get_supabase()
    profile, weight_rows, log_rows = await _fetch_profile_and_history(supabase, user.id, settings.retention_days)

    forecast = analytics_service.build_weight_forecast(
        weight_rows=weight_rows,
        daily_calories=_sum_calories_by_day(log_rows),
        age=profile.get("age"),
        height_cm=profile.get("height_cm"),
        biological_sex=profile.get("biological_sex"),
        activity_level=profile.get("activity_level") or "moderate",
        retention_days=settings.retention_days,
    )

    adaptive_goal = None
    if forecast.data_sufficient:
        adaptive_goal = analytics_service.evaluate_adaptive_goal(
            goal_type=profile.get("goal_type") or "maintain",
            current_daily_calories=profile.get("daily_calories") or 2200,
            current_protein_g=profile.get("daily_protein") or 0,
            current_carbs_g=profile.get("daily_carbs") or 0,
            current_fats_g=profile.get("daily_fats") or 0,
            weight_kg=forecast.current_weight_kg,
            tdee_estimate=forecast.tdee_estimate,
            weekly_rate_kg=forecast.weekly_rate_kg,
            method=forecast.method,
            locked_macro=profile.get("locked_macro"),
        )

    return AnalyticsInsightsResponse(forecast=forecast, adaptive_goal=adaptive_goal)


@router.post("/apply-adaptive-goal", response_model=TargetsResponse)
async def apply_adaptive_goal(user=Depends(get_current_user)):
    """Recomputes the current suggestion server-side (never trusts a
    client-echoed number — same defense-in-depth spirit as every other
    write in this app) and writes it as the user's new daily targets. A
    deliberate, user-initiated action (the frontend only calls this from an
    explicit "Apply" tap on the insights card), never automatic — see
    CLAUDE.md's Adaptive Goals section for why this stays suggest-then-
    confirm rather than silently auto-adjusting someone's targets."""
    settings = get_settings()
    supabase = get_supabase()
    profile, weight_rows, log_rows = await _fetch_profile_and_history(supabase, user.id, settings.retention_days)

    forecast = analytics_service.build_weight_forecast(
        weight_rows=weight_rows,
        daily_calories=_sum_calories_by_day(log_rows),
        age=profile.get("age"),
        height_cm=profile.get("height_cm"),
        biological_sex=profile.get("biological_sex"),
        activity_level=profile.get("activity_level") or "moderate",
        retention_days=settings.retention_days,
    )
    if not forecast.data_sufficient:
        raise HTTPException(status_code=400, detail="Log your weight at least once before applying a suggested goal.")

    suggestion = analytics_service.evaluate_adaptive_goal(
        goal_type=profile.get("goal_type") or "maintain",
        current_daily_calories=profile.get("daily_calories") or 2200,
        current_protein_g=profile.get("daily_protein") or 0,
        current_carbs_g=profile.get("daily_carbs") or 0,
        current_fats_g=profile.get("daily_fats") or 0,
        weight_kg=forecast.current_weight_kg,
        tdee_estimate=forecast.tdee_estimate,
        weekly_rate_kg=forecast.weekly_rate_kg,
        method=forecast.method,
        locked_macro=profile.get("locked_macro"),
    )

    update_data = {
        "daily_calories": suggestion.suggested_daily_calories,
        "daily_protein": suggestion.suggested_protein,
        "daily_carbs": suggestion.suggested_carbs,
        "daily_fats": suggestion.suggested_fats,
    }
    result = await write_tolerant(
        lambda data: supabase.table("profiles").update(data).eq("id", user.id).execute(), update_data
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {**result.data[0], "created_at": user.created_at}
