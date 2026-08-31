import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from auth import get_current_user
from config import get_settings
from data.discover_data import POPULAR_EXERCISES, RECIPES, WORKOUT_PLANS, exercise_how_to
from database import get_supabase
from models import DiscoverActivityResponse, ExerciseResult, RecipeResult, ScanResult, WorkoutPlanResult
from rate_limit import limiter
from services import discover_service, exercise_cache_service
from services.barcode_lookup import fetch_product_by_code
from services.db_tolerance import UNDEFINED_COLUMN_CODES

logger = logging.getLogger("discover")

router = APIRouter(prefix="/discover", tags=["discover"])

_SUPPORTED_LANGUAGES = ("en", "ro")


def _lang(language: str | None) -> str:
    return language if language in _SUPPORTED_LANGUAGES else "en"


def _localize_recipe(item: dict, language: str) -> dict:
    """Picks one language out of a recipe's bilingual `name`/`ingredients`/
    `instructions` dicts (see data/discover_data.py's module docstring) —
    RecipeResult itself stays a flat, single-language shape."""
    lang = _lang(language)
    tagline = item.get("tagline")
    return {
        **item,
        "name": item["name"][lang],
        "tagline": tagline[lang] if tagline else None,
        "ingredients": item["ingredients"][lang],
        "instructions": item["instructions"][lang],
    }


def _localize_plan(item: dict, language: str) -> dict:
    lang = _lang(language)
    return {
        **item,
        "name": item["name"][lang],
        "days": [
            {
                **day,
                "label": day["label"][lang],
                # Short how-to cue per exercise, in the same language as
                # everything else in this plan (see data/discover_data.py's
                # EXERCISE_HOW_TO) — a static photo alone often doesn't show
                # the actual movement, this is the text fallback/companion.
                "exercises": [{**ex, "description": exercise_how_to(ex["name"], lang)} for ex in day["exercises"]],
            }
            for day in item["days"]
        ],
    }

# Same reasoning as barcode.py: free, keyless, no quota tracking needed
# beyond defensive rate limiting so one client can't hammer either upstream
# API through this backend.
_OFF_SEARCH_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
# search.openfoodfacts.org (the "search-a-licious" service) is Open Food
# Facts' actual working full-text search — verified directly against the
# live APIs while building this: the documented REST endpoint
# (world.openfoodfacts.org/api/v2/search?search_terms=...) silently ignores
# search_terms and returns the entire unfiltered database; the legacy
# world.openfoodfacts.org/cgi/search.pl full-text endpoint returned a
# "temporarily unavailable" block on every attempt. This one returns
# genuinely relevant, ranked results. It's a lean search index though (no
# nutrition data in its own response), so this is a two-step lookup: search
# here for matching barcodes, then fetch each one's full nutrition data via
# the same world.openfoodfacts.org/api/v2/product/{code}.json endpoint
# barcode.py already uses.
_OFF_SEARCH_URL = "https://search.openfoodfacts.org/search"
_USER_AGENT = "IronLog-Backend/1.0 (calorie tracker; contact via app store listing)"
_MAX_PRODUCT_SEARCH_RESULTS = 12
# See its use in search_products below — caps how many of the per-candidate
# product-detail lookups run at once, well under the point Open Food Facts'
# product endpoint starts responding 429 to its own bursts.
_off_product_semaphore = asyncio.Semaphore(4)


@router.get("/recipes", response_model=list[RecipeResult])
@limiter.limit("30/minute;10/10 seconds")
async def list_recipes(
    request: Request,
    response: Response,
    tag: str | None = Query(default=None),
    search: str | None = Query(default=None, max_length=100),
    language: str = Query(default="en", max_length=5),
    user=Depends(get_current_user),
):
    """Curated static catalog (backend/data/discover_data.py) — filtered
    in-process, not a database query, since this is small, fixed content.
    Localized to `language` (see `_localize_recipe` above) before tag/search
    filtering runs, so `search` matches against whichever language the
    frontend is currently displaying rather than always against English.

    `response: Response` here (and every other route in this file) is
    required by every @limiter.limit(...) route — see rate_limit.py's
    "SECOND gotcha" comment."""
    results = [_localize_recipe(r, language) for r in RECIPES]
    if tag:
        tag_lower = tag.strip().lower()
        results = [r for r in results if tag_lower in [t.lower() for t in r["tags"]]]
    if search:
        search_lower = search.strip().lower()
        results = [r for r in results if search_lower in r["name"].lower()]
    return [RecipeResult(**r) for r in results]


