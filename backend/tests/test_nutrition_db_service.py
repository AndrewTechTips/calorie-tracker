import pytest

from services import nutrition_db_service
from services.nutrition_db_service import CONFIDENCE_THRESHOLD, _score


# ---------------------------------------------------------------------------
# _score: pure text-matching confidence, no network involved. Pinned as
# regression tests against the exact cases used to tune the threshold/
# algorithm live (see nutrition_db_service.py's own module docstring) —
# these are what actually decide whether the whole feature is safe to trust,
# so every case here failing would mean a real behavior change worth
# noticing, not just a coincidental score drift.
# ---------------------------------------------------------------------------
SHOULD_MATCH = [
    ("egg whites", "Eggs, Grade A, Large, egg white"),
    ("egg whites", "Egg, white, raw, fresh"),
    ("chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"),
    ("chicken breast", "CHICKEN BREAST"),
    ("rye crispbread", "Crackers, crispbread, rye"),
    ("crispbread", "Crackers, crispbread, rye"),
    ("telemea", "Telemea"),
    ("telemea cheese", "Telemea"),
    ("white rice", "Rice, white, long-grain, regular, cooked"),
    ("banana", "Bananas, raw"),
    ("apple", "Apples, raw, with skin"),
    ("skyr", "Skyr, plain, nonfat"),
    ("fried chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, fried"),
    ("grilled chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"),
    ("baked potato", "Potato, baked, flesh and skin"),
    ("boiled egg", "Egg, whole, cooked, hard-boiled"),
    # Romanian diacritics must transliterate before matching, not get
    # stripped as punctuation (a real, live-caught bug — see
    # _ROMANIAN_DIACRITIC_MAP's own comment).
    ("brânză de vaci", "Branza de vaci"),
    ("mămăligă", "Mamaliga"),
    # A broader 51-food live battery (meat, dairy, grains, produce, legumes,
    # nuts, Romanian dishes) surfaced these as additional real matches that
    # must keep passing under the allowlist rewrite (see nutrition_db_
    # service.py's module docstring for the blocklist-vs-allowlist story).
    ("chicken thigh", "Chicken Thighs"),
    ("potato", "Potato, NFS"),
    ("pasta", "Pasta, cooked"),
    ("raw oats", "Oats, raw"),  # explicit raw request must still match its raw reference
]

SHOULD_NOT_MATCH = [
    ("skyr", "Telemea"),
    ("cooking oil", "Rice, white, long-grain, regular, cooked"),
    ("apple", "Apple juice, canned or bottled, unsweetened, with added ascorbic acid"),
    ("chicken breast", "Chicken nuggets, frozen, uncooked, breaded"),
    ("rice", "Rice pudding, ready-to-eat"),
    ("banana", "Banana chips"),
    # Live-discovered against a real (non-rate-limited) USDA key: a bare
    # "chicken breast" query's own top USDA candidates included these two
    # reconstituted/processed products, not a plain cut of meat.
    ("chicken breast", "Lunchmeat, chicken breast, sliced"),
    ("chicken breast", "Chicken breast, roll, oven-roasted"),
    # Frying substantially changes the macro profile (added fat) — a
    # mismatch in either direction must reject, live-verified this was
    # otherwise a real gap: "fried chicken breast" scored 0.57 (still above
    # threshold) against a plain roasted reference before this fix.
    ("fried chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"),
    ("chicken breast", "Chicken, broilers or fryers, breast, meat only, cooked, fried"),
    # A 51-food live battery surfaced a dozen further wrong matches a
    # word-blocklist had no entry for — the actual motivation for rewriting
    # the gate from blocklist to allowlist (see nutrition_db_service.py's
    # module docstring). Each of these is a genuinely different food/dish
    # from the plain ingredient the query named.
    ("ground beef", "Spanish rice with ground beef"),
    ("pork chop", "Pork, chop, stuffed"),
    ("bacon", "Bacon bits"),
    ("greek yogurt", "Yogurt, Greek, with oats"),
    ("cottage cheese", "Cottage cheese, farmer's"),
    ("brown rice", "Beans and brown rice"),
    ("sweet potato", "Sweet potato tots"),
    ("tomato", "Soup, tomato"),
    ("egg", "Egg, creamed"),
    ("egg whites", "Egg white sandwich"),
    ("coffee", "Coffee, Cuban"),
    ("sarmale", "Orez sarmale"),
    # Live-discovered: color words (white/brown/red/green/yellow) were
    # briefly in the safe-descriptor list for cases like "white rice" — but
    # for eggs specifically, "white" denotes a COMPONENT (just the albumen),
    # not a color, so a bare "egg" query scored 0.76 (confidently over
    # threshold) against an egg-WHITE reference, silently substituting
    # ~52 kcal/11g protein/0g fat for a whole egg's ~155 kcal/13g protein/
    # 11g fat — a variant of the exact bug this whole feature exists to
    # fix. Color words were removed from the safe list entirely rather than
    # special-cased per food, since "white rice"/"brown rice" never needed
    # them there in the first place (the color is already in THOSE queries,
    # so it's never "extra" content to begin with).
    ("egg", "Eggs, Grade A, Large, egg white"),
    # A bare grain/legume query means its COOKED form almost always — "Oats,
    # raw" is a textually PERFECT match but the wrong density (dry oats are
    # ~5x cooked oatmeal's calories per equal gram) — see _DRY_STAPLE_FOODS'
    # own comment. Contrast with the "raw oats" case in SHOULD_MATCH above,
    # which explicitly asks for this form and must still be allowed.
    ("oats", "Oats, raw"),
    # Deliberately-accepted trade-offs, not oversights — see _score's own
    # docstring for why these two specific misses are NOT fixed: "salad"/
    # "cooking" as olive oil qualifiers aren't allowlisted because "salad"
    # also names genuinely different composite dishes elsewhere (chicken/
    # potato/egg salad), and "atlantic" isn't allowlisted because a broad
    # geographic-qualifier allowance would reopen the "Coffee, Cuban" hole.
    ("olive oil", "Oil, olive, salad or cooking"),
    ("salmon", "Atlantic salmon"),
]


