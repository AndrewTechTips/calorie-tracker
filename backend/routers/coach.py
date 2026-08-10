import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user, rate_limit_key
from config import get_settings
from database import get_supabase
from models import (
    CoachChatRequest,
    CoachChatResponse,
    DamageControlRequest,
    DamageControlResponse,
    MealSuggestionRequest,
    MealSuggestionsResponse,
    WeeklyRecapResponse,
)
from rate_limit import limiter
from routers.day import get_day_context
from services import coach_cache_service, coach_chat_quota_service, quota_service
from services.gemini_service import (
    InvalidFoodInputError,
    chat_with_coach,
    generate_damage_control_message,
    generate_meal_suggestions,
    generate_weekly_recap,
)
from services.trends_service import compute_trends

logger = logging.getLogger("coach")

router = APIRouter(prefix="/coach", tags=["coach"])

# Shown instead of a real Gemini reply when the model flags the turn as
# off-topic/a prompt-injection attempt (gemini_service.chat_with_coach raises
# InvalidFoodInputError for that case) — a normal, friendly conversational
# reply, not an error, so the chat UI shows it exactly like any other Coach
# message. Backend strings are otherwise English-only by convention (see
# CLAUDE.md) since HTTPException detail text is never localized, but this is
# genuine user-facing chat content, not an error message, so it follows the
# request's own language like every other Coach-generated reply does.
_OFF_TOPIC_REPLY = {
    "en": "I'm just your nutrition and fitness coach here in the app — I can't help with that, but I'm happy to talk about your goals, progress, or anything food/training related.",
    "ro": "Sunt doar antrenorul tău de nutriție și fitness din aplicație — nu te pot ajuta cu asta, dar sunt bucuros să discutăm despre obiectivele, progresul sau orice ține de alimentație/antrenament.",
}


