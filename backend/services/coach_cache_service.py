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
