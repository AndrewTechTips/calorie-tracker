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
    # Romanian dish/recipe filler nouns (mancare/casa) must not register as
    # unexplained extra content — live-discovered gap while root-causing the
    # "mix de legume mexicane fierte" bug (see
    # test_lookup_skips_a_kj_mislabeled_as_kcal_vegetable_mix below).
    ("ciorba de legume", "Mancare de casa - ciorba de legume"),
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


def test_score_powder_state_mismatch_gate_is_symmetric_and_universal():
    # Root cause of the "100g orez pudră Vitabolic" bug: a query naming the
    # powdered/milled form of a food must never match a candidate for that
    # food's whole/cooked form, or the reverse — the density gap (dry rice
    # powder ~350-360 kcal/100g vs cooked rice ~130-144 kcal/100g) is the
    # same order of magnitude as the raw-vs-cooked staple bug this file
    # already fixed once. Unlike that fix, this must be universal (any
    # food), not scoped to the bounded _DRY_STAPLE_FOODS list — a powder
    # claim is never ambiguous by omission the way a bare staple name is.
    assert _score("rice powder", "Rice, white, long-grain, regular, cooked") == 0.0
    assert _score("rice flour", "Rice, white, long-grain, regular, cooked") == 0.0
    assert _score("rice", "Rice flour") == 0.0
    # Romanian spellings must trigger the same gate (diacritics transliterate
    # before word-splitting — "pudră"/"pulbere" normalize to "pudra"/"pulbere").
    assert _score("orez pudra", "Rice, white, long-grain, regular, cooked") == 0.0
    # A candidate that DOES name the powder/flour form is a real match.
    assert _score("rice flour", "Flour, rice") >= CONFIDENCE_THRESHOLD
    # Not scoped to the dry-staple list — applies to any food category.
    assert _score("banana powder", "Bananas, raw") == 0.0
    assert _score("egg powder", "Egg, whole, raw, fresh") == 0.0


def test_score_liquid_state_mismatch_gate_is_symmetric():
    # Same reasoning as the powder gate above, for the liquid/shake form —
    # a protein shake (already mixed, liquid) must never match a dry
    # protein-powder candidate's per-100g density, or the reverse.
    assert _score("protein shake", "Whey protein powder") == 0.0
    assert _score("whey protein powder", "Protein shake, ready to drink") == 0.0


def test_score_explicit_raw_cooked_conflict_is_universal_not_staple_only():
    # _is_missing_cooked_state (silence-based) is deliberately scoped to the
    # bounded _DRY_STAPLE_FOODS list — but an EXPLICIT raw claim against an
    # EXPLICIT cooked claim is unambiguous for any food, staple or not, and
    # must reject regardless of category.
    assert _score("raw chicken breast", "Chicken breast, cooked, roasted") == 0.0
    assert _score("cooked chicken breast", "Chicken, breast, raw") == 0.0
    # A query silent on state still matches a cooked reference fine (meat
    # isn't gated on silence the way the bounded staple list is).
    assert _score("chicken breast", "Chicken breast, cooked, roasted") >= CONFIDENCE_THRESHOLD


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


def test_implausible_protein_carbs_catches_a_real_data_quality_bug():
    from services.nutrition_db_service import _is_implausible_protein_carbs

    # Live-discovered: a bare "grilled chicken breast" query matched an Open
    # Food Facts entry named, verbatim, "Grilled Chicken Breast" — a
    # textually PERFECT match, nothing for _score's allowlist gate to
    # reject — whose own data reported 12.3g carbs/100g. Chicken has no
    # carbohydrate content biologically; this is a data-quality issue no
    # text-matching improvement can catch.
    assert _is_implausible_protein_carbs("grilled chicken breast", 12.3) is True
    # A plain chicken breast with trace/near-zero carbs is fine.
    assert _is_implausible_protein_carbs("chicken breast", 1.1) is False
    # The query itself naming a carb-bearing preparation means real carbs
    # are expected and must NOT be flagged.
    assert _is_implausible_protein_carbs("teriyaki chicken", 51.0) is False
    # Doesn't apply to foods that aren't obligately zero-carb at all.
    assert _is_implausible_protein_carbs("white rice", 71.0) is False


