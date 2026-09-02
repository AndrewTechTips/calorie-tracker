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
    DamageControlResponse,
    MealSuggestionRequest,
    MealSuggestionsResponse,
    TrimTomorrowResponse,
    WeeklyRecapResponse,
)
from rate_limit import limiter
from routers.day import get_day_context
from services import ai_usage_service, coach_cache_service, damage_control_service
from services.effective_targets import effective_calorie_target
from services.gemini_service import (
    InvalidFoodInputError,
    chat_with_coach,
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
            lambda: supabase.table("profiles")
            .select("daily_calories,temp_calorie_override,temp_override_date")
            .eq("id", user_id)
            .maybe_single()
            .execute()
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
    # maybe_single() returns None outright (not .data=None) on no match.
    profile_row = (profile.data if profile else None) or {}
    # Honour a live "Trim tomorrow" override for today (services/
    # effective_targets.py) — the chat's context and the dashboard then agree
    # on today's goal. The streak/adherence math inside compute_trends still
    # keys off this single scalar; that's fine (the override only ever equals
    # today, and this feeds the coach's conversational context, not Progress).
    target_calories = effective_calorie_target(profile_row, day["date"])

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
            .select("daily_calories,daily_protein,daily_carbs,daily_fats,temp_calorie_override,temp_override_date")
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
    # maybe_single() returns None outright (not .data=None) on no match.
    targets = (profile.data if profile else None) or {}
    rows = logs.data or []
    total_calories = sum(r.get("calories", 0) for r in rows)
    total_protein = sum(r.get("protein", 0) for r in rows)
    total_carbs = sum(r.get("carbs", 0) for r in rows)
    total_fats = sum(r.get("fats", 0) for r in rows)

    # "Trim tomorrow" can lower today's calorie target (services/
    # effective_targets.py) — "what's left today" and "how far over" both
    # measure against that, so a trimmed day's Meal Suggester and any repeat
    # Damage Control open stay consistent with the dashboard ring.
    target_calories = effective_calorie_target(targets, today)
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
# Same burst-clause reasoning as scan.py's routes — this one spends a real
# Task C AI call (Groq, falling back to native Gemini) on a cache miss. Generous
# ceiling (this is a once-a-week action per user, gated further by
# coach_cache_service's own TTL) rather than scan's tighter limit, since the
# cache already absorbs any real repeat traffic — the rate limit here is
# just a backstop, not the primary guard.
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
        return WeeklyRecapResponse(recap_text=cached)

    # Checked only on the cache-miss path — a cached recap must always be
    # servable regardless of quota state (see services/ai_usage_service.py's
    # own docstring: a cache hit is never a "real attempt", so it can never
    # legitimately be blocked by a quota that exists to gate real AI spend).
    if not await ai_usage_service.try_consume(user.id, "weekly_recap"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "weekly_recap"))

    stats = await _build_user_stats(user.id)

    try:
        recap_text = await generate_weekly_recap(stats, language=lang)
    except Exception:
        logger.exception("Unexpected error generating weekly recap")
        raise HTTPException(status_code=500, detail="Could not generate your weekly recap right now. Please try again.")

    coach_cache_service.put(user.id, lang, recap_text)
    return WeeklyRecapResponse(recap_text=recap_text)


