from datetime import date, datetime, time, timedelta, timezone

from fastapi.concurrency import run_in_threadpool

from config import get_settings
from database import get_supabase

# Per-user, per-day (and, for a handful of features, ALSO per-calendar-month)
# quota enforcement for every AI-calling feature in this app — DB-backed
# (sql/schema.sql's ai_feature_usage / ai_feature_usage_monthly tables +
# their increment_* RPCs), unlike quota_service.py's in-memory
# per-(provider, model) counters or the old coach-chat-only in-memory
# counter this replaces. Those track shared PROVIDER capacity (same number
# for every user, fine to lose on a restart); this tracks a PER-USER
# entitlement that must survive a Render restart/redeploy without silently
# resetting everyone's daily allowance — the whole point of a per-user quota
# is that a client can't reset it by doing anything on their end, including
# an outage on ours.
#
# Every route that spends a real AI-provider call follows the same two-step
# shape as quota_service.py/the old coach_chat_quota_service.py did:
#   1. has_capacity(user_id, feature) — checked BEFORE doing any real work,
#      so a capped user fails fast with a friendly message instead of
#      uploading an image / waiting on a network round trip first.
#   2. record_usage(user_id, feature) — called once, right before the actual
#      provider attempt (never speculatively earlier), so a request that's
#      rejected for an unrelated reason (bad image, validation error) never
#      burns quota it didn't actually spend. Counts even an attempt that
#      comes back invalid_input — the provider still billed that call.
#
# A cached answer (food_cache_service.py's rename cache, coach_cache_service.py's
# weekly recap cache) is NOT a "real attempt" — callers must only call
# record_usage() on the actual cache-miss path, never for a cache hit, or a
# free, zero-cost cached response would wrongly eat into the user's quota.
#
# --- Daily vs. monthly gating -----------------------------------------------
# Most features are gated by a daily count alone (_FEATURE_LIMIT_SETTINGS) —
# that matches how they're actually used: food logging, corrections, chat,
# and meal suggestions all have a genuinely daily usage pattern. Weekly
# Recap is the one exception: it's already cached server-side for 7 days
# per (user, language) (coach_cache_service.py), so its real cadence is
# "about once a week", not "up to N times a day" — a handful of features
# that share that shape get an ADDITIONAL monthly ceiling
# (_FEATURE_MONTHLY_LIMIT_SETTINGS), checked and recorded alongside the
# daily one rather than instead of it (the daily cap still guards against a
# same-day repeat-regen; the monthly cap is the real ceiling). A feature not
# listed in _FEATURE_MONTHLY_LIMIT_SETTINGS simply has no monthly gate at
# all — every function below treats that as "always has monthly capacity".

# Canonical registry of every per-user, per-day-gated AI feature — the
# single source of truth GET /ai-usage, the Settings "AI Limits" UI, and
# every route's own has_capacity()/record_usage() call all key off of. Each
# feature key maps to the Settings field holding its daily per-user limit
# (see config.py's "Per-user AI feature daily quotas" block for the actual
# numbers and the reasoning behind each one). Feature keys are internal,
# stable identifiers — never shown to the user directly; frontend/js/i18n.js
# owns the human-readable label (and explanatory hint) for each one.
_FEATURE_LIMIT_SETTINGS: dict[str, str] = {
    "scan": "ai_scan_daily_limit",
    "scan_describe": "ai_scan_describe_daily_limit",
    "log_correction": "ai_log_correction_daily_limit",
    "coach_chat": "coach_chat_daily_limit",
    "weekly_recap": "ai_weekly_recap_daily_limit",
    "damage_control": "ai_damage_control_daily_limit",
    "suggest_meals": "ai_suggest_meals_daily_limit",
}

# Optional second gate, on top of the daily one above — see the module
# docstring's "Daily vs. monthly gating" section. Only features whose real
# usage cadence is sub-daily belong here; adding one to a genuinely
# daily-use feature would just be redundant math on top of its daily cap.
_FEATURE_MONTHLY_LIMIT_SETTINGS: dict[str, str] = {
    "weekly_recap": "ai_weekly_recap_monthly_limit",
}