def test_unidentified_supplement_match_rejects_bare_anonymous_off_entry():
    from services.nutrition_db_service import _is_unidentified_supplement_match

    # Live-verified root cause of the "38g Proteina Pro Whey de la Pro
    # nutrition" bug: search.openfoodfacts.org's top hit for the bare,
    # brand-stripped query "whey protein powder" is an entry named,
    # verbatim, "Whey protein powder" — no brand, no product identity, one
    # anonymous contributor's specific product standing in for the entire
    # category. This scores a perfect 1.0 under _score() (see the SHOULD_MATCH
    # cases above for why that gate alone can't catch it) and must be
    # rejected by this second, category-aware gate instead.
    assert _is_unidentified_supplement_match("whey protein powder", "Whey protein powder", "openfoodfacts") is True
    assert _is_unidentified_supplement_match("whey protein isolate", "Whey Protein Isolate", "openfoodfacts") is True
    # Keeping the brand in the query doesn't help on its own if the only
    # candidate found is still the bare/anonymous one — the candidate has to
    # carry its own identity, not just be textually explained by the query.
    assert _is_unidentified_supplement_match("Pro Nutrition whey protein", "Whey protein powder", "openfoodfacts") is True

    # A candidate that DOES name something beyond the bare category (a real
    # brand/flavor) is a genuinely identified product and must NOT be rejected.
    assert _is_unidentified_supplement_match(
        "myprotein impact whey protein", "Impact Whey Protein MyProtein", "openfoodfacts"
    ) is False

    # USDA has no supplement-brand coverage and its entries are professionally
    # measured reference data, not one crowdsourced product — never gated here.
    assert _is_unidentified_supplement_match("whey protein powder", "Whey protein powder", "usda") is False

    # Doesn't apply outside the formulated/manufactured-supplement category —
    # a whole natural food's generic DB entry is a safe proxy for any brand.
    assert _is_unidentified_supplement_match("cooked white rice", "White Rice", "openfoodfacts") is False
    assert _is_unidentified_supplement_match("chicken breast", "Chicken breast", "openfoodfacts") is False


def test_implausible_energy_density_catches_the_kj_mislabeled_as_kcal_bug():
    from services.nutrition_db_service import _is_implausible_energy_density

    # Live-discovered, real Open Food Facts data (Mercadona "Mix de
    # legumes", barcode 8480000610669): reports 423 kcal/100g against its
    # own 6.6g protein/14g carbs/0.6g fat (Atwater sum ~88 kcal) — a ~4.8x
    # mismatch, and 423 / 4.184 (kJ->kcal) ≈ 101 kcal, squarely inside the
    # real 37-115 kcal/100g range every other "vegetable mix" product in the
    # same live search actually reports.
    assert _is_implausible_energy_density("mix de legume mexicane fierte", 423, 6.6, 14, 0.6) is True
    # The genuinely correct sibling entries must NOT be flagged.
    assert _is_implausible_energy_density("mix de legume mexicane fierte", 52.7, 2.0, 10.9, 0.36) is False
    assert _is_implausible_energy_density("mix de legume mexicane fierte", 69, 2, 7, 3.8) is False
    # A near-zero-calorie food's small ratio-only "overage" is rounding
    # noise, not a data error — the absolute floor must exempt it.
    assert _is_implausible_energy_density("black coffee", 1, 0.1, 0, 0) is False
    # Alcohol's real energy (~7 kcal/g) legitimately isn't captured by
    # protein/carbs/fat at all — wine's real ~85 kcal/100g against ~11 kcal
    # of Atwater-tracked macros (a ~7.7x ratio, HIGHER than the bug case
    # above) must not be rejected just because a food name mentions alcohol.
    assert _is_implausible_energy_density("red wine", 85, 0.1, 2.6, 0) is False
    assert _is_implausible_energy_density("vin rosu", 85, 0.1, 2.6, 0) is False
    # A plain food whose calories roughly agree with its own macros is fine.
    assert _is_implausible_energy_density("chicken breast", 165, 31, 0, 3.6) is False


