import asyncio
import difflib
import logging
import re
import threading

import httpx

from config import get_settings

logger = logging.getLogger("nutrition_db_service")


def _safe_exc_repr(exc: Exception) -> str:
    """A log-safe description of a failed request — never `str(exc)`
    directly. Live-discovered, security-relevant: httpx.HTTPStatusError's
    own __str__ embeds the FULL request URL, including USDA_API_KEY as a
    plaintext query parameter (`response.raise_for_status()`'s message is
    literally "...for url 'https://.../search?...&api_key=<the real key>'"
    — confirmed directly against this app's own key while building this).
    Logging that verbatim would leak the key into every log
    aggregator/Sentry event a single USDA request failure ever reaches.
    Only the exception type and, for an HTTP status error, the status code
    are ever worth logging here anyway — the URL/params were already known
    to the caller, and the response body (also potentially present on the
    exception) is never trusted content either."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    return type(exc).__name__

# ---------------------------------------------------------------------------
# Grounds an AI-identified food name against a REAL nutrition database
# instead of trusting the model's own recalled memory of that food's macros
# — this is what actually closes the class of bug that prompt-tuning alone
# can only reduce the odds of (e.g. 22g protein for egg whites, 43g protein
# for crispbread): the number now comes from a verified source, not a
# language model's fuzzy training-data recall.
#
# Two sources, each covering what the other doesn't:
#   - USDA FoodData Central: free (needs its own free API key — DEMO_KEY
#     works but is rate-limited to 30/hour, never use it in production),
#     authoritative for generic/raw ingredients. Restricted to
#     Foundation/SR Legacy/Survey (FNDDS) dataTypes — verified live that the
#     unfiltered search ranks US-retail "Branded" entries first (Wegmans,
#     Schnucks, Giant Eagle egg whites, etc.), which is both irrelevant to
#     this app's Romanian users and noisier to match against than the
#     small, curated generic datasets.
#   - Open Food Facts: free, no key needed, authoritative for branded/
#     packaged products. Verified live with real Romanian-market brands —
#     Pirifan, Covalact, Zuzu, and three different Telemea brands
#     (Napolact/Hochland/Ibanesti) all returned complete nutriment data —
#     so this is a genuinely good fit for this app's user base, not just a
#     generically "international" choice. Queried via the newer
#     search.openfoodfacts.org (search-a-licious) endpoint, not the legacy
#     cgi/search.pl — that one 503'd repeatedly under simple sequential
#     testing here, this one didn't.
#
# Both are queried CONCURRENTLY per food name (not sequentially — see
# lookup() below), and the whole two-source lookup is wrapped in a hard time
# budget (_TOTAL_BUDGET_SECONDS) so a slow/degraded external service can
# never meaningfully delay a scan/description response: grounding is a
# best-effort accuracy enhancement layered on top of the existing AI
# pipeline, never a new hard dependency it can fail on. Every failure mode
# here (timeout, HTTP error, no confident match) resolves to returning None,
# and every caller already has an existing AI-estimate fallback path for
# that — see gemini_service.py's estimate_macros_for_food_name and
# _ground_ingredient.
# ---------------------------------------------------------------------------

_TIMEOUT = httpx.Timeout(3.0, connect=2.0)
# 5s, not 4s: gives _search_usda's one-retry-on-failure (see its own
# comment) real room to complete even in the rare case its first attempt
# hits the full connect+read timeout, without changing the fact that this
# is still a hard ceiling — a caller waiting this long for grounding is the
# rare exception, not the common case (a cache hit or a first-try success
# both return far sooner).
_TOTAL_BUDGET_SECONDS = 5.0
_PAGE_SIZE = 5

_USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"
_USDA_DATA_TYPES = "Foundation,SR Legacy,Survey (FNDDS)"
# USDA nutrientNumber strings (stable, documented IDs — not display order,
# which varies per food) for the 7 fields this app tracks per ingredient.
_USDA_NUTRIENT_NUMBERS = {
    "calories_per_100g": "208",
    "protein_per_100g": "203",
    "fats_per_100g": "204",
    "carbs_per_100g": "205",
    "fiber_per_100g": "291",
    "sugar_per_100g": "269",
    "sodium_per_100g": "307",  # milligrams already — matches this app's own sodium unit
}
# The 4 that must be present for a candidate to be usable at all — mirrors
# barcode_lookup.py's reshape_off_product's own required_fields split
# (fiber/sugar/sodium degrade to 0 rather than rejecting the whole match,
# since a lot of real entries are otherwise-complete but missing one of
# these three).
_USDA_REQUIRED = ("calories_per_100g", "protein_per_100g", "fats_per_100g", "carbs_per_100g")

_OFF_SEARCH_URL = "https://search.openfoodfacts.org/search"
_OFF_FIELDS = "product_name,brands,nutriments,code"
_OFF_REQUIRED_NUTRIMENTS = ("energy-kcal_100g", "proteins_100g", "fat_100g", "carbohydrates_100g")

# ---------------------------------------------------------------------------
# Text-matching: turns "does this candidate actually name the same food the
# AI/user meant" into a 0-1 confidence score. Live-tuned against real search
# results before this threshold/formula were picked (see PR discussion) —
# the two failure modes fought against each other:
#   - Reject genuinely correct matches: USDA descriptions are verbose
#     ("Chicken, broilers or fryers, breast, meat only, cooked, roasted"
#     for a plain "chicken breast" query) — naive full-string similarity
#     scores this far too low.
#   - Accept wrong matches: naive word-overlap alone scores "banana" against
#     "Banana chips" at a PERFECT match, because every word in the query
#     appears in the candidate — but chips are fried/dried and have ~5x the
#     calories of the fruit. Same failure for "apple" matching "Apple
#     juice, canned...".
# Fixed by splitting into two independent checks: FORM_CHANGING_WORDS is a
# hard gate for the second failure mode (a small, deliberately curated list
# of words that mean "this is a different product form than a plain food,
# not just a naming variation") — if the candidate has one the query didn't
# ask for, it's rejected outright regardless of every other signal. Once
# past that gate, plain token recall (does the candidate contain every
# meaningful word the query used) handles the first failure mode fine,
# blended lightly with whole-string similarity as a tiebreaker.
# ---------------------------------------------------------------------------
CONFIDENCE_THRESHOLD = 0.5

_STOPWORDS = {
    "raw", "cooked", "fresh", "the", "a", "of", "and", "with", "grade",
    "large", "regular", "or", "only", "added",
}

# Deliberately narrow and food-specific — not a general "processed food"
# detector (that would be both huge and reject a lot of legitimate matches,
# e.g. "cooked" is fine). Each of these changes what the food fundamentally
# IS relative to its plain form, in a way that materially changes its
# macros — that's the bar for adding a new one here, not just "sounds more
# processed".
_FORM_CHANGING_WORDS = {
    "chips", "chip", "juice", "powder", "syrup", "jam", "jelly", "sauce",
    "nuggets", "pudding", "dried", "dehydrated", "candy", "dessert",
    "extract", "concentrate", "paste", "fries", "crisps", "cake", "pie",
    "chocolate", "flavored", "flavoured", "smoothie", "cream", "ice",
    "breaded", "battered", "frosting", "icing", "spread",
    # Added after live-testing against a real USDA key surfaced a genuine
    # miss: a bare "chicken breast" query's top USDA candidates included
    # "Lunchmeat, chicken breast, sliced" (Foundation) and "Chicken breast,
    # roll, oven-roasted" (SR Legacy) — reconstituted/pressed deli-style
    # products, not a plain cut of meat, with meaningfully different macros
    # (134 kcal/14.6g protein per 100g vs a plain cooked chicken breast's
    # ~144-165 kcal/26-31g protein). Same failure class as "banana" vs
    # "banana chips" above, just previously undiscovered because it needed
    # a real (non-rate-limited) USDA key to reproduce.
    "lunchmeat", "luncheon", "roll", "tenders", "deli", "prepackaged",
}

# ---------------------------------------------------------------------------
# Frying is treated separately from _FORM_CHANGING_WORDS above, and
# SYMMETRICALLY (mismatch in EITHER direction rejects), because it's not
# "the candidate names an extra processed thing the query didn't ask for" —
# it's a cooking-METHOD mismatch, and specifically the one cooking method
# whose macro impact (substantial added fat) is large enough to be unsafe
# to cross-match on. Baked/boiled/steamed/roasted/grilled are deliberately
# NOT treated this way — live-verified they all score well against each
# other (0.79-0.83, comfortably above CONFIDENCE_THRESHOLD) and, more
# importantly, are all genuinely similar low-added-fat methods macro-wise,
# so cross-matching among THEM is a non-issue. Frying is not: live-verified
# "fried chicken breast" scored 0.57 (still above threshold) against a
# plain "...cooked, roasted" entry — high enough to have silently used a
# meaningfully lower-fat reference for a fried food if no fried-specific
# candidate had been returned at all. This must reject in BOTH directions
# (query says fried, candidate doesn't, OR the reverse) — either one is a
# real fat/calorie mismatch, not just one of them.
# ---------------------------------------------------------------------------
_FRIED_INDICATOR_WORDS = {"fried", "sauteed"}


# This app's users are Romanian and food names routinely arrive with
# Romanian diacritics (OUTPUT_LANGUAGE: Romanian in gemini_service.py's
# prompts, or the user's own typed description) — live-verified this was a
# real bug, not a theoretical one: without transliterating these first, the
# old `[^a-z0-9\s]` strip treated ă/â/î/ș/ț as punctuation, mangling
# "brânză" into "br nz" and "mămăligă" into "m m lig" (garbage token
# fragments that can't reliably match anything). Also covers ş/ţ, the
# cedilla-below variants some fonts/older encodings use interchangeably
# with the correct comma-below ș/ț — both must transliterate the same way.
# Only lowercase entries: text is already lower()'d (Unicode-aware, so
# Ă/Â/etc. already become ă/â/etc.) before this table is ever applied.
_ROMANIAN_DIACRITIC_MAP = str.maketrans("ăâîșşțţ", "aaisstt")


def _normalize(text: str) -> str:
    text = text.lower().strip()
    text = text.translate(_ROMANIAN_DIACRITIC_MAP)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _stem_set(tokens: set[str]) -> set[str]:
    # Naive singularization (strip a trailing "s" off any token longer than
    # 3 chars) rather than a real stemmer dependency — cheap and enough to
    # fix the single most common miss this caused in testing: "banana" vs
    # "Bananas" / "egg whites" vs "egg white" both scored as a near-total
    # mismatch on raw token equality alone.
    out = set(tokens)
    for token in tokens:
        if len(token) > 3 and token.endswith("s"):
            out.add(token[:-1])
    return out


def _score(query: str, candidate_name: str) -> float:
    """0.0-1.0 confidence that `candidate_name` (a database entry's own
    name/description) names the same food as `query` (the AI-identified or
    user-typed food name). See the module docstring above for the tuning
    story behind this shape."""
    q_norm, c_norm = _normalize(query), _normalize(candidate_name)
    q_words, c_words = set(q_norm.split()), set(c_norm.split())

    if (c_words & _FORM_CHANGING_WORDS) - (q_words & _FORM_CHANGING_WORDS):
        return 0.0
    if bool(q_words & _FRIED_INDICATOR_WORDS) != bool(c_words & _FRIED_INDICATOR_WORDS):
        return 0.0

    q_tokens = _stem_set(q_words - _STOPWORDS)
    c_tokens = _stem_set(c_words - _STOPWORDS)
    if not q_tokens or not c_tokens:
        return 0.0

    recall = len(q_tokens & c_tokens) / len(q_tokens)
    similarity = difflib.SequenceMatcher(None, q_norm, c_norm).ratio()
    return 0.7 * recall + 0.3 * similarity


# ---------------------------------------------------------------------------
# In-memory cache — same shape and reasoning as food_cache_service.py's own
# (nutrition facts don't change, so no expiry, only a size cap with FIFO
# eviction), kept as a SEPARATE cache/module rather than folded into that
# one: this one also caches confirmed NEGATIVE lookups (no confident match
# in either database), which food_cache_service has no equivalent concept
# of, and mixing the two would make food_cache_service's own "every entry
# is a real answer" contract murkier for its other caller
# (estimate_macros_for_food_name's cache of AI answers).
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_MAX_ENTRIES = 1000
_cache: dict[str, dict | None] = {}


def _cache_get(key: str) -> tuple[bool, dict | None]:
    """Returns (was_cached, value) — the bool is what lets a confirmed
    negative (value=None) be distinguished from "never looked up"."""
    with _lock:
        if key in _cache:
            return True, _cache[key]
        return False, None


def _cache_put(key: str, value: dict | None) -> None:
    with _lock:
        if key not in _cache and len(_cache) >= _MAX_ENTRIES:
            _cache.pop(next(iter(_cache)))
        _cache[key] = value


async def _search_usda(query: str, client: httpx.AsyncClient) -> list[tuple[str, dict]]:
    settings = get_settings()
    if not settings.usda_api_key:
        return []

    # One retry after a short delay — live-discovered that api.data.gov's
    # gateway (fronting USDA FoodData Central) occasionally answers a
    # perfectly well-formed request with a bare nginx "400 Bad Request" (no
    # JSON body, no rate-limit-specific status) under rapid sequential
    # querying, unrelated to the documented per-hour quota — reproduced
    # directly against a real, non-rate-limited key while building this.
    # A brief retry is cheap (this whole lookup already has its own
    # _TOTAL_BUDGET_SECONDS ceiling upstream) and turns an intermittent,
    # unrelated-to-this-request throttle into a non-event rather than
    # silently losing USDA for that one lookup.
    data = None
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            response = await client.get(
                _USDA_SEARCH_URL,
                params={
                    "query": query,
                    "pageSize": _PAGE_SIZE,
                    "dataType": _USDA_DATA_TYPES,
                    "api_key": settings.usda_api_key,
                },
            )
            response.raise_for_status()
            data = response.json()
            break
        except (httpx.HTTPError, ValueError) as exc:
            last_exc = exc
            if attempt == 0:
                await asyncio.sleep(0.4)
    if data is None:
        logger.warning("USDA FoodData Central search failed for %r: %s", query, _safe_exc_repr(last_exc))
        return []

    results = []
    for food in data.get("foods", []):
        description = food.get("description")
        if not description:
            continue
        nutrients = {
            n.get("nutrientNumber"): n.get("value") for n in food.get("foodNutrients", []) if n.get("value") is not None
        }
        macros = {
            field: nutrients[num] for field, num in _USDA_NUTRIENT_NUMBERS.items() if num in nutrients
        }
        if not all(field in macros for field in _USDA_REQUIRED):
            continue
        results.append((description, {"food_name": description, "source": "usda", **macros}))
    return results


async def _search_off(query: str, client: httpx.AsyncClient) -> list[tuple[str, dict]]:
    try:
        response = await client.get(
            _OFF_SEARCH_URL,
            params={"q": query, "page_size": _PAGE_SIZE, "fields": _OFF_FIELDS},
            headers={"User-Agent": "IronLog/1.0 (nutrition-grounding; contact via app)"},
        )
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        # No API key involved here (Open Food Facts needs none), but
        # _safe_exc_repr is used for the same reason it is in _search_usda:
        # one consistent, never-embeds-a-URL logging pattern for every
        # external call in this module, rather than trusting each call site
        # to remember the distinction on its own.
        logger.warning("Open Food Facts search failed for %r: %s", query, _safe_exc_repr(exc))
        return []

    results = []
    for product in data.get("hits", []):
        name = (product.get("product_name") or "").strip()
        nutriments = product.get("nutriments") or {}
        if not name or any(nutriments.get(field) is None for field in _OFF_REQUIRED_NUTRIMENTS):
            continue
        # search.openfoodfacts.org (search-a-licious) returns `brands` as a
        # LIST (e.g. ["Balticovo"]) — a real, live-discovered difference
        # from the legacy cgi/search.pl endpoint, which returns the same
        # field as a single comma-joined string. Handle both shapes rather
        # than assuming either.
        raw_brands = product.get("brands") or ""
        brand = (", ".join(raw_brands) if isinstance(raw_brands, list) else raw_brands).strip()
        display_name = f"{name} ({brand})" if brand else name
        # Open Food Facts reports sodium in GRAMS (derived from salt_100g /
        # 2.5) — this app's sodium field is milligrams throughout (see
        # barcode_lookup.py's reshape_off_product, which does the identical
        # conversion for the barcode-scan path).
        sodium_g = nutriments.get("sodium_100g")
        macros = {
            "calories_per_100g": nutriments["energy-kcal_100g"],
            "protein_per_100g": nutriments["proteins_100g"],
            "fats_per_100g": nutriments["fat_100g"],
            "carbs_per_100g": nutriments["carbohydrates_100g"],
            "fiber_per_100g": nutriments.get("fiber_100g", 0) or 0,
            "sugar_per_100g": nutriments.get("sugars_100g", 0) or 0,
            "sodium_per_100g": (sodium_g * 1000) if sodium_g is not None else 0,
        }
        results.append((display_name, {"food_name": name, "source": "openfoodfacts", **macros}))
    return results


# Tie-break preference for USDA's generic/raw data over an Open Food Facts
# branded match — applied ONLY as a ranking preference AMONG candidates that
# already independently clear CONFIDENCE_THRESHOLD on their own raw _score
# (see the eligible-filter in _lookup_uncached below); it can shift which
# already-good candidate wins, but can never rescue one that fails the bar
# alone, and can never cause a good candidate to be discarded in favor of a
# bad one either.
#
# Live-discovered reason this exists: a plain "chicken breast" query matches
# several genuinely different Open Food Facts branded products at once
# (Coles 92 kcal/100g, Tesco 106, Kirkland 98, a spiced/marinated one at
# 181) — none of which represent what a user means logging a home-cooked
# meal, which USDA's single "Chicken, breast, meat only, cooked, roasted"
# (~165 kcal/100g) does directly. USDA's own verbose naming style scores
# meaningfully lower than an OFF product's short, exact-looking name on raw
# text similarity alone (0.82 vs 1.0 for this exact case) despite being the
# better answer, which is why this needs to be a deliberately sizeable
# bonus (0.25), not a hair's-width tie-break — verified against that live
# gap, not picked arbitrarily. Trade-off, stated plainly: this can
# occasionally let USDA win over a genuinely correct OFF branded match when
# the two scores are close (within ~0.25 of each other) — accepted because
# the failure mode it fixes (silently substituting an arbitrary specific
# commercial product's macros for a plain generic ingredient) is worse and
# far more common than the reverse for this app's actual use (logging a
# food, not identifying a specific SKU). Open Food Facts still wins
# outright whenever USDA has no eligible entry at all (Telemea, Covalact,
# Pirifan, most home-cooked dishes, anything genuinely branded) — that's
# most of what makes Open Food Facts worth having in the first place.
_USDA_TIE_BREAK_BONUS = 0.25

# ---------------------------------------------------------------------------
# KNOWN RESIDUAL LIMITATION, live-discovered while building this and worth
# being explicit about rather than silently living with: this bonus only
# helps when USDA actually returns a candidate. If USDA_API_KEY is unset,
# rate-limited, or transiently down, a bare ambiguous-preparation staple
# query (e.g. "rice", "pasta", "potato" with no "cooked"/"raw" qualifier)
# falls back to Open Food Facts alone — which, being a PACKAGED-PRODUCT
# database, mostly holds dry/uncooked goods (that's what's sold on a
# shelf), so it can confidently match a real product whose macros are for
# the RAW form when the AI's own weight_g estimate assumed the COOKED form
# (raw rice is ~3x denser in calories than cooked rice per equal gram) —
# live-verified: a bare "White rice" query against Open Food Facts alone
# top-matched a dry packaged rice product at 310 kcal/100g, when the
# correct cooked-rice value is ~130 kcal/100g. Confirmed this specific case
# resolves correctly once USDA is in the running (its own "Rice, white,
# ..., cooked" entry scores 0.83 + this bonus = 1.08, comfortably beating
# Open Food Facts' best candidate at 0.88) — so the practical mitigation is
# operational, not algorithmic: use a real, non-rate-limited USDA_API_KEY in
# production (DEMO_KEY's 30/hour ceiling is trivially exhausted and was
# exactly what surfaced this during testing). Not fixed with a query-side
# "append cooked" heuristic here on principle: that couldn't have been
# live-verified against a fresh USDA key in the same session that
# discovered it, and shipping an unverified heuristic on top of a
# nutrition-accuracy feature is exactly the kind of shortcut this feature
# exists to move away from.
# ---------------------------------------------------------------------------


def _rank(food_name: str, candidate: tuple[str, dict]) -> float:
    name, data = candidate
    bonus = _USDA_TIE_BREAK_BONUS if data.get("source") == "usda" else 0.0
    return _score(food_name, name) + bonus


async def _lookup_uncached(food_name: str) -> dict | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        usda_results, off_results = await asyncio.gather(
            _search_usda(food_name, client), _search_off(food_name, client)
        )

    candidates = usda_results + off_results
    eligible = [pair for pair in candidates if _score(food_name, pair[0]) >= CONFIDENCE_THRESHOLD]
    if not eligible:
        return None

    _, best_data = max(eligible, key=lambda pair: _rank(food_name, pair))
    return best_data


async def lookup(food_name: str) -> dict | None:
    """Returns a verified per-100g macro dict — {food_name, source,
    calories_per_100g, protein_per_100g, carbs_per_100g, fats_per_100g,
    fiber_per_100g, sugar_per_100g, sodium_per_100g} — for a confident
    database match, or None (never raises) if grounding is disabled, no
    candidate cleared the confidence threshold, or the lookup couldn't
    complete within budget. `source` is "usda" or "openfoodfacts",
    informational only — callers don't need to branch on it."""
    settings = get_settings()
    if not settings.nutrition_db_grounding_enabled:
        return None

    key = _normalize(food_name)
    was_cached, cached_value = _cache_get(key)
    if was_cached:
        return cached_value

    try:
        result = await asyncio.wait_for(_lookup_uncached(food_name), timeout=_TOTAL_BUDGET_SECONDS)
    except Exception as exc:  # noqa: BLE001 - genuinely must never propagate, see module docstring
        # _safe_exc_repr here too, defensively: _search_usda/_search_off
        # already catch and swallow httpx errors themselves, so nothing
        # URL-bearing should reach this broad except in practice — but this
        # is exactly the kind of catch-all that a future code change could
        # silently start routing one through, and the cost of guarding
        # against that here is zero.
        logger.warning("Nutrition database lookup failed/timed out for %r: %s", food_name, _safe_exc_repr(exc))
        return None  # deliberately NOT cached — a transient failure shouldn't become permanent

    _cache_put(key, result)
    return result
