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
# Only what's actually read below — brands/code were requested by an
# earlier version that used the brand for display/scoring (removed, see
# _search_off's own comment: scoring against a brand-annotated name broke
# virtually every branded match) and code was never used at all.
_OFF_FIELDS = "product_name,nutriments"
_OFF_REQUIRED_NUTRIMENTS = ("energy-kcal_100g", "proteins_100g", "fat_100g", "carbohydrates_100g")

# ---------------------------------------------------------------------------
# Text-matching: turns "does this candidate actually name the same food the
# AI/user meant" into a 0-1 confidence score.
#
# ARCHITECTURE NOTE (read this before adding another word to any list
# below): an earlier version of this gate used a BLOCKLIST of "dangerous"
# words (chips, juice, nuggets, roll, lunchmeat, ...) — rejecting a
# candidate only if it contained one of them. That approach is fundamentally
# unbounded: a 51-food live battery against real search results (see
# commit/PR history) surfaced over a dozen further wrong matches the
# blocklist had no entry for — "Yogurt, Greek, with oats", "Egg white
# sandwich", "Bacon bits", "Soup, tomato", "Coffee, Cuban", "Cottage cheese,
# farmer's", composite dishes like "Spanish rice with ground beef" — because
# there is no bounded list of every dish/product-qualifier noun in the
# world. Continuing to add words one discovered miss at a time is exactly
# the "patch on patch" failure mode worth naming and stopping.
#
# Replaced with the inverse, standard security-engineering principle for an
# unbounded input space: an ALLOWLIST beats a blocklist. _SAFE_DESCRIPTOR_
# WORDS below is a bounded, learnable vocabulary of cooking methods, cuts,
# and quality/grade descriptors that do NOT represent a different food —
# genuinely finite, unlike "every possible dish name". Any word in the
# candidate that isn't in the query AND isn't on this list is now treated as
# an unexplained extra ingredient/product and rejects the match outright
# (_score's "extra" check below). Verified this single change catches 12 of
# the 13 wrong matches found in that battery, while every previously-correct
# match (verbose USDA descriptions included) still passes, because their
# "extra" words are all genuine cooking-method/cut descriptors.
#
# The one case the allowlist can't catch on its own: "oats" matching "Oats,
# raw" is a textually PERFECT match — "raw" isn't unexplained extra content,
# it's the preparation state itself, and a bare grain/legume query is
# usually intended as its COOKED form (nobody logs a bowl of dry oats).
# _DRY_STAPLE_FOODS below is a second, narrow, bounded rule for exactly this
# — see its own comment.
# ---------------------------------------------------------------------------
CONFIDENCE_THRESHOLD = 0.5

_STOPWORDS = {
    "raw", "cooked", "fresh", "the", "a", "of", "and", "with", "grade",
    "large", "regular", "or", "only", "added",
}

# Cooking methods, cuts, and quality/grade descriptors — genuinely a
# food-science vocabulary with real (if not perfectly exhaustive) bounds,
# unlike "every product/dish qualifier a database entry might use". Live-
# verified against every match (good and bad) found across a 51-food battery
# spanning meat, dairy, grains, produce, legumes, nuts, and Romanian dishes —
# see _score's own docstring for two cases DELIBERATELY left unlisted
# despite being legitimate misses (olive oil's "salad"/"cooking" qualifiers,
# salmon's "Atlantic") and why.
_SAFE_DESCRIPTOR_WORDS = {
    # cooking/preparation methods
    "raw", "cooked", "roasted", "baked", "boiled", "grilled", "steamed",
    "poached", "broiled", "braised", "stewed", "toasted", "seared", "uncooked",
    # cuts, parts, packaging, quality/grade descriptors
    "boneless", "skinless", "bone", "skin", "flesh", "fresh", "frozen", "canned",
    "whole", "lean", "extra", "grade", "medium", "small", "ns",
    "nfs", "ready", "eat", "cut", "sliced", "chopped", "ground", "diced",
    "trimmed", "meat", "broiler", "fryer", "farmed", "wild", "drained",
    "unsweetened", "plain", "natural", "organic", "regular", "hard", "soft",
    # NOTE: deliberately NO color words here (white/brown/red/green/yellow)
    # despite "white rice"/"brown rice" being common, legitimate queries —
    # live-discovered this was actively dangerous, not just unnecessary: a
    # bare "egg" query scored 0.76 (confidently over threshold) against
    # "Eggs, Grade A, Large, egg white" once "white" was treated as a
    # harmless color descriptor, silently substituting egg WHITE's macros
    # (~52 kcal/11g protein/0g fat) for a WHOLE egg (~155 kcal/13g protein/
    # 11g fat) — recreating a variant of the exact bug this whole feature
    # exists to fix. For eggs, "white" denotes a COMPONENT (just the
    # albumen), not a color, the same danger class as "fried" above. Color
    # words are NOT needed in this list anyway: "white rice"/"brown rice"
    # already state their own color in the query itself, so it's never
    # "extra" content there — this list only matters for words present in
    # the CANDIDATE but absent from the query, and no legitimate match in
    # testing ever needed an unstated color to pass.
    "long", "grain", "short",
    "low", "fat", "nonfat", "free", "reduced", "full", "fine", "coarse", "style",
    "large", "cracker", "rye", "wheat",
    # Romanian equivalent of "organic" — live-verified as a real Open Food
    # Facts qualifier ("Fulgi de ovăz bio", a real Pirifan product found
    # while testing this app's actual Romanian-market coverage). This app
    # is bilingual (EN/RO) and its own prompts can emit either language, so
    # a query/candidate pair can legitimately be all-Romanian — this single
    # entry is a known, deliberately NOT comprehensive start on that, not a
    # claim of full EN/RO parity across every descriptor in this list.
    "bio",
}