@router.get("/activity", response_model=DiscoverActivityResponse)
@limiter.limit("30/minute;10/10 seconds")
async def discover_activity(
    request: Request,
    response: Response,
    user=Depends(get_current_user),
):
    """Read-time "closing the loop" rollup for the Discover tab (Phase 2):
    the "X of N cooked" counter + the "Your rotation" re-log rail, both
    derived from daily_logs.discover_recipe_id over the retained window (no
    new table — see services/discover_service.py's module docstring).

    Because daily_logs is retention-capped (settings.retention_days, 7 by
    default), `cooked_count` is "cooked recently", not all-time — the same
    window cap streaks and trends already carry, and an accepted consequence
    of the deliberate one-nullable-column design.

    Degrades to an all-zero payload (never 500s) on a project whose
    daily_logs table hasn't had the discover_recipe_id migration run yet —
    same graceful-pre-migration posture as db_tolerance.write_tolerant."""
    retention_days = get_settings().retention_days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    supabase = get_supabase()

    def _query():
        return (
            supabase.table("daily_logs")
            .select("discover_recipe_id,logged_at")
            .eq("user_id", user.id)
            .gte("logged_at", cutoff)
            .not_.is_("discover_recipe_id", "null")
            .execute()
        )

    try:
        result = await run_in_threadpool(_query)
        rows = result.data or []
    except APIError as exc:
        # discover_recipe_id not migrated on this project yet — treat as
        # "nothing cooked from Discover" rather than failing the tab.
        if exc.code not in UNDEFINED_COLUMN_CODES:
            raise
        rows = []

    return DiscoverActivityResponse(**discover_service.summarize_activity(rows, total_recipes=len(RECIPES)))


@router.get("/workout-plans", response_model=list[WorkoutPlanResult])
@limiter.limit("30/minute;10/10 seconds")
async def list_workout_plans(
    request: Request,
    response: Response,
    level: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    language: str = Query(default="en", max_length=5),
    user=Depends(get_current_user),
):
    """Same curated-static-catalog pattern as /discover/recipes above. `tag`
    (e.g. "bulk"/"cut"/"maintain") is a separate filter from `level` —
    a plan's `level` is a difficulty/experience axis, `tag` is a goal-phase
    axis, and either or both can be applied together."""
    results = WORKOUT_PLANS
    if level:
        level_lower = level.strip().lower()
        results = [p for p in results if p["level"].lower() == level_lower]
    if tag:
        tag_lower = tag.strip().lower()
        results = [p for p in results if tag_lower in [t.lower() for t in p["tags"]]]
    return [WorkoutPlanResult(**_localize_plan(p, language)) for p in results]


@router.get("/exercises/search", response_model=list[ExerciseResult])
@limiter.limit("20/minute;6/10 seconds")
async def search_exercises_route(
    request: Request,
    response: Response,
    q: str = Query(default="", max_length=100),
    muscle: str | None = Query(default=None, max_length=60),
    equipment: str | None = Query(default=None, max_length=100),
    user=Depends(get_current_user),
):
    """Proxies wger.de's exercise library (see services/exercise_cache_service.py
    for why this is a bulk-fetch-and-cache-then-filter-locally design rather
    than a live per-request search call — wger's own search/filter query
    params don't actually work as documented, verified directly).

    An empty `q` (the Discover exercise tab's default, before the user has
    typed anything) returns the curated POPULAR_EXERCISES list instead of an
    empty/unfiltered wger dump — a hand-picked, hand-verified-photo set of
    the movements most people actually look for (see that list's own
    comment in data/discover_data.py for why wger's own default view isn't
    good enough to lead with). `muscle`/`equipment` still filter it the same
    way they'd filter a live search, for consistency."""
    # Exercise names/categories/muscles are never localized anywhere in this
    # feature (curated + wger content alike is English-only) — descriptions
    # follow that same existing convention rather than partially localizing
    # just this one field, so this stays "en" regardless of UI language.
    if not q.strip():
        results = POPULAR_EXERCISES
        muscle_lower = (muscle or "").strip().lower()
        equipment_lower = (equipment or "").strip().lower()
        if muscle_lower:
            results = [ex for ex in results if any(muscle_lower in m.lower() for m in ex["muscles"])]
        if equipment_lower:
            results = [ex for ex in results if any(equipment_lower in eq.lower() for eq in ex["equipment"])]
        return [ExerciseResult(**ex, description=exercise_how_to(ex["name"])) for ex in results]
    results = await exercise_cache_service.search_exercises(q, muscle, equipment, limit=30)
    return [
        ExerciseResult(**{**r, "description": r.get("description") or exercise_how_to(r["name"])}) for r in results
    ]


