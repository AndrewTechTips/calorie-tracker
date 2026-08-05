import asyncio
import logging

import httpx
from fastapi import APIRouter, Depends, Query, Request, Response

from auth import get_current_user
from data.discover_data import RECIPES, WORKOUT_PLANS
from models import ExerciseResult, RecipeResult, ScanResult, WorkoutPlanResult
from rate_limit import limiter
from services import exercise_cache_service
from services.barcode_lookup import fetch_product_by_code

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
    return {
        **item,
        "name": item["name"][lang],
        "ingredients": item["ingredients"][lang],
        "instructions": item["instructions"][lang],
    }


def _localize_plan(item: dict, language: str) -> dict:
    lang = _lang(language)
    return {
        **item,
        "name": item["name"][lang],
        "days": [{**day, "label": day["label"][lang]} for day in item["days"]],
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

    `response: Response` here (and on every other route in this file) is
    required even though this route already returns a plain list via
    response_model= — verified directly while building this that
    rate_limit.py's documented "only routes using key_func=rate_limit_key
    need this" isn't the whole story: every route decorated with
    @limiter.limit(...) needs it to avoid slowapi's post-call header
    injection crashing with "parameter `response` must be an instance of
    starlette.responses.Response" on a genuine 2xx response, regardless of
    key_func. Worth revisiting that comment separately."""
    results = [_localize_recipe(r, language) for r in RECIPES]
    if tag:
        tag_lower = tag.strip().lower()
        results = [r for r in results if tag_lower in [t.lower() for t in r["tags"]]]
    if search:
        search_lower = search.strip().lower()
        results = [r for r in results if search_lower in r["name"].lower()]
    return [RecipeResult(**r) for r in results]


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
    params don't actually work as documented, verified directly)."""
    results = await exercise_cache_service.search_exercises(q, muscle, equipment, limit=30)
    return [ExerciseResult(**r) for r in results]


async def _search_off_candidates(query: str, limit: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=_OFF_SEARCH_TIMEOUT, headers={"User-Agent": _USER_AGENT}) as client:
        response = await client.get(
            _OFF_SEARCH_URL,
            params={"q": query, "page_size": max(limit * 2, 20), "fields": "code,product_name,countries_tags"},
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
    user=Depends(get_current_user),
):
    """Open Food Facts product search — see module docstring above for why
    this is a two-step search-then-fetch-full-record design. Results whose
    `countries_tags` matches `country` (e.g. "romania") are ranked first —
    done here in Python rather than via an upstream country filter param,
    since that param is also silently ignored by the search API (verified);
    every other result still shows, just after the country-matched ones,
    rather than filtering them out entirely."""
    try:
        candidates = await _search_off_candidates(q, _MAX_PRODUCT_SEARCH_RESULTS)
    except httpx.HTTPError:
        logger.warning("Open Food Facts search failed for query %r", q)
        return []

    if country:
        country_lower = country.strip().lower()
        candidates.sort(key=lambda hit: country_lower not in " ".join(hit.get("countries_tags") or []).lower())

    codes = [hit["code"] for hit in candidates if hit.get("code")][:_MAX_PRODUCT_SEARCH_RESULTS]
    products = await asyncio.gather(*(fetch_product_by_code(code) for code in codes), return_exceptions=True)

    results: list[ScanResult] = []
    for product in products:
        if isinstance(product, Exception) or product is None:
            continue
        results.append(product)
    return results