async def test_lookup_skips_a_kj_mislabeled_as_kcal_vegetable_mix(monkeypatch):
    # End-to-end reproduction of the real user-reported bug: "100g mix de
    # legume mexicane fierte" returning 423 kcal/14g carbs. The winning
    # OFF candidate text-matches at 0.60 (over CONFIDENCE_THRESHOLD) with
    # nothing for _score's allowlist gate to catch — only the energy-density
    # numeric check can reject it, forcing a fall-through to the AI estimate
    # instead of silently returning a ~5x-inflated calorie figure.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return []

    async def fake_off(query, client):
        return [("Mix de legumes", {
            "food_name": "Mix de legumes", "source": "openfoodfacts",
            "calories_per_100g": 423, "protein_per_100g": 6.6, "carbs_per_100g": 14, "fats_per_100g": 0.6,
        })]

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("mix de legume mexicane fierte")
    assert result is None  # falls back to the AI's own (far more plausible) estimate


def test_placeholder_zero_entry_detects_empty_off_submissions():
    from services.nutrition_db_service import _is_placeholder_zero_entry

    # Live-discovered in the same investigation: some Open Food Facts entries
    # report every required macro as a literal 0 (an empty crowdsourced
    # submission) — that passes the "not None" required-fields check but is
    # not usable nutrition data for any real food this app looks up.
    assert _is_placeholder_zero_entry(
        {"calories_per_100g": 0, "protein_per_100g": 0, "carbs_per_100g": 0, "fats_per_100g": 0}
    ) is True
    assert _is_placeholder_zero_entry(
        {"calories_per_100g": 400, "protein_per_100g": 73, "carbs_per_100g": 13, "fats_per_100g": 7}
    ) is False
    # A genuinely near-zero-everything food (e.g. black coffee) still has SOME
    # non-zero field in practice; only the all-zero case is rejected here.
    assert _is_placeholder_zero_entry(
        {"calories_per_100g": 1, "protein_per_100g": 0.1, "carbs_per_100g": 0, "fats_per_100g": 0}
    ) is False


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


async def test_lookup_skips_a_textually_perfect_but_implausible_match(monkeypatch):
    # Live-discovered, end-to-end (not just the pure _score function): a
    # bare "grilled chicken breast" query's only USDA/OFF candidate is a
    # textually perfect name match whose own data claims 12.3g carbs/100g
    # — chicken has no carbohydrate content. lookup() must not return this,
    # even though _score alone would happily accept it.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return []

    async def fake_off(query, client):
        return [("Grilled Chicken Breast", {
            "food_name": "Grilled Chicken Breast", "source": "openfoodfacts",
            "calories_per_100g": 130, "protein_per_100g": 11, "carbs_per_100g": 12.3, "fats_per_100g": 4.27,
        })]

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("grilled chicken breast")
    assert result is None  # falls back to the AI's own estimate


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


async def test_lookup_skips_an_anonymous_generic_supplement_match_end_to_end(monkeypatch):
    # End-to-end reproduction of the "38g Proteina Pro Whey de la Pro
    # nutrition" bug: the pipeline's own search_name for this branded whey
    # product was the bare, brand-stripped "whey protein powder" — Open Food
    # Facts' real top hit for that exact query (see
    # test_unidentified_supplement_match_rejects_bare_anonymous_off_entry's
    # own comment) is a textually perfect but anonymous entry that used to
    # be silently trusted, skipping the AI CoT fallback entirely. lookup()
    # must now return None here, not that candidate.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return []  # USDA has no supplement-brand coverage for this query

    async def fake_off(query, client):
        return [("Whey protein powder", {
            "food_name": "Whey protein powder", "source": "openfoodfacts",
            "calories_per_100g": 400, "protein_per_100g": 73.33, "carbs_per_100g": 13.33, "fats_per_100g": 6.67,
        })]

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("whey protein powder")
    assert result is None  # falls through to the AI CoT fallback instead


async def test_lookup_still_accepts_a_genuinely_branded_supplement_match(monkeypatch):
    # The new gate must not block a real, identified product match — only
    # the bare/anonymous case.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return []

    async def fake_off(query, client):
        return [("Impact Whey Protein MyProtein", {
            "food_name": "Impact Whey Protein MyProtein", "source": "openfoodfacts",
            "calories_per_100g": 410, "protein_per_100g": 79, "carbs_per_100g": 7.1, "fats_per_100g": 7.2,
        })]

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("myprotein impact whey protein")
    assert result is not None
    assert result["source"] == "openfoodfacts"
    assert result["protein_per_100g"] == 79