@pytest.mark.parametrize("query,candidate", SHOULD_MATCH)
def test_score_accepts_real_matches(query, candidate):
    assert _score(query, candidate) >= CONFIDENCE_THRESHOLD


@pytest.mark.parametrize("query,candidate", SHOULD_NOT_MATCH)
def test_score_rejects_wrong_matches(query, candidate):
    assert _score(query, candidate) < CONFIDENCE_THRESHOLD


def test_score_unexplained_extra_content_is_an_absolute_gate_not_just_a_penalty():
    # Even a query that's otherwise a PERFECT textual match must still be
    # rejected if the candidate names extra content (an added ingredient or
    # different product) the query never asked for and isn't a known-safe
    # descriptor — this is what stops "banana" from silently resolving to
    # "banana chips" (fried/dried, ~5x the calories).
    assert _score("banana chips", "Banana chips") >= CONFIDENCE_THRESHOLD
    assert _score("banana", "Banana chips") == 0.0


def test_score_fried_mismatch_gate_is_symmetric():
    # Both directions must reject: a fried query must never quietly accept
    # a non-fried reference (understating added fat/calories), and a plain
    # query must never quietly accept a fried one (overstating them).
    assert _score("fried chicken breast", "Chicken breast, cooked, fried") >= CONFIDENCE_THRESHOLD
    assert _score("fried chicken breast", "Chicken breast, cooked, roasted") == 0.0
    assert _score("chicken breast", "Chicken breast, cooked, fried") == 0.0
    # Non-fried cooking methods are NOT gated against each other — they're
    # genuinely similar, low-added-fat methods macro-wise.
    assert _score("grilled chicken breast", "Chicken breast, cooked, roasted") >= CONFIDENCE_THRESHOLD


def test_normalize_transliterates_romanian_diacritics_instead_of_stripping_them():
    from services.nutrition_db_service import _normalize

    # Bug: the old strip-as-punctuation approach turned "brânză" into "br
    # nz" — unmatchable garbage. Diacritics must transliterate to their
    # plain-Latin equivalent instead.
    assert _normalize("brânză") == "branza"
    assert _normalize("mămăligă") == "mamaliga"
    assert _normalize("ovăz") == "ovaz"
    # A query with diacritics must still match a database entry that
    # stores the same word without them (a real, plausible data variance
    # between contributors) — this is the actual point of transliterating
    # rather than just not crashing.
    assert _score("brânză de vaci", "Branza de vaci") >= CONFIDENCE_THRESHOLD