# ---------------------------------------------------------------------------
# Frying is treated separately from the allowlist above, and SYMMETRICALLY
# (mismatch in EITHER direction rejects), because it's not "the candidate
# names an extra thing the query didn't ask for" — it's a cooking-METHOD
# mismatch, and specifically the one cooking method whose macro impact
# (substantial added fat) is large enough to be unsafe to cross-match on.
# "roasted" is deliberately IN the safe-descriptor allowlist above (baked/
# boiled/steamed/roasted/grilled are genuinely similar, low-added-fat
# methods — live-verified they score well against each other, 0.79-0.83, and
# that's fine, cross-matching among them is a non-issue) — which is exactly
# why frying needs its OWN check: live-verified "fried chicken breast"
# scored 0.57 (still above threshold) against a plain "...cooked, roasted"
# entry, since "roasted" being allowlisted doesn't flag anything by itself.
# This must reject in BOTH directions (query says fried, candidate doesn't,
# OR the reverse) — either one is a real fat/calorie mismatch.
# ---------------------------------------------------------------------------
_FRIED_INDICATOR_WORDS = {"fried", "sauteed"}

# ---------------------------------------------------------------------------
# A small, bounded, well-justified list of dry starches/grains/legumes that
# are essentially NEVER eaten raw/dry in normal use. Unlike every rule
# above, this doesn't check for unexplained EXTRA content — "Oats, raw" is a
# textually perfect match for "oats", the mismatch is that a bare grain/
# legume query almost always means the COOKED, water-absorbed form (nobody
# logs a bowl of dry oats), and cooked-vs-dry is a large, systematic density
# difference (dry oats ~379 kcal/100g vs cooked oatmeal ~70 kcal/100g — a
# cooked bowl scaled against the dry reference would overstate calories by
# roughly 5x). Live-verified this is real, not theoretical, for oats; the
# identical mechanism was already independently found and documented for
# rice (see _USDA_TIE_BREAK_BONUS's own comment).
#
# Deliberately conservative in the safe direction: REQUIRES an explicit
# cooked-state word in the candidate for one of these foods, rather than
# just excluding candidates that say "raw" — a plain packaged product name
# like "White Rice (Annie Chun's)" states neither "raw" nor "cooked" at all,
# and is dry by default (that's what's sold on a shelf), so silence must
# also be treated as unresolved rather than assumed safe. This costs real
# coverage (e.g. a genuinely correct, cooked Open Food Facts "Quinoa" entry
# with no explicit "cooked" in its name now falls back to the AI estimate
# instead of grounding) — accepted deliberately: for foods where the wrong
# guess is a ~5x error, "fall back to the AI's estimate" is a strictly safer
# default than "assume unstated is fine".
# ---------------------------------------------------------------------------
_DRY_STAPLE_FOODS = {
    "rice", "oat", "oats", "oatmeal", "pasta", "quinoa", "barley", "couscous",
    "lentil", "lentils", "bulgur", "millet", "buckwheat", "bean", "beans",
    "chickpea", "chickpeas",
}
_COOKED_STATE_WORDS = {"cooked", "boiled", "steamed", "prepared"}
_RAW_STATE_WORDS = {"raw", "dry", "dried", "uncooked"}