async def test_lookup_rejects_cooked_rice_for_a_rice_powder_query_end_to_end(monkeypatch):
    # End-to-end reproduction of the "100g orez pudră Vitabolic" bug: only a
    # cooked-rice USDA reference is available (as would happen if Stage 1's
    # own search_name translation still lost the state modifier, or simply
    # because a database has no dedicated rice-powder entry) — lookup() must
    # return None here, not silently substitute cooked rice's ~3x-lower
    # calorie density, so the caller falls through to the AI CoT estimate.
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return [("Rice, white, long-grain, regular, cooked", {
            "food_name": "Rice, white, long-grain, regular, cooked", "source": "usda",
            "calories_per_100g": 130, "protein_per_100g": 2.7, "carbs_per_100g": 28.2, "fats_per_100g": 0.3,
        })]

    async def fake_off(query, client):
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup("rice powder")
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


# ---------------------------------------------------------------------------
# lookup_best: the dual-language query strategy — a translated English
# search_name and the original (possibly Romanian) food_name are queried
# CONCURRENTLY, and whichever scores higher wins, rather than a sequential
# "try English first, only fall back to the original on a miss" order that
# would always prefer a mediocre English match over a genuinely better
# original-language one.
# ---------------------------------------------------------------------------
async def test_lookup_best_prefers_the_higher_scoring_candidate_across_queries(monkeypatch):
    _reset(monkeypatch)

    # "light cheese" (the lossy English translation, having dropped the
    # brand) only finds a plain/regular cheese entry; the original Romanian
    # name still carries the brand+"light" and matches Open Food Facts'
    # actual Romanian-market light product — the real match should win even
    # though it's found via the second query, not the first.
    async def fake_usda(query, client):
        return []

    async def fake_off(query, client):
        if query == "light cheese":
            return [("Cheese", {
                "food_name": "Cheese", "source": "openfoodfacts",
                "calories_per_100g": 350, "protein_per_100g": 25, "carbs_per_100g": 2, "fats_per_100g": 28,
            })]
        if query == "branza fagaras light":
            return [("Branza Fagaras light", {
                "food_name": "Branza Fagaras light", "source": "openfoodfacts",
                "calories_per_100g": 180, "protein_per_100g": 20, "carbs_per_100g": 3, "fats_per_100g": 9,
            })]
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup_best(["light cheese", "branza fagaras light"])
    assert result is not None
    assert result["food_name"] == "Branza Fagaras light"
    assert result["fats_per_100g"] == 9


async def test_lookup_best_falls_back_to_the_only_query_with_a_match(monkeypatch):
    _reset(monkeypatch)

    async def fake_usda(query, client):
        return []

    async def fake_off(query, client):
        if query == "cooked white rice":
            return [("Rice, white, long-grain, regular, cooked", {
                "food_name": "Rice, white, long-grain, regular, cooked", "source": "openfoodfacts",
                "calories_per_100g": 130, "protein_per_100g": 2.7, "carbs_per_100g": 28, "fats_per_100g": 0.3,
            })]
        return []  # the original-language query draws a blank

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_usda)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_off)

    result = await nutrition_db_service.lookup_best(["cooked white rice", "orez fiert"])
    assert result is not None
    assert result["food_name"] == "Rice, white, long-grain, regular, cooked"


async def test_lookup_best_dedupes_identical_queries_to_a_single_plain_lookup(monkeypatch):
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

    result = await nutrition_db_service.lookup_best(["banana", "Banana"])
    assert result is not None
    assert call_count == 1  # same name (case-insensitive) collapses to one lookup(), not two


async def test_lookup_best_returns_none_when_grounding_disabled(monkeypatch):
    _reset(monkeypatch, enabled=False)

    async def fake_search(query, client):
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_usda", fake_search)
    monkeypatch.setattr(nutrition_db_service, "_search_off", fake_search)

    assert await nutrition_db_service.lookup_best(["light cheese", "branza fagaras light"]) is None


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
