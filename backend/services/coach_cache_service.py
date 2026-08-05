import threading
import time

# In-memory cache of each user's weekly AI-coach recap text, keyed by
# (user_id, language) — language is part of the key, not just an input to
# generation, because the cached value is natural-language TEXT: without
# this, a user who briefly switches languages would see a stale-language
# recap for up to a week (contrast with food_cache_service.py's cache, which
# is deliberately NOT language-keyed, because its cached value is plain
# numbers with no language dimension at all — the two aren't the same
# situation despite the surface similarity).
#
# What makes this "heavily cacheable" (see routers/coach.py): a rolling
# 7-day TTL, not a calendar-week boundary — same "rolling window, not
# calendar weeks" philosophy this app already applies to data retention (see
# Settings.retention_days) and the frontend's streak-freeze cooldown
# (frontend/js/streakFreeze.js). Opening the coach five times in one day
# only ever costs one real Gemini call; the other four are served from here.
#
# In-memory, not a DB table — same reasoning as quota_service.py and
# food_cache_service.py: this is a single Render instance, so a restart
# only ever regenerates a recap a little early (one extra Gemini call per
# affected user), never blocks or serves stale data past its real TTL.
_lock = threading.Lock()
_cache: dict[tuple[str, str], dict] = {}
TTL_SECONDS = 7 * 24 * 60 * 60


def get(user_id: str, language: str) -> str | None:
    key = (user_id, language)
    with _lock:
        entry = _cache.get(key)
        if entry is None:
            return None
        if time.time() - entry["generated_at"] >= TTL_SECONDS:
            return None
        return entry["recap_text"]


def put(user_id: str, language: str, recap_text: str) -> None:
    with _lock:
        _cache[(user_id, language)] = {"recap_text": recap_text, "generated_at": time.time()}


# ---------------------------------------------------------------------------
# Coach chat's per-turn user-stats snapshot — a separate, much shorter-lived
# cache from the recap text above (different key shape, different dict, own
# lock-free short TTL). routers/coach.py's coach_chat() re-derives the same
# 4-concurrent-Supabase-read + compute_trends aggregation _build_user_stats
# does on every single chat message; a real back-and-forth conversation can
# easily be 5-10 turns in a couple of minutes, and none of that work changes
# meaningfully between messages sent seconds apart. Not language-keyed (the
# cached value here is a plain numbers dict, not natural-language text — see
# the recap cache's own comment above for why that distinction matters).
# STATS_TTL_SECONDS is deliberately short (not the recap's 7-day window):
# long enough to absorb a rapid chat exchange, short enough that a user who
# logs food mid-conversation sees it reflected again within the same minute
# or two, not a stale week-old cache lingering.
# ---------------------------------------------------------------------------
_stats_cache: dict[str, dict] = {}
STATS_TTL_SECONDS = 90


def get_stats(user_id: str) -> dict | None:
    with _lock:
        entry = _stats_cache.get(user_id)
        if entry is None:
            return None
        if time.time() - entry["cached_at"] >= STATS_TTL_SECONDS:
            return None
        return entry["stats"]


def put_stats(user_id: str, stats: dict) -> None:
    with _lock:
        _stats_cache[user_id] = {"stats": stats, "cached_at": time.time()}