async def _search_off_candidates(query: str, limit: int, langs: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=_OFF_SEARCH_TIMEOUT, headers={"User-Agent": _USER_AGENT}) as client:
        response = await client.get(
            _OFF_SEARCH_URL,
            params={
                "q": query,
                "langs": langs,
                "page_size": max(limit * 2, 20),
                "fields": "code,product_name,countries_tags",
            },
        )
    response.raise_for_status()
    return response.json().get("hits", [])


@router.get("/products/search", response_model=list[ScanResult])
@limiter.limit("20/minute;6/10 seconds")
async def search_products(
    request: Request,
    response: Response,
    q: str = Query(min_length=1, max_length=100),
    country: str | None = Query(default=None, max_length=60),
    language: str = Query(default="en", max_length=5),
    user=Depends(get_current_user),
):
    """Open Food Facts product search — see module docstring above for why
    this is a two-step search-then-fetch-full-record design. Results whose
    `countries_tags` matches `country` (e.g. "romania") are ranked first —
    done here in Python rather than via an upstream country filter param,
    since that param is also silently ignored by the search API (verified);
    every other result still shows, just after the country-matched ones,
    rather than filtering them out entirely.

    `language` matters more than it looks: search-a-licious (the underlying
    search engine) defaults to matching ONLY the `.en`-suffixed fields
    (`product_name.en`, `generic_name.en`, etc) regardless of what the query
    text actually is — verified directly against the live API. A product
    whose only name is in Romanian (this app's primary non-English audience)
    can be entirely invisible to a query typed in Romanian unless the
    request explicitly asks for that language's fields via `langs`. Passing
    `langs=<language>,en` searches both — the user's current UI language
    (wherever they're actually typing) plus English as a fallback/supplement
    (many OFF products only ever get an English name), rather than always
    silently defaulting to English-only regardless of the query language.
    `en,en` when language is already "en" is harmless (OFF de-dupes it)."""
    langs = f"{_lang(language)},en"
    try:
        candidates = await _search_off_candidates(q, _MAX_PRODUCT_SEARCH_RESULTS, langs)
    except httpx.HTTPError:
        logger.warning("Open Food Facts search failed for query %r", q)
        return []

    if country:
        country_lower = country.strip().lower()
        candidates.sort(key=lambda hit: country_lower not in " ".join(hit.get("countries_tags") or []).lower())

    codes = [hit["code"] for hit in candidates if hit.get("code")][:_MAX_PRODUCT_SEARCH_RESULTS]
    # Capped concurrency, not asyncio.gather(*(...)) fired all at once —
    # verified directly that Open Food Facts' single-product endpoint
    # (world.openfoodfacts.org/api/v2/product/{code}.json, a DIFFERENT host
    # from the search-a-licious search above) starts returning 429s of its
    # own once ~6+ requests land on it in the same instant, which
    # fetch_product_by_code (via query_off_by_code) treats as a transport
    # failure and silently drops from these results — good candidates the
    # search itself found correctly were vanishing from what the user saw,
    # for a reason that had nothing to do with search relevance. A small
    # semaphore keeps this well under that threshold without meaningfully
    # slowing down a 12-candidate search.
    async def _fetch_limited(code: str) -> ScanResult | None:
        async with _off_product_semaphore:
            return await fetch_product_by_code(code)

    products = await asyncio.gather(*(_fetch_limited(code) for code in codes), return_exceptions=True)

    results: list[ScanResult] = []
    for product in products:
        if isinstance(product, Exception) or product is None:
            continue
        results.append(product)
    return results
