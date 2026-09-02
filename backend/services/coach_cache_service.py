import threading
import time

# In-memory cache of each user's weekly-recap AI CAPTION (the 1-2 sentence
# line above the otherwise-deterministic Wrapped screen — see
# services/recap_service.py). Keyed by (user_id, language): language is part
# of the key, not just a generation input, because the cached value is
# natural-language TEXT — without this a user who briefly switches languages
# would see a stale-language caption for up to a week (contrast
# food_cache_service.py, deliberately NOT language-keyed because it caches
# plain numbers).
#
# The metrics/insights are recomputed fresh on every request (cheap, ~4
# Supabase reads like GET /trends), so they always reflect a just-logged
# meal. Only the caption is cached, and only reused while the TOP INSIGHT
# KINDS it was written about are still the top kinds this week — if the
# week's story materially changes, the caption regenerates (consuming the
# weekly_recap quota, same as the old cache-miss path). Same rolling 7-day
# TTL, not a calendar-week boundary.
#
# In-memory, not a DB table — same reasoning as quota_service.py: single
# Render instance, so a restart only regenerates a caption a little early,
# never blocks or serves past its real TTL.
_lock = threading.Lock()
_cache: dict[tuple[str, str], dict] = {}
TTL_SECONDS = 7 * 24 * 60 * 60


def get_recap_caption(user_id: str, language: str, top_kinds: list[str]) -> str | None:
    """The cached caption for this user+language, but only if it was written
    about the same set of top insight kinds that are top right now (order-
    insensitive). Returns None to signal "regenerate" on a kind change or a
    lapsed TTL."""
    with _lock:
        entry = _cache.get((user_id, language))
        if entry is None or time.time() - entry["generated_at"] >= TTL_SECONDS:
            return None
        if sorted(entry["top_kinds"]) != sorted(top_kinds):
            return None
        return entry["caption"]


def put_recap_caption(user_id: str, language: str, caption: str, top_kinds: list[str]) -> None:
    with _lock:
        _cache[(user_id, language)] = {
            "caption": caption,
            "top_kinds": list(top_kinds),
            "generated_at": time.time(),
        }


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
