import asyncio
import difflib
import logging
import re
import time

import httpx

logger = logging.getLogger("exercise_cache_service")

# wger.de's exercise library, fetched once and cached in memory — see
# routers/discover.py for the search endpoint this backs.
#
# Why a bulk fetch-and-cache instead of proxying a live search query per
# request: wger's public API does not actually support server-side name
# search the way its docs/UI imply. Verified directly against the live API
# while building this:
#   - GET /api/v2/exercise/search/?term=... -> 404 (not a real endpoint on
#     the current API version)
#   - GET /api/v2/exercise-translation/?name__icontains=...&search=... ->
#     query params silently ignored, always returns the full unfiltered
#     table (3000+ rows, every language mixed together)
#   - GET /api/v2/exercise-translation/?name=... -> works, but EXACT match
#     only, useless for a user-typed search box
# GET /api/v2/exerciseinfo/?language=2 does work reliably (confirmed: 833
# English-translated exercises, full category/muscle/equipment/image data
# per entry) — so this fetches that in bulk and does the actual substring
# search itself, in Python, over the cached result.
_WGER_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_WGER_URL = "https://wger.de/api/v2/exerciseinfo/"
_PAGE_SIZE = 200
_PAGES_TO_FETCH = 2  # ~400 exercises — broad coverage without an unbounded startup fetch
_CACHE_TTL_SECONDS = 24 * 60 * 60  # this reference data changes rarely; a day is generous, not required
_ENGLISH_LANGUAGE_ID = 2

_lock = asyncio.Lock()
_cache: list[dict] = []
_cached_at: float = 0.0


def _extract_name(exercise: dict) -> str | None:
    for translation in exercise.get("translations", []):
        if translation.get("language") == _ENGLISH_LANGUAGE_ID and translation.get("name"):
            return translation["name"].strip()
    return None


def _extract_image(exercise: dict) -> str | None:
    images = exercise.get("images") or []
    main = next((img for img in images if img.get("is_main")), images[0] if images else None)
    if not main:
        return None
    return (main.get("thumbnails") or {}).get("medium") or main.get("image")


_HTML_TAG_RE = re.compile(r"<[^>]+>")
_MAX_DESCRIPTION_LENGTH = 300


def _extract_description(exercise: dict) -> str | None:
    """wger's own how-to text — already fetched as part of the same bulk
    exerciseinfo response as name/muscles/image, so surfacing it here is
    free (no extra request). It's raw HTML (usually a paragraph or two,
    sometimes a whole <ol> of coaching cues) and English-only (wger has no
    Romanian translation for this field), stripped down to plain text and
    capped to a short-cue length to match the curated EXERCISE_HOW_TO
    entries' tone rather than dumping a full technique essay into the UI."""
    for translation in exercise.get("translations", []):
        if translation.get("language") == _ENGLISH_LANGUAGE_ID and translation.get("description"):
            text = _HTML_TAG_RE.sub(" ", translation["description"])
            text = " ".join(text.split()).strip()
            if text:
                return text[:_MAX_DESCRIPTION_LENGTH]
    return None


def _normalize(exercise: dict) -> dict | None:
    """None for an exercise with no English translation — exerciseinfo's own
    `language=2` param already limits the results to ones that have one, but
    a defensive check here costs nothing and keeps this function safe to
    reuse even if that ever changes."""
    name = _extract_name(exercise)
    if not name:
        return None
    return {
        "id": exercise["id"],
        "name": name[:200],
        "category": ((exercise.get("category") or {}).get("name") or "Other")[:100],
        "muscles": [(m.get("name_en") or m.get("name") or "").strip()[:60] for m in exercise.get("muscles", []) if m.get("name")],
        "equipment": [(e.get("name") or "").strip()[:100] for e in exercise.get("equipment", []) if e.get("name")],
        "image_url": _extract_image(exercise),
        "license_author": (exercise.get("license_author") or "").strip()[:200] or None,
        "description": _extract_description(exercise),
    }


async def _fetch_page(client: httpx.AsyncClient, offset: int) -> dict:
    response = await client.get(_WGER_URL, params={"language": _ENGLISH_LANGUAGE_ID, "limit": _PAGE_SIZE, "offset": offset})
    response.raise_for_status()
    return response.json()


async def _refresh_cache() -> None:
    global _cache, _cached_at
    async with httpx.AsyncClient(timeout=_WGER_TIMEOUT) as client:
        raw: list[dict] = []
        for page in range(_PAGES_TO_FETCH):
            data = await _fetch_page(client, page * _PAGE_SIZE)
            raw.extend(data.get("results", []))
            if not data.get("next"):
                break
    normalized = [entry for ex in raw if (entry := _normalize(ex)) is not None]
    _cache = normalized
    _cached_at = time.monotonic()
    logger.info("Refreshed wger exercise cache: %d exercises", len(_cache))