def _is_missing_cooked_state(query_tokens: set[str], query_words: set[str], candidate_words: set[str]) -> bool:
    """`query_tokens` is the canonicalized (stopword-stripped) set used for
    the _DRY_STAPLE_FOODS check; `query_words` MUST be the raw, un-stripped
    word set for the _RAW_STATE_WORDS check specifically — "raw"/"cooked"/
    "uncooked" are themselves in _STOPWORDS (needed elsewhere so they don't
    count as "unexplained extra content" in _score's allowlist gate), so a
    stopword-stripped set can never contain them and a query like "raw
    oats" would silently fail to register as an explicit raw request.
    Verified live this was a real bug before this split, not theoretical."""
    if not (query_tokens & _DRY_STAPLE_FOODS):
        return False  # rule doesn't apply to this food at all
    if query_words & _RAW_STATE_WORDS:
        return False  # user explicitly asked for the raw/dry form
    return not (candidate_words & _COOKED_STATE_WORDS)


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


def _singularize(word: str) -> str:
    # Naive singularization (strip a trailing "s" off any token longer than
    # 3 chars, guarding "ss" endings like "swiss"/"grass") rather than a real
    # stemmer dependency. CANONICALIZES to one form, rather than an earlier
    # version of this function that kept both the original and the singular
    # side by side — that shape works fine for a pure overlap/recall check,
    # but is wrong for the "unexplained extra content" gate in _score below:
    # verified live that it let "broilers"/"fryers" (present in the safe
    # list) leave a stray unmatched "broiler"/"fryer" singular behind,
    # nearly causing a good match ("chicken breast" vs the full USDA
    # description) to be wrongly rejected. Canonicalizing both the query and
    # candidate to the same singular form up front avoids that whole class
    # of self-inflicted mismatch.
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _canonical_tokens(text: str) -> set[str]:
    return {_singularize(w) for w in set(_normalize(text).split()) - _STOPWORDS}


_SAFE_DESCRIPTOR_TOKENS = {_singularize(w) for w in _SAFE_DESCRIPTOR_WORDS}


def _score(query: str, candidate_name: str) -> float:
    """0.0-1.0 confidence that `candidate_name` (a database entry's own
    name/description) names the same food as `query` (the AI-identified or
    user-typed food name). See the module docstring above for the
    allowlist-vs-blocklist architecture story behind this shape.

    Two cases are DELIBERATELY not fixed, on purpose, not by oversight:
    "olive oil" vs "Oil, olive, salad or cooking" (rejected — "salad"/
    "cooking" aren't allowlisted) and "salmon" vs "Atlantic salmon"
    (rejected — "atlantic" isn't allowlisted). Both could be fixed by
    allowlisting those specific words, but "salad" also appears in
    genuinely different composite dishes this app must keep rejecting
    (chicken salad, potato salad, egg salad — mayo-based dishes with very
    different macros from the plain ingredient) and "atlantic"/geographic
    qualifiers broadly would reopen exactly the hole "Cuban coffee" (a
    sweetened variant, not plain coffee) needed closed. Both rejections
    fall back to the AI's own estimate, which is already reliable for pure
    oils and common fish — an acceptable, deliberate coverage trade-off
    against reopening a real, already-fixed failure mode."""
    q_norm, c_norm = _normalize(query), _normalize(candidate_name)
    q_words, c_words = set(q_norm.split()), set(c_norm.split())

    if bool(q_words & _FRIED_INDICATOR_WORDS) != bool(c_words & _FRIED_INDICATOR_WORDS):
        return 0.0

    q_tokens = _canonical_tokens(query)
    c_tokens = _canonical_tokens(candidate_name)
    if not q_tokens or not c_tokens:
        return 0.0

    if _is_missing_cooked_state(q_tokens, q_words, c_words):
        return 0.0

    # The core allowlist gate: any candidate word not explained by the
    # query itself or a known-safe descriptor is treated as an unexplained
    # extra ingredient/product and rejects the match outright, regardless
    # of how well everything else lines up.
    if c_tokens - q_tokens - _SAFE_DESCRIPTOR_TOKENS:
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
        # The tuple's first element is what _score() actually matches
        # against — MUST be the plain product name, never a brand-annotated
        # one. A brand-appended "Mozzarella (Kirkland)" was live-verified to
        # break virtually every branded Open Food Facts match under the
        # allowlist gate below: the brand name is essentially never in the
        # user's own query, so it registers as "unexplained extra content"
        # and silently rejects an otherwise-perfect match. The brand was
        # never needed for scoring in the first place — a query that
        # genuinely names the brand (e.g. "Pirifan fulgi de ovăz") still
        # matches fine on the food-name words alone.
        results.append((name, {"food_name": name, "source": "openfoodfacts", **macros}))
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