@router.post("/chat", response_model=CoachChatResponse)
# Tighter burst than the recap (a real back-and-forth chat, not a once-a-week
# tap), but the real ceiling on repeat spend is ai_usage_service's per-user
# daily cap below — this is just flood control on top of it.
@limiter.limit("6/minute;2/10 seconds", key_func=rate_limit_key)
async def coach_chat(
    request: Request, response: Response, payload: CoachChatRequest, user=Depends(get_current_user)
):
    """One turn of the capped free-text Coach chat — the interactive
    counterpart to the zero-cost preset insights in frontend/js/aiCoach.js.
    Gated by this user's own daily chat allowance
    (services/ai_usage_service.py, feature "coach_chat" — see config.py's
    coach_chat_daily_limit for why this exists as its own limit). Unlike Task A's Gemini path, Task C's
    provider chain (Groq, cycling its own 5-model list, then native Gemini
    as a last resort — see gemini_service.py's _task_c_chain) has no
    proactive "at capacity" gate: even Groq's own
    quota_service.has_capacity("groq") check (used internally to order
    Groq's model list, not to block the request) can't realistically
    starve the whole chain the way single-model Gemini
    once could. Chat history is never stored server-side — the client
    resends it each turn (see models.py's CoachChatRequest)."""
    lang = "ro" if payload.language == "ro" else "en"

    # 429 with a real {"detail": ...} body — frontend/js/api.js's 429 handler
    # prefers that detail text over slowapi's own generic rate-limit message
    # (slowapi's 429s use a bare {"error": ...} body with no "detail" key,
    # which is what that branch's fallback message is actually for), so this
    # friendly text reaches the user unmodified.
    if not await ai_usage_service.has_capacity(user.id, "coach_chat"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "coach_chat"))

    # A real conversation is several turns in quick succession; re-running
    # _build_user_stats's 4 Supabase reads + compute_trends on every single
    # message is pure repeat work within that window (see
    # coach_cache_service.STATS_TTL_SECONDS for why 90s is the right window).
    stats = coach_cache_service.get_stats(user.id)
    if stats is None:
        stats = await _build_user_stats(user.id)
        coach_cache_service.put_stats(user.id, stats)

    # Atomic check-and-spend right before the real attempt (mirrors
    # quota_service.record_call's own positioning inside gemini_service's
    # provider-chain walkers) — this, not the earlier has_capacity()
    # pre-check above, is the airtight gate against a burst of concurrent
    # requests from the same user (see ai_usage_service's module docstring).
    if not await ai_usage_service.try_consume(user.id, "coach_chat"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "coach_chat"))
    try:
        reply = await chat_with_coach(payload.message, payload.history, stats, language=lang)
    except InvalidFoodInputError:
        reply = _OFF_TOPIC_REPLY[lang]
    except Exception:
        logger.exception("Unexpected error generating coach chat reply")
        raise HTTPException(status_code=500, detail="Could not get a response from the coach right now. Please try again.")

    return CoachChatResponse(
        reply=reply, messages_remaining_today=await ai_usage_service.remaining_today(user.id, "coach_chat")
    )


@router.get("/damage-control", response_model=DamageControlResponse)
async def damage_control(user=Depends(get_current_user)):
    """"Damage Control" — 100% deterministic, no AI, no request body. The
    frontend (frontend/js/damageControl.js) decides WHEN to show the card;
    everything it renders is computed here from this user's own rows:

      - the overage + remaining macros for today (_remaining_macros, measured
        against today's EFFECTIVE target so a "Trim tomorrow" day stays
        self-consistent);
      - the deflation math ("~N kcal/day if you even it out over a week");
      - the `damage_control_sparkline_days`-day "zoom-out" series from
        daily_calorie_summary (today's spike as one notch on a steady line);
      - the "Move it" brisk-walk estimate and the "Trim tomorrow" target.

    See services/damage_control_service.py for the (pure, unit-tested) math.
    No rate-limit override — the app-wide default covers a bodyless read with
    nothing expensive behind it."""
    settings = get_settings()
    supabase = get_supabase()
    day = await get_day_context(supabase, user.id)
    today = day["date"]
    window_days = settings.damage_control_sparkline_days
    first_date = (today - timedelta(days=window_days - 1)).isoformat()

    stats, summary_res, weight_res = await asyncio.gather(
        _remaining_macros(supabase, user.id, today),
        run_in_threadpool(
            lambda: supabase.table("daily_calorie_summary")
            .select("date,calories,target")
            .eq("user_id", user.id)
            .gte("date", first_date)
            .execute()
        ),
        run_in_threadpool(
            lambda: supabase.table("weight_logs")
            .select("weight_kg")
            .eq("user_id", user.id)
            .order("logged_at", desc=True)
            .limit(1)
            .execute()
        ),
    )

    target_calories = stats["target_calories"]
    calories_over = stats["calories_over"]
    weight_kg = float(weight_res.data[0]["weight_kg"]) if weight_res.data else None

    deflation = damage_control_service.compute_deflation(calories_over)
    sparkline = damage_control_service.build_sparkline(
        summary_res.data or [],
        today=today,
        window_days=window_days,
        default_target=target_calories,
    )
    return DamageControlResponse(
        calories_over=calories_over,
        target_calories=target_calories,
        remaining_protein=stats["remaining_protein"],
        remaining_carbs=stats["remaining_carbs"],
        remaining_fats=stats["remaining_fats"],
        deflation=deflation,
        sparkline=sparkline,
        trailing_avg=damage_control_service.trailing_average(sparkline, include_today=True),
        trailing_avg_excl_today=damage_control_service.trailing_average(sparkline, include_today=False),
        walk_minutes=damage_control_service.walk_minutes_for(calories_over, weight_kg),
        trimmed_tomorrow_target=damage_control_service.trimmed_target_for_tomorrow(
            target_calories, deflation["per_day_kcal"]
        ),
    )