# ---------------------------------------------------------------------------
# lookup(): the orchestration layer (cache, feature flag, concurrent search,
# best-candidate selection, failure handling). _search_usda/_search_off's
# own HTTP mechanics were validated live against the real APIs while
# building this (see PR/commit description) — these tests mock them
# directly rather than the transport layer, since what needs unit coverage
# here is lookup()'s own decision logic, not whether httpx works.
# ---------------------------------------------------------------------------
class _EnabledSettings:
    nutrition_db_grounding_enabled = True
    usda_api_key = "test-key"


class _DisabledSettings:
    nutrition_db_grounding_enabled = False
    usda_api_key = "test-key"


def _reset(monkeypatch, enabled=True):
    nutrition_db_service._cache.clear()
    settings = _EnabledSettings() if enabled else _DisabledSettings()
    monkeypatch.setattr(nutrition_db_service, "get_settings", lambda: settings)


async def test_lookup_returns_none_when_grounding_disabled(monkeypatch):
    _reset(monkeypatch, enabled=False)
    calls = []

    async def fake_search(query, client):
        calls.append(query)
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_search)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_search)

    result = await nutrition_db_service.lookup("chicken breast")
    assert result is None
    assert calls == []  # disabled means no external call is ever attempted


async def test_lookup_returns_best_confident_candidate(monkeypatch):
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return [("Chicken, broilers or fryers, breast, meat only, cooked, roasted", {
            "food_name": "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
            "source": "usda",
            "calories_per_100g": 165, "protein_per_100g": 31, "carbs_per_100g": 0, "fats_per_100g": 3.6,
        })]

    async def fake_off(query, client):
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("chicken breast")
    assert result is not None
    assert result["source"] == "usda"
    assert result["protein_per_100g"] == 31


async def test_lookup_prefers_usda_generic_over_a_similarly_scored_branded_match(monkeypatch):
    # Live-discovered scenario: a plain "chicken breast" query matches
    # several genuinely different Open Food Facts branded products (92-181
    # kcal/100g across real brands) — none representing a home-cooked
    # chicken breast the way USDA's single generic entry does. When both
    # sources have a comparably good text match, USDA's generic entry
    # should win, not whichever branded product happened to score a hair
    # higher on text similarity alone.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return [("Chicken, breast, meat only, cooked, roasted", {
            "food_name": "Chicken, breast, meat only, cooked, roasted", "source": "usda",
            "calories_per_100g": 165, "protein_per_100g": 31, "carbs_per_100g": 0, "fats_per_100g": 3.6,
        })]

    async def fake_off(query, client):
        return [("Chicken breast", {
            "food_name": "Chicken breast", "source": "openfoodfacts",
            "calories_per_100g": 92, "protein_per_100g": 17.8, "carbs_per_100g": 1.1, "fats_per_100g": 1.5,
        })]

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("chicken breast")
    assert result["source"] == "usda"
    assert result["calories_per_100g"] == 165


async def test_lookup_still_prefers_off_when_it_is_a_clearly_better_match(monkeypatch):
    # The USDA tie-break bonus must never be enough to beat a real brand
    # match — e.g. a query that actually names a specific product (Pirifan
    # oat flakes) has no USDA equivalent at all (score 0, gated out by the
    # closed-vocabulary brand name), so Open Food Facts must still win.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return [("Oats, raw", {
            "food_name": "Oats, raw", "source": "usda",
            "calories_per_100g": 389, "protein_per_100g": 17, "carbs_per_100g": 66, "fats_per_100g": 7,
        })]

    async def fake_off(query, client):
        return [("Fulgi de ovăz bio (Pirifan)", {
            "food_name": "Fulgi de ovăz bio", "source": "openfoodfacts",
            "calories_per_100g": 375, "protein_per_100g": 13.5, "carbs_per_100g": 60, "fats_per_100g": 7,
        })]

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("Pirifan fulgi de ovăz")
    assert result["source"] == "openfoodfacts"


async def test_lookup_returns_none_when_no_candidate_is_confident(monkeypatch):
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return [("Telemea", {"food_name": "Telemea", "source": "usda", "calories_per_100g": 300,
                              "protein_per_100g": 17, "carbs_per_100g": 1, "fats_per_100g": 25})]

    async def fake_off(query, client):
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("skyr")  # Telemea is not skyr — must not match
    assert result is None