async def _build_user_stats(user_id: str) -> dict:
    """Shared by both routes below — the same server-computed aggregate
    numbers feed the weekly recap and the chat's live context, so a user
    never gets two different-sounding answers about the same underlying
    trend depending on which AI feature they asked. Mirrors routers/
    trends.py's GET /trends inputs exactly (same concurrent-read pattern)."""
    settings = get_settings()
    retention_days = settings.retention_days
    supabase = get_supabase()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()

    day, profile, logs, water, weight = await asyncio.gather(
        get_day_context(supabase, user_id),
        run_in_threadpool(
            lambda: supabase.table("profiles").select("daily_calories").eq("id", user_id).maybe_single().execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("daily_logs")
            .select("food_name,calories,protein,carbs,fats,sugar,workout_tag,logged_at,log_date")
            .eq("user_id", user_id)
            .gte("logged_at", cutoff)
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("water_logs")
            .select("amount_ml,logged_at,log_date")
            .eq("user_id", user_id)
            .gte("logged_at", cutoff)
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("weight_logs")
            .select("weight_kg,logged_at")
            .eq("user_id", user_id)
            .gte("logged_at", cutoff)
            .execute()
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

    # Today's own pre/post-workout-tagged entries (see sql/schema.sql's
    # daily_logs.workout_tag) — feeds COACH_CHAT_PROMPT's meal-timing
    # awareness rules. User-set, never AI-inferred; "regular" (untagged) rows
    # are excluded since there's nothing timing-related to say about them.
    today_tagged_meals = [
        {
            "tag": log["workout_tag"],
            "food_name": log["food_name"],
            "fats": log.get("fats", 0),
            "carbs": log.get("carbs", 0),
            "sugar": log.get("sugar", 0),
        }
        for log in (logs.data or [])
        if log.get("log_date") == day["date"].isoformat() and log.get("workout_tag", "regular") != "regular"
    ]

    return {
        "target_calories": round(target_calories),
        "logged_days": len(logged_days),
        "total_days_in_window": len(trends.days),
        "adherent_days": sum(1 for d in trends.days if d.adherent),
        "current_streak": trends.streak,
        "average_calories_on_logged_days": round(sum(d.calories for d in logged_days) / len(logged_days)) if logged_days else 0,
        "today_tagged_meals": today_tagged_meals,
    }


async def _remaining_macros(supabase, user_id: str, today) -> dict:
    """Today's own daily_logs totals vs. this user's own profile targets —
    shared by the Damage Control and Smart Meal Suggester endpoints below,
    both of which start from "what's left today". Deliberately narrower than
    _build_user_stats above (that one aggregates the whole retention window
    for trends/streak; this is just today's four macros vs. target), and
    entirely server-computed — remaining_* are floored at 0 (room left, never
    a negative "you owe this"), calories_over is the flip side for calories
    specifically (0 whenever today's total is at or under target)."""
    profile, logs = await asyncio.gather(
        run_in_threadpool(
            lambda: supabase.table("profiles")
            .select("daily_calories,daily_protein,daily_carbs,daily_fats")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("daily_logs")
            .select("calories,protein,carbs,fats")
            .eq("user_id", user_id)
            .eq("log_date", today.isoformat())
            .execute()
        ),
    )
    targets = profile.data or {}
    rows = logs.data or []
    total_calories = sum(r.get("calories", 0) for r in rows)
    total_protein = sum(r.get("protein", 0) for r in rows)
    total_carbs = sum(r.get("carbs", 0) for r in rows)
    total_fats = sum(r.get("fats", 0) for r in rows)

    target_calories = targets.get("daily_calories") or 2200
    target_protein = targets.get("daily_protein") or 150
    target_carbs = targets.get("daily_carbs") or 250
    target_fats = targets.get("daily_fats") or 70

    return {
        "target_calories": round(target_calories),
        "today_total_calories": round(total_calories),
        "calories_over": round(max(total_calories - target_calories, 0)),
        "remaining_calories": round(max(target_calories - total_calories, 0)),
        "remaining_protein": round(max(target_protein - total_protein, 0), 1),
        "remaining_carbs": round(max(target_carbs - total_carbs, 0), 1),
        "remaining_fats": round(max(target_fats - total_fats, 0), 1),
    }


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

    stats = await _build_user_stats(user.id)

    try:
        recap_text = await generate_weekly_recap(stats, language=lang)
    except Exception:
        logger.exception("Unexpected error generating weekly recap")
        raise HTTPException(status_code=500, detail="Could not generate your weekly recap right now. Please try again.")

    coach_cache_service.put(user.id, lang, recap_text)
    return WeeklyRecapResponse(recap_text=recap_text, cached=False)


@router.post("/chat", response_model=CoachChatResponse)
# Tighter burst than the recap (a real back-and-forth chat, not a once-a-week
# tap), but the real ceiling on repeat spend is coach_chat_quota_service's
# per-user daily cap below — this is just flood control on top of it.
@limiter.limit("6/minute;2/10 seconds", key_func=rate_limit_key)
async def coach_chat(
    request: Request, response: Response, payload: CoachChatRequest, user=Depends(get_current_user)
):
    """One turn of the capped free-text Coach chat — the interactive
    counterpart to the zero-cost preset insights in frontend/js/aiCoach.js.
    Two independent limits gate this before any Gemini call happens: this
    user's own daily chat allowance (coach_chat_quota_service — see
    config.py's coach_chat_daily_limit for why this exists as its own
    limit), and the shared global Gemini quota every AI feature in this app
    draws from (quota_service). Chat history is never stored server-side —
    the client resends it each turn (see models.py's CoachChatRequest)."""
    lang = "ro" if payload.language == "ro" else "en"

    # 503, not 429: frontend/js/api.js special-cases 429 into a generic
    # "you're being rate limited" message (slowapi's own 429s use a
    # different body shape than this app's normal {"detail": ...} errors,
    # which is what that special-case is actually for) — a real
    # HTTPException(429, detail=...) like this would have its friendly
    # detail text silently discarded by that branch. 503 matches the
    # existing convention quota_service's own "at capacity" case uses right
    # below, and reaches the client's error.message intact.
    if not coach_chat_quota_service.has_capacity(user.id):
        raise HTTPException(
            status_code=503,
            detail="You've reached today's Coach chat limit — it resets at midnight UTC. The quick-answer questions above are still free anytime.",
        )
    if not quota_service.has_capacity():
        raise HTTPException(
            status_code=503,
            detail="The AI coach is at capacity for today — try again tomorrow.",
        )

    # A real conversation is several turns in quick succession; re-running
    # _build_user_stats's 4 Supabase reads + compute_trends on every single
    # message is pure repeat work within that window (see
    # coach_cache_service.STATS_TTL_SECONDS for why 90s is the right window).
    stats = coach_cache_service.get_stats(user.id)
    if stats is None:
        stats = await _build_user_stats(user.id)
        coach_cache_service.put_stats(user.id, stats)

    # Recorded right before the real attempt (mirrors quota_service.
    # record_gemini_call's own positioning inside gemini_service._call_model)
    # — counts even a turn that comes back invalid_input, since that still
    # spent a real Gemini call against the shared quota above.
    coach_chat_quota_service.record_turn(user.id)
    try:
        reply = await chat_with_coach(payload.message, payload.history, stats, language=lang)
    except InvalidFoodInputError:
        reply = _OFF_TOPIC_REPLY[lang]
    except Exception:
        logger.exception("Unexpected error generating coach chat reply")
        raise HTTPException(status_code=500, detail="Could not get a response from the coach right now. Please try again.")

    return CoachChatResponse(reply=reply, messages_remaining_today=coach_chat_quota_service.remaining_today(user.id))


@router.post("/damage-control", response_model=DamageControlResponse)
# Same burst-clause shape as weekly-recap above — a generous ceiling since
# nothing here caches the way the recap does (a user can trigger this once
# per genuinely over-target meal, which is real usage, not abuse), backstopped
# by the shared quota_service check below.
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
# `response: Response` required — see correct_log's own comment in
# routers/logs.py for why every key_func=rate_limit_key route needs this.
async def damage_control(
    request: Request, response: Response, payload: DamageControlRequest, user=Depends(get_current_user)
):
    """The "Damage Control" intervention's backend half — the frontend
    (app.js's shouldTriggerDamageControl) decides WHEN to show the card
    client-side from data it already has, but the actual numbers shown
    (remaining_*, calories_over) and the AI message are both recomputed here
    from this user's own real rows, never trusted from the client."""
    if not quota_service.has_capacity():
        raise HTTPException(
            status_code=503,
            detail="The AI coach is at capacity for today — try again tomorrow.",
        )
    lang = "ro" if payload.language == "ro" else "en"
    supabase = get_supabase()
    day = await get_day_context(supabase, user.id)
    stats = await _remaining_macros(supabase, user.id, day["date"])

    try:
        message = await generate_damage_control_message(stats, payload.trigger_food_name, language=lang)
    except Exception:
        logger.exception("Unexpected error generating damage control message")
        raise HTTPException(
            status_code=500, detail="Could not generate a recovery plan right now. Please try again."
        )

    return DamageControlResponse(
        message=message,
        calories_over=stats["calories_over"],
        remaining_calories=stats["remaining_calories"],
        remaining_protein=stats["remaining_protein"],
        remaining_carbs=stats["remaining_carbs"],
        remaining_fats=stats["remaining_fats"],
    )


@router.post("/suggest-meals", response_model=MealSuggestionsResponse)
# Same reasoning as damage-control above — a real per-open action (adjusting
# filters and re-requesting), not cached, backstopped by the shared quota.
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
async def suggest_meals(
    request: Request, response: Response, payload: MealSuggestionRequest, user=Depends(get_current_user)
):
    """Smart Meal Suggester — filters are pre-validated against a fixed enum
    by MealSuggestionRequest itself, and remaining_macros is entirely
    server-computed, so (unlike almost every other Gemini-backed route in
    this app) there's no untrusted free text anywhere in this request."""
    if not quota_service.has_capacity():
        raise HTTPException(
            status_code=503,
            detail="The AI coach is at capacity for today — try again tomorrow.",
        )
    lang = "ro" if payload.language == "ro" else "en"
    supabase = get_supabase()
    day = await get_day_context(supabase, user.id)
    stats = await _remaining_macros(supabase, user.id, day["date"])
    remaining_macros = {
        "remaining_calories": stats["remaining_calories"],
        "remaining_protein": stats["remaining_protein"],
        "remaining_carbs": stats["remaining_carbs"],
        "remaining_fats": stats["remaining_fats"],
    }

    try:
        raw_suggestions = await generate_meal_suggestions(remaining_macros, payload.filters, language=lang)
        # Constructed inside the try, not after it: a malformed field from a
        # rare bad model response should still surface as this endpoint's own
        # friendly 500, not an unhandled Pydantic ValidationError bubbling up
        # as a raw, undecorated server error.
        return MealSuggestionsResponse(suggestions=raw_suggestions)
    except Exception:
        logger.exception("Unexpected error generating meal suggestions")
        raise HTTPException(
            status_code=500, detail="Could not get meal suggestions right now. Please try again."
        )