# Friendly, English-only detail text for a 429 raised by a capped feature —
# same convention as the message coach_chat's old in-memory limiter used
# ("resets at midnight UTC", never technical jargon). Backend error strings
# stay English-only by this app's existing convention (see CLAUDE.md's i18n
# section) — this is genuinely an error path, unlike Coach chat's own
# off-topic reply text which follows the request's language.
_QUOTA_MESSAGES_DAILY: dict[str, str] = {
    "scan": "You've reached today's AI Meal Scan limit — it resets at midnight UTC. You can still log this meal manually.",
    "scan_describe": "You've reached today's AI description limit — it resets at midnight UTC. Try logging manually or from a saved meal.",
    "log_correction": "You've reached today's food-correction limit — it resets at midnight UTC. You can still edit the weight or macros directly.",
    "coach_chat": "You've reached today's Coach chat limit — it resets at midnight UTC. The quick-answer questions above are still free anytime.",
    "weekly_recap": "You've already generated a recap today — try again tomorrow, or check the one you already have.",
    "damage_control": "You've reached today's Damage Control limit — it resets at midnight UTC.",
    "suggest_meals": "You've reached today's Meal Suggester limit — it resets at midnight UTC.",
}

# Only needed for monthly-gated features (_FEATURE_MONTHLY_LIMIT_SETTINGS) —
# shown instead of the daily message above specifically when the DAILY count
# still has room but the MONTHLY one doesn't, so the user is told the real
# reason rather than a misleading "resets at midnight" (it won't; the
# monthly cap resets on the 1st).
_QUOTA_MESSAGES_MONTHLY: dict[str, str] = {
    "weekly_recap": "You've used all your recaps for this month — it resets on the 1st. Your most recent recap is still available anytime this week.",
}


async def quota_message(user_id: str, feature: str) -> str:
    """Picks the right rejection message for `feature` — the daily one, or
    (only for monthly-gated features whose daily count still has room but
    whose monthly one doesn't) the monthly one. Async because telling the
    two apart requires knowing which cap was actually hit, not just that
    has_capacity() returned False."""
    if await remaining_today(user_id, feature) <= 0:
        return _QUOTA_MESSAGES_DAILY[feature]
    return _QUOTA_MESSAGES_MONTHLY.get(feature, _QUOTA_MESSAGES_DAILY[feature])


def _limit(feature: str) -> int:
    setting_name = _FEATURE_LIMIT_SETTINGS[feature]
    return getattr(get_settings(), setting_name)


def _monthly_limit(feature: str) -> int | None:
    setting_name = _FEATURE_MONTHLY_LIMIT_SETTINGS.get(feature)
    if setting_name is None:
        return None
    return getattr(get_settings(), setting_name)


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _this_month() -> date:
    return _today().replace(day=1)


async def usage_today(user_id: str, feature: str) -> int:
    """This user's current UTC-day call count for `feature` — 0 if no row
    exists yet (never spent anything today)."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("ai_feature_usage")
        .select("call_count")
        .eq("user_id", user_id)
        .eq("feature", feature)
        .eq("usage_date", _today().isoformat())
        .maybe_single()
        .execute()
    )
    # postgrest-py's maybe_single().execute() returns None outright (not an
    # object with .data = None) when zero rows match — the common case for
    # any user/feature/day combination that hasn't recorded a call yet.
    return ((result.data if result else None) or {}).get("call_count", 0)


async def usage_this_month(user_id: str, feature: str) -> int:
    """Same as usage_today, bucketed to the current calendar month instead
    (ai_feature_usage_monthly) — only meaningful for a feature listed in
    _FEATURE_MONTHLY_LIMIT_SETTINGS, but safe to call for any feature (just
    reads an always-empty bucket for one that isn't monthly-gated)."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("ai_feature_usage_monthly")
        .select("call_count")
        .eq("user_id", user_id)
        .eq("feature", feature)
        .eq("usage_month", _this_month().isoformat())
        .maybe_single()
        .execute()
    )
    return ((result.data if result else None) or {}).get("call_count", 0)


async def remaining_today(user_id: str, feature: str) -> int:
    """Never negative, even if the configured limit was lowered after some
    usage already happened today."""
    used = await usage_today(user_id, feature)
    return max(0, _limit(feature) - used)