async def test_lookup_caches_a_positive_result_and_skips_the_second_call(monkeypatch):
    _reset(monkeypatch)
    call_count = 0

    async def fake_usda(query, client):
        nonlocal call_count
        call_count += 1
        return [("Bananas, raw", {"food_name": "Bananas, raw", "source": "usda", "calories_per_100g": 89,
                                   "protein_per_100g": 1.1, "carbs_per_100g": 23, "fats_per_100g": 0.3})]

    async def fake_off(query, client):
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    first = await nutrition_db_service.lookup("banana")
    second = await nutrition_db_service.lookup("banana")
    assert first == second
    assert call_count == 1  # second call was served entirely from cache


async def test_lookup_caches_a_negative_result_too(monkeypatch):
    _reset(monkeypatch)
    call_count = 0

    async def fake_search(query, client):
        nonlocal call_count
        call_count += 1
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_search)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_search)

    assert await nutrition_db_service.lookup("sarmale") is None
    assert await nutrition_db_service.lookup("sarmale") is None
    assert call_count == 2  # one usda + one off call, on the FIRST lookup only


async def test_lookup_swallows_a_search_failure_and_does_not_cache_it(monkeypatch):
    _reset(monkeypatch)

    async def failing_search(query, client):
        raise RuntimeError("simulated network failure")

    monkeypatch.setattr(nutrition_db_service, "_search_usda", failing_search)
    monkeypatch.setattr(nutrition_db_service, "_search_off", failing_search)

    result = await nutrition_db_service.lookup("chicken breast")
    assert result is None
    # A transient failure must not be cached as a permanent "no match" —
    # confirmed by checking the cache has no entry for this key at all.
    was_cached, _ = nutrition_db_service._cache_get(nutrition_db_service._normalize("chicken breast"))
    assert was_cached is False


def test_safe_exc_repr_never_leaks_the_api_key_embedded_in_an_httpx_url():
    # Security-relevant, live-discovered: httpx.HTTPStatusError's own
    # __str__ embeds the FULL request URL, including USDA_API_KEY as a
    # plaintext query parameter. Logging str(exc) directly (as this module
    # once did) would leak the key into every log aggregator/Sentry event a
    # single USDA request failure reaches.
    import httpx

    from services.nutrition_db_service import _safe_exc_repr

    request = httpx.Request(
        "GET", "https://api.nal.usda.gov/fdc/v1/foods/search?query=x&api_key=super-secret-value"
    )
    response = httpx.Response(429, request=request)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Sanity check the vulnerability is real in the first place —
        # if httpx ever stops embedding the URL, this assertion should
        # start failing loudly rather than the test silently passing for
        # the wrong reason.
        assert "super-secret-value" in str(exc)
        safe = _safe_exc_repr(exc)
        assert "super-secret-value" not in safe
        assert "429" in safe


class _FakeOffResponse:
    def __init__(self, json_data):
        self._json_data = json_data

    def raise_for_status(self):
        pass

    def json(self):
        return self._json_data


class _FakeOffClient:
    def __init__(self, json_data):
        self._json_data = json_data

    async def get(self, url, params=None, headers=None):
        return _FakeOffResponse(self._json_data)


async def test_search_off_never_appends_brand_to_the_scored_name():
    # Regression test for a real, serious bug found live: an earlier version
    # scored candidates against a brand-annotated "Mozzarella (Kirkland)"
    # string, which broke virtually every branded Open Food Facts match
    # under the allowlist gate — the brand name is essentially never in the
    # user's own query, so it always registered as unexplained extra content
    # and silently rejected an otherwise-correct match. Since Open Food
    # Facts is fundamentally a branded-product database, this wasn't a rare
    # edge case, it was most of its catalog.
    fake_json = {
        "hits": [
            {
                "product_name": "Mozzarella",
                "brands": ["Kirkland"],
                "nutriments": {
                    "energy-kcal_100g": 280,
                    "proteins_100g": 22,
                    "fat_100g": 20,
                    "carbohydrates_100g": 2,
                },
            }
        ]
    }
    results = await nutrition_db_service._search_off("mozzarella", _FakeOffClient(fake_json))
    assert len(results) == 1
    name, data = results[0]
    assert name == "Mozzarella"  # never "Mozzarella (Kirkland)"
    assert data["food_name"] == "Mozzarella"
    # The actual downstream effect: this must score as a confident match,
    # not get silently rejected because of its own brand.
    assert _score("mozzarella", name) >= CONFIDENCE_THRESHOLD