@router.post("/damage-control/trim-tomorrow", response_model=TrimTomorrowResponse)
# Per-user flood control on a real write — same shape as the other coach
# writes. `response: Response` required for key_func=rate_limit_key (see
# routers/logs.py::correct_log).
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
async def damage_control_trim_tomorrow(request: Request, response: Response, user=Depends(get_current_user)):
    """"Trim tomorrow" — writes a one-day, self-expiring calorie override
    (profiles.temp_calorie_override / temp_override_date) for tomorrow: the
    user's PERSISTENT daily_calories minus the deflation per-day figure,
    floored at damage_control_service.TRIM_FLOOR_KCAL. Deliberately based on
    the persistent target, never today's already-effective one, so repeated
    trims across a rough stretch can't compound the target downward. No
    {confirm} gate — it lapses on its own after one local day (services/
    effective_targets.py); re-tapping just rewrites the same pair."""
    supabase = get_supabase()
    day = await get_day_context(supabase, user.id)
    today = day["date"]
    tomorrow = today + timedelta(days=1)

    profile_res, stats = await asyncio.gather(
        run_in_threadpool(
            lambda: supabase.table("profiles").select("daily_calories").eq("id", user.id).maybe_single().execute()
        ),
        _remaining_macros(supabase, user.id, today),
    )
    raw_target = ((profile_res.data if profile_res else None) or {}).get("daily_calories") or 2200
    deflation = damage_control_service.compute_deflation(stats["calories_over"])
    trimmed = damage_control_service.trimmed_target_for_tomorrow(raw_target, deflation["per_day_kcal"])

    await run_in_threadpool(
        lambda: supabase.table("profiles")
        .update({"temp_calorie_override": trimmed, "temp_override_date": tomorrow.isoformat()})
        .eq("id", user.id)
        .execute()
    )
    return TrimTomorrowResponse(temp_calorie_override=trimmed, temp_override_date=tomorrow)


@router.post("/suggest-meals", response_model=MealSuggestionsResponse)
# Same reasoning as damage-control above — a real per-open action (adjusting
# filters and re-requesting), not cached. No proactive "at capacity" 503
# here (unlike Task A's scan_food): Task B's provider chain (Groq, falling
# back to native Gemini as a last resort — see gemini_service.py's
# _task_b_chain) has no realistic "everything is exhausted" state left for
# a pre-check to guard against. ai_usage_service's per-user daily cap below
# is the real backstop instead; this rate limit is just flood control.
@limiter.limit("10/minute;3/10 seconds", key_func=rate_limit_key)
async def suggest_meals(
    request: Request, response: Response, payload: MealSuggestionRequest, user=Depends(get_current_user)
):
    """Smart Meal Suggester — filters are pre-validated against a fixed enum
    by MealSuggestionRequest itself, and remaining_macros is entirely
    server-computed, so (unlike almost every other AI-backed route in this
    app) there's no untrusted free text anywhere in this request."""
    lang = "ro" if payload.language == "ro" else "en"

    if not await ai_usage_service.try_consume(user.id, "suggest_meals"):
        raise HTTPException(status_code=429, detail=await ai_usage_service.quota_message(user.id, "suggest_meals"))

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