# ---------------------------------------------------------------------------
# A plain cut of meat/poultry/fish/egg has essentially zero carbohydrate
# content, biologically — this is a NUMERIC plausibility check, not a text
# one, and catches a failure mode none of the gates in _score() can:
# live-discovered that a bare "grilled chicken breast" query confidently
# matched an Open Food Facts entry named, verbatim, "Grilled Chicken
# Breast" — a textually PERFECT match, nothing for the allowlist gate to
# reject — whose own nutriment data reported 12.3g carbs and 1.3g fiber per
# 100g. That's either a genuine data-entry error in this crowdsourced
# product, or a marinated/breaded product that just never said so in its
# own name. Either way, the name gave no textual signal to catch it on, so
# this checks the QUERY's implied food category against the CANDIDATE's
# actual macros instead. Deliberately narrow (a handful of foods that are
# obligately near-zero-carb) rather than a general "does this look right"
# heuristic — that bar (a specific, checkable, always-true biological fact)
# is what keeps this from becoming another unbounded list to maintain.
# ---------------------------------------------------------------------------
_ZERO_CARB_PROTEIN_WORDS = {
    "chicken", "beef", "pork", "turkey", "fish", "salmon", "tuna", "shrimp",
    "egg", "steak", "lamb", "duck",
}
# If the QUERY itself already names a carb-bearing preparation, a non-zero
# carbs_per_100g isn't implausible at all — this check only fires when the
# query gave no such signal (mirrors _is_missing_cooked_state's same
# "only applies when nothing already explains it" shape).
_CARB_IMPLYING_QUALIFIERS = {
    "bread", "breaded", "batter", "battered", "flour", "sauce", "marinade",
    "glaze", "glazed", "teriyaki", "honey", "sugar", "sweet", "bbq", "sticky",
}
_IMPLAUSIBLE_PROTEIN_CARBS_THRESHOLD = 5.0  # grams per 100g


def _is_implausible_protein_carbs(food_name: str, carbs_per_100g: float) -> bool:
    q_tokens = _canonical_tokens(food_name)
    if not (q_tokens & _ZERO_CARB_PROTEIN_WORDS):
        return False
    if q_tokens & _CARB_IMPLYING_QUALIFIERS:
        return False
    return carbs_per_100g > _IMPLAUSIBLE_PROTEIN_CARBS_THRESHOLD


async def _lookup_uncached(food_name: str) -> dict | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        usda_results, off_results = await asyncio.gather(
            _search_usda(food_name, client), _search_off(food_name, client)
        )

    candidates = usda_results + off_results
    eligible = [pair for pair in candidates if _score(food_name, pair[0]) >= CONFIDENCE_THRESHOLD]
    eligible = [
        pair for pair in eligible
        if not _is_implausible_protein_carbs(food_name, pair[1]["carbs_per_100g"])
    ]
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
    complete within budget. `source` is "usda" or "openfoodfacts" — no
    longer purely informational as of the scan/describe pipeline rewrite:
    gemini_service.py::_resolve_ingredient now propagates it into each
    logged ingredient's own macro_source field (see models.py::
    IngredientItem), so the app can distinguish a verified number from an
    AI guess.

    CALLER EXPECTATION (this module doesn't enforce it, but is tuned
    assuming it): `food_name` should be an English, generic-form query —
    e.g. "cooked white rice", not "orez fiert" — whenever the caller has
    one available. `_score()`'s matcher is lexical and English-biased, and
    USDA FoodData Central's own corpus is English-only, so a Romanian-
    language query can score well against Open Food Facts' real Romanian-
    market entries (see this module's own docstring above) but will
    essentially never match USDA — silently losing the source
    `_USDA_TIE_BREAK_BONUS` exists specifically to prefer for a plain
    generic ingredient. gemini_service.py's extraction prompts
    (VISION_EXTRACTION_PROMPT / TEXT_EXTRACTION_PROMPT) translate to an
    English search_name for exactly this reason before this function is
    ever called; _resolve_ingredient additionally retries with the
    original (possibly non-English) name if the English one draws a blank,
    since Open Food Facts genuinely does carry non-English entries USDA
    has no equivalent of."""
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

    # One deliberately sanitized line per lookup (food name + outcome only,
    # never a URL) — this app's own logging.getLogger("httpx").setLevel
    # (see main.py) suppresses httpx's own per-request log line globally to
    # stop it leaking USDA_API_KEY (it puts the key in the URL query string,
    # unlike Groq/Mistral's Authorization header), which was otherwise the
    # only visibility into whether grounding fires at all. This restores
    # that observability without reintroducing the leak.
    if result is not None:
        logger.info("Grounded %r via %s", food_name, result["source"])
    else:
        logger.info("No confident database match for %r — AI estimate will be used", food_name)

    _cache_put(key, result)
    return result