async def remaining_this_month(user_id: str, feature: str) -> int | None:
    """None (not 0) when `feature` has no monthly gate at all — callers must
    treat None as "unlimited for this axis", not as "zero remaining"."""
    monthly_limit = _monthly_limit(feature)
    if monthly_limit is None:
        return None
    used = await usage_this_month(user_id, feature)
    return max(0, monthly_limit - used)


async def has_capacity(user_id: str, feature: str) -> bool:
    if await remaining_today(user_id, feature) <= 0:
        return False
    monthly_remaining = await remaining_this_month(user_id, feature)
    return monthly_remaining is None or monthly_remaining > 0


async def record_usage(user_id: str, feature: str) -> int:
    """Call exactly once per real AI-provider attempt for `feature` — see
    this module's docstring for the "only real attempts, never
    speculatively, never on a cache hit" rule. Atomic upsert-increment via a
    Postgres RPC (sql/schema.sql's increment_ai_feature_usage): the plain
    REST client can't do a race-free read-then-write itself, and two
    requests from the same user landing in the same instant must never both
    read the same starting count. Also increments the monthly counter
    (increment_ai_feature_usage_monthly) when `feature` is monthly-gated —
    both counters must move together, or the two caps could silently drift
    apart from what actually happened. Returns the new daily count."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.rpc("increment_ai_feature_usage", {"p_user_id": user_id, "p_feature": feature}).execute()
    )
    if feature in _FEATURE_MONTHLY_LIMIT_SETTINGS:
        await run_in_threadpool(
            lambda: supabase.rpc(
                "increment_ai_feature_usage_monthly", {"p_user_id": user_id, "p_feature": feature}
            ).execute()
        )
    return result.data


async def get_usage_summary(user_id: str) -> list[dict]:
    """One entry per known feature, even ones this user hasn't touched today
    (used=0) — GET /ai-usage's payload, and what Settings' AI Limits section
    renders directly. One query for every feature's daily usage, plus one
    more for monthly usage only if any feature actually has a monthly gate
    (skipped entirely otherwise, since ai_feature_usage_monthly would just
    be empty for every row). Monthly fields are None for a feature with no
    monthly gate — the frontend renders no second bar for those."""
    supabase = get_supabase()
    daily_result = await run_in_threadpool(
        lambda: supabase.table("ai_feature_usage")
        .select("feature,call_count")
        .eq("user_id", user_id)
        .eq("usage_date", _today().isoformat())
        .execute()
    )
    used_by_feature = {row["feature"]: row["call_count"] for row in (daily_result.data or [])}

    monthly_used_by_feature: dict[str, int] = {}
    if _FEATURE_MONTHLY_LIMIT_SETTINGS:
        monthly_result = await run_in_threadpool(
            lambda: supabase.table("ai_feature_usage_monthly")
            .select("feature,call_count")
            .eq("user_id", user_id)
            .eq("usage_month", _this_month().isoformat())
            .execute()
        )
        monthly_used_by_feature = {row["feature"]: row["call_count"] for row in (monthly_result.data or [])}

    summary = []
    for feature in _FEATURE_LIMIT_SETTINGS:
        used = used_by_feature.get(feature, 0)
        limit = _limit(feature)
        monthly_limit = _monthly_limit(feature)
        entry = {
            "feature": feature,
            "used": used,
            "limit": limit,
            "remaining": max(0, limit - used),
            "monthly_used": None,
            "monthly_limit": None,
            "monthly_remaining": None,
        }
        if monthly_limit is not None:
            monthly_used = monthly_used_by_feature.get(feature, 0)
            entry["monthly_used"] = monthly_used
            entry["monthly_limit"] = monthly_limit
            entry["monthly_remaining"] = max(0, monthly_limit - monthly_used)
        summary.append(entry)
    return summary


def resets_at() -> datetime:
    tomorrow = _today() + timedelta(days=1)
    return datetime.combine(tomorrow, time.min, tzinfo=timezone.utc)


def monthly_resets_at() -> datetime:
    this_month = _this_month()
    next_month = date(this_month.year + 1, 1, 1) if this_month.month == 12 else date(this_month.year, this_month.month + 1, 1)
    return datetime.combine(next_month, time.min, tzinfo=timezone.utc)
