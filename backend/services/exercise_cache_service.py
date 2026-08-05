import asyncio
import logging
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


async def search_exercises(query: str, muscle: str | None, equipment: str | None, limit: int) -> list[dict]:
    exercises = await get_exercises()
    query_lower = query.strip().lower()
    muscle_lower = (muscle or "").strip().lower()
    equipment_lower = (equipment or "").strip().lower()

    def matches(ex: dict) -> bool:
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
        if query_lower and query_lower not in ex["name"].lower():
            return False
        if muscle_lower and not any(muscle_lower in m.lower() for m in ex["muscles"]):
            return False
        if equipment_lower and not any(equipment_lower in eq.lower() for eq in ex["equipment"]):
            return False
        return True

    return [ex for ex in exercises if matches(ex)][:limit]