async def get_exercises() -> list[dict]:
    async with _lock:
        stale = not _cache or (time.monotonic() - _cached_at) > _CACHE_TTL_SECONDS
        if stale:
            try:
                await _refresh_cache()
            except httpx.HTTPError:
                # A transient wger outage shouldn't break search for existing
                # users if we already have a (possibly stale) cache to serve
                # — reference data like this doesn't go wrong by being a day
                # old. Only propagate the failure if there's truly nothing
                # to fall back to yet (first request after a cold start).
                if not _cache:
                    raise
                logger.warning("wger refresh failed; serving stale cached exercise list (%d entries)", len(_cache))
    return _cache


# Below this, a query is considered "close enough" to surface rather than
# silently drop. A literal substring/exact-token match always scores 1.0;
# this is the floor for a fuzzy, typo-tolerant match (a single mistyped
# character in a mid-length word lands comfortably above this via
# difflib's ratio — verified against real typos like "sqaut"/"bemch" while
# tuning this) without also matching two genuinely unrelated words, which
# difflib's char-overlap ratio tends to keep below ~0.5 for words of
# realistic exercise-name length.
_FUZZY_MATCH_THRESHOLD = 0.6


def _token_score(query_token: str, name_tokens: list[str]) -> float:
    """Best-match score for one query token against any single token in the
    exercise name. A prefix/substring relationship scores high on its own
    (a deliberately strong signal — "curl" against "Dumbbell Bicep Curl" is
    a genuine, common partial search, not a typo to merely tolerate);
    difflib's char-level ratio is what catches an actual typo ("sqaut"
    against "squat") that shares no clean substring with anything."""
    best = 0.0
    for name_token in name_tokens:
        if query_token == name_token:
            return 1.0
        if name_token.startswith(query_token) or query_token in name_token:
            best = max(best, 0.9)
        best = max(best, difflib.SequenceMatcher(None, query_token, name_token).ratio())
    return best


def _name_match_score(query_lower: str, name_lower: str) -> float:
    """1.0 for a literal substring — the original exact-match behavior,
    preserved as the top of the ranking so an unchanged query still ranks
    unchanged results first. Otherwise, the average of each query word's own
    best per-word match against the exercise name: this makes the match
    word-order-independent ("press bench" still finds "Bench Press", which a
    plain substring check never could) and typo-tolerant (one mistyped word
    drags the average down instead of failing the whole query, unlike the
    original all-or-nothing substring check)."""
    if not query_lower:
        return 1.0
    if query_lower in name_lower:
        return 1.0
    query_tokens = query_lower.split()
    name_tokens = name_lower.split()
    if not query_tokens or not name_tokens:
        return 0.0
    scores = [_token_score(qt, name_tokens) for qt in query_tokens]
    return sum(scores) / len(scores)


async def search_exercises(query: str, muscle: str | None, equipment: str | None, limit: int) -> list[dict]:
    exercises = await get_exercises()
    query_lower = query.strip().lower()
    muscle_lower = (muscle or "").strip().lower()
    equipment_lower = (equipment or "").strip().lower()

    def passes_filters(ex: dict) -> bool:
        # wger's exercise photos are community-submitted and uneven in
        # quality/relevance — verified directly that a meaningful share of
        # entries have no photo at all. Rather than show a name with no
        # visual (or, worse, let a mislabeled/irrelevant community upload
        # stand in for one), results with no image are excluded entirely; the
        # curated POPULAR_EXERCISES list (data/discover_data.py, shown by
        # default before a search) is the hand-verified alternative for the
        # common lifts most users actually look for.
        if not ex.get("image_url"):
            return False
        if muscle_lower and not any(muscle_lower in m.lower() for m in ex["muscles"]):
            return False
        if equipment_lower and not any(equipment_lower in eq.lower() for eq in ex["equipment"]):
            return False
        return True

    candidates = [ex for ex in exercises if passes_filters(ex)]
    if not query_lower:
        return candidates[:limit]

    # Fuzzy-scored and ranked rather than the old boolean substring filter —
    # see _name_match_score's own docstring. list.sort() is stable, so ties
    # (common at the 1.0 exact-match ceiling) keep the cache's original
    # order rather than being shuffled by the sort.
    scored = [(ex, _name_match_score(query_lower, ex["name"].lower())) for ex in candidates]
    scored = [pair for pair in scored if pair[1] >= _FUZZY_MATCH_THRESHOLD]
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return [ex for ex, _score in scored][:limit]
