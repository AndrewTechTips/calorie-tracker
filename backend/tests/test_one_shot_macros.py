"""Stage 1 prices the meal itself, and only a HUMAN's number may override it.

THE BUG THIS EXISTS FOR (2026-09-17). Both extraction prompts used to open by
forbidding the model to produce a macro number at all — "a deterministic
database step prices your output afterward" — and that database step reached
USDA and Open Food Facts through a purely LEXICAL matcher: it ranks candidate
rows by how closely their TITLE resembles the query and never reads the numbers
it is ranking. So a query for "cheese" resolved to USDA's "Bread, cheese"
(408 kcal, 44.8g carbs, 10.4g protein per 100g) and a Romanian "ceafa de porc"
to an Open Food Facts row claiming 60g of protein per 100g of pork. Both
reached the user stamped `usda` / `openfoodfacts`, the app's highest-trust
provenance badge, having silently overwritten a correct model estimate.

Measured across 20 real Romanian descriptions through the real
estimate_from_description: median calorie error 16.5% -> 2.6% and protein error
26.5% -> 3.3% once Stage 1 answers directly, with badly-wrong cases 10/20 ->
1/20. See config.nutrition_db_grounding_enabled for the full write-up.

What these tests pin, in order of how expensive getting it wrong would be:
  1. the model's macros are used, and no database call is made to second-guess
     them;
  2. the two things that still outrank them — a value the user typed, and a
     custom food they saved off a real package — still win, because those are
     numbers a human established rather than anyone inferring;
  3. the old pipeline is still reachable and still correct, both by flag and
     as an automatic fallback when a response arrives without macros, so this
     degrades rather than failing;
  4. the prompts and the schema actually ask for what the code now relies on.
"""
import asyncio
import json

import pytest

import services.gemini_service as gemini_service
from services import custom_food_service, food_cache_service, nutrition_db_service


def _item(name="Branza telemea", weight_g=100.0, **overrides):
    """A Stage 1 ingredient as the one-shot schema now produces it."""
    item = {
        "food_name": name,
        "search_name": "telemea cheese",
        "weight_g": weight_g,
        "is_composite": False,
        "calories": 260.0,
        "protein": 17.0,
        "carbs": 1.0,
        "fats": 21.0,
        "fiber": 0.0,
        "sugar": 1.0,
        "sodium": 1200.0,
    }
    item.update(overrides)
    return item


# The exact row that produced the live "branza cu 0 proteine" complaint: USDA's
# "Bread, cheese", which the lexical matcher scored 0.900 against a bare
# "cheese" query and which then beat every real cheese in the candidate set.
BREAD_CHEESE_MATCH = {
    "calories_per_100g": 408.0,
    "protein_per_100g": 10.4,
    "carbs_per_100g": 44.8,
    "fats_per_100g": 20.8,
    "source": "usda",
}


@pytest.fixture(autouse=True)
def _clean_caches(monkeypatch):
    # Pin the flag rather than inheriting it. config.py sets extra="ignore", so
    # a stale ONE_SHOT_MACRO_ESTIMATION in a developer's shell or the deployed
    # .env silently changes which pipeline runs — and a test that quietly
    # asserted the OLD behaviour while claiming to guard the new one is worse
    # than no test. The single case that exercises the flag being off sets it
    # itself, after this fixture.
    monkeypatch.setattr(
        gemini_service.get_settings(), "one_shot_macro_estimation", True, raising=False
    )
    food_cache_service._cache.clear()
    nutrition_db_service._cache.clear()
    yield
    food_cache_service._cache.clear()
    nutrition_db_service._cache.clear()


@pytest.fixture
def db(monkeypatch):
    """Makes the nutrition database answer with the bad row, and counts how
    often it is consulted at all. A count of zero is the assertion that
    matters most here — the layer cannot mis-price what it never sees."""
    state = {"lookups": 0, "fuzzy": 0, "recalls": 0, "match": BREAD_CHEESE_MATCH}

    async def _lookup_best(*args, **kwargs):
        state["lookups"] += 1
        return dict(state["match"]) if state["match"] else None

    async def _fuzzy(*args, **kwargs):
        state["fuzzy"] += 1
        return None

    async def _recall(food_name, weight_g, **kwargs):
        state["recalls"] += 1
        scale = weight_g / 100.0
        return {
            "calories": 999.0 * scale, "protein": 99.0 * scale, "carbs": 9.0 * scale,
            "fats": 9.0 * scale, "fiber": 0.0, "sugar": 0.0, "sodium": 0.0,
            "macro_source": gemini_service.MACRO_SOURCE_AI_ESTIMATE,
        }

    monkeypatch.setattr(nutrition_db_service, "lookup_best", _lookup_best)
    monkeypatch.setattr(nutrition_db_service, "lookup_custom_fuzzy", _fuzzy)
    monkeypatch.setattr(gemini_service, "estimate_macros_for_food_name", _recall)
    return state


def _resolve(item, **kwargs):
    return asyncio.run(gemini_service._resolve_ingredient(item, **kwargs))


# ---------------------------------------------------------------------------
# 1. The model's own figures are used, and nothing is asked to second-guess them
# ---------------------------------------------------------------------------
def test_model_macros_are_used_and_the_database_is_never_consulted(db):
    row = _resolve(_item())

    assert row["calories"] == pytest.approx(260, abs=1)
    assert row["protein"] == pytest.approx(17.0, abs=0.1)
    assert row["fats"] == pytest.approx(21.0, abs=0.1)
    assert row["macro_source"] == gemini_service.MACRO_SOURCE_AI_ESTIMATE
    # The whole point: "Bread, cheese" never gets the chance to win.
    assert db["lookups"] == 0
    assert db["recalls"] == 0


def test_the_live_cheese_complaint_does_not_reproduce(db):
    """A regression pinned to the real numbers a user reported, not a synthetic
    case: 100g of telemea must not come back as a high-carb, low-protein row."""
    row = _resolve(_item())

    assert row["protein"] > 12, "cheese reported with almost no protein — the original bug"
    assert row["carbs"] < 10, "cheese reported with bread's carbohydrate load"
    assert row["macro_source"] != "usda", "a model estimate must not be stamped as verified"


def test_a_composite_dish_is_priced_by_the_model_too(db):
    """is_composite used to route to a separate premium recall call. It now only
    tells the model to price the whole recipe, cooking fat included — there is
    nothing left downstream for it to route to."""
    row = _resolve(_item(name="Sarmale", is_composite=True, weight_g=200.0,
                         calories=310.0, protein=17.0, carbs=18.0, fats=21.0))

    assert row["calories"] == pytest.approx(310, abs=1)
    assert db["lookups"] == 0
    assert db["recalls"] == 0


def test_macros_are_taken_as_totals_not_per_100g(db):
    """The schema asks for figures already scaled to weight_g. Re-scaling them
    here would quietly divide a 200g portion by two."""
    row = _resolve(_item(weight_g=200.0, calories=520.0, protein=34.0,
                         carbs=2.0, fats=42.0))

    assert row["weight_g"] == pytest.approx(200.0)
    assert row["calories"] == pytest.approx(520, abs=2)
    assert row["protein"] == pytest.approx(34.0, abs=0.2)


# ---------------------------------------------------------------------------
# 2. A human's number still outranks the model's
# ---------------------------------------------------------------------------
def test_a_saved_custom_food_still_overrides_the_model(db, monkeypatch):
    """The user read this product's own label. That beats every estimate in the
    app, and always did — the one-shot change must not have quietly demoted it
    by inserting itself above the custom-food lookup."""
    saved = {
        "calories_per_100g": 233.0, "protein_per_100g": 19.0, "carbs_per_100g": 0.9,
        "fats_per_100g": 17.0, "fiber_per_100g": 0.0, "sugar_per_100g": 0.9,
        "sodium_per_100g": 900.0, "source": "user_custom",
    }
    monkeypatch.setattr(
        custom_food_service, "lookup_in",
        lambda foods, name: dict(saved) if name == "Branza telemea" else None,
    )

    row = _resolve(_item(), custom_foods={"branza telemea": saved})

    assert row["macro_source"] == "user_custom"
    assert row["calories"] == pytest.approx(233, abs=1)
    assert row["protein"] == pytest.approx(19.0, abs=0.1)


def test_fully_explicit_user_values_still_win(db):
    """"200g of an 80% protein isolate" — the user stated the facts, so nothing
    is estimated at all."""
    row = _resolve(_item(
        weight_g=200.0,
        explicit_calories=700.0, explicit_protein=160.0,
        explicit_carbs=10.0, explicit_fats=5.0,
    ))

    assert row["macro_source"] == gemini_service.MACRO_SOURCE_USER_STATED
    assert row["protein"] == pytest.approx(160.0, abs=0.1)
    assert db["lookups"] == 0


def test_a_partial_explicit_value_overrides_only_that_field(db):
    """"300 kcal" stated and nothing else: the calorie figure is the user's, the
    rest stays the model's, and the row does not earn the user_stated tag."""
    row = _resolve(_item(explicit_calories=300.0))

    assert row["calories"] == pytest.approx(300, abs=1)
    assert row["protein"] == pytest.approx(17.0, abs=0.1)
    assert row["macro_source"] == gemini_service.MACRO_SOURCE_AI_ESTIMATE


# ---------------------------------------------------------------------------
# 3. Degrades rather than failing
# ---------------------------------------------------------------------------
def test_an_ingredient_without_macros_falls_back_to_the_old_path(db):
    """A response that arrives in the old identification-only shape — an older
    provider, the Mistral fallback answering loosely — must still be priced,
    not logged as a meal of zeroes."""
    item = _item()
    for field in gemini_service._MODEL_MACRO_FIELDS:
        item.pop(field)

    row = _resolve(item)

    assert db["lookups"] == 1
    assert row["macro_source"] == "usda"
    assert row["calories"] > 0


def test_an_all_zero_macro_row_is_treated_as_no_answer(db):
    """Zero across every macro is a model declining to answer, not a real food.
    Trusting it would log a confident, wrong zero — worse than falling back."""
    row = _resolve(_item(calories=0, protein=0, carbs=0, fats=0,
                         fiber=0, sugar=0, sodium=0))

    assert db["lookups"] == 1
    assert row["calories"] > 0


@pytest.mark.parametrize("bad", ["n/a", "", None, float("nan"), float("inf")])
def test_a_non_numeric_macro_falls_back_rather_than_crashing(db, bad):
    """Providers do occasionally emit a string or a NaN through a numeric schema
    field. That must route to the fallback, never raise inside the fan-out."""
    row = _resolve(_item(protein=bad))

    assert db["lookups"] == 1
    assert isinstance(row["protein"], float)


def test_the_flag_restores_the_old_pipeline(db, monkeypatch):
    """one_shot_macro_estimation=false plus grounding on is the documented way
    back to pre-2026-09-17 behaviour, so it has to actually work."""
    settings = gemini_service.get_settings()
    monkeypatch.setattr(settings, "one_shot_macro_estimation", False, raising=False)

    row = _resolve(_item())

    assert db["lookups"] == 1
    assert row["macro_source"] == "usda"
    # And this is what that costs: the bad row is back.
    assert row["carbs"] > 10


def test_negative_macros_are_floored_not_propagated(db):
    """A negative gram figure is meaningless and would corrupt the meal total it
    is summed into."""
    row = _resolve(_item(fats=-5.0))

    assert row["fats"] >= 0


# ---------------------------------------------------------------------------
# 4. The prompts and schema ask for what the code relies on
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("prompt_name", ["VISION_EXTRACTION_PROMPT", "TEXT_EXTRACTION_PROMPT"])
def test_both_prompts_carry_the_macro_protocol(prompt_name):
    prompt = getattr(gemini_service, prompt_name)

    assert "__MACRO_BLOCK__" not in prompt, "the marker was never substituted"
    assert "REASONING PROTOCOL" in prompt
    assert "ATWATER CHECK" in prompt
    assert "DENSITY SANITY" in prompt
    # The sentence that caused the whole class of bug. It must not come back.
    assert "would be discarded" not in prompt
    assert "You do NOT estimate calories" not in prompt


@pytest.mark.parametrize("prompt_name", ["VISION_EXTRACTION_PROMPT", "TEXT_EXTRACTION_PROMPT"])
def test_both_prompts_keep_the_invalid_input_escape_hatch(prompt_name):
    """The macro protocol is additive — it must not have displaced the
    prompt-injection defence both prompts share."""
    prompt = getattr(gemini_service, prompt_name)

    assert '{"error": "invalid_input"}' in prompt
    assert "untrusted" in prompt.lower()


def test_the_extraction_schema_requires_every_macro_field():
    """Required, not optional: an optional field is one the model can skip on a
    hard ingredient, which is exactly where a silent zero would do most damage."""
    item_schema = gemini_service._EXTRACTION_ITEM_SCHEMA

    for field in gemini_service._MODEL_MACRO_FIELDS:
        assert field in item_schema.properties
        assert field in item_schema.required

    result = gemini_service._EXTRACTION_RESULT_SCHEMA
    assert "_scratchpad" in result.required, "visible reasoning must not be optional"


def test_the_scratchpad_never_reaches_the_client():
    """It is reasoning scaffolding, not user-facing copy. ScanResult ignoring
    unknown keys is what keeps it internal, so pin that rather than assuming it."""
    from models import ScanResult

    result = ScanResult(**{
        "_scratchpad": "a) generic equivalent ... d) atwater ...",
        "food_name": "Branza telemea", "weight_g": 100.0, "calories": 260,
        "protein": 17.0, "carbs": 1.0, "fats": 21.0, "fiber": 0.0,
        "sugar": 1.0, "sodium": 1200.0, "confidence_note": "",
        "ingredients": [],
    })

    assert not hasattr(result, "_scratchpad")
    assert "_scratchpad" not in result.model_dump()


# ---------------------------------------------------------------------------
# End to end through the real fan-out
# ---------------------------------------------------------------------------
def test_totals_equal_the_sum_of_model_priced_ingredients(db):
    """The "top-level == sum of its ingredients" contract is guaranteed by code,
    never trusted from the model — that must still hold now the ingredients
    arrive pre-priced."""
    data = {
        "food_name": "Oua cu branza",
        "confidence_note": "",
        "ingredients": [
            _item(name="Oua fierte", search_name="boiled egg", weight_g=100.0,
                  calories=155.0, protein=13.0, carbs=1.1, fats=11.0,
                  fiber=0.0, sugar=1.1, sodium=124.0),
            _item(name="Branza", weight_g=50.0, calories=130.0, protein=8.5,
                  carbs=0.5, fats=10.5, fiber=0.0, sugar=0.5, sodium=600.0),
        ],
    }

    out = asyncio.run(gemini_service._resolve_and_price_ingredients(data))

    assert out["calories"] == round(sum(i["calories"] for i in out["ingredients"]))
    assert out["protein"] == pytest.approx(
        round(sum(i["protein"] for i in out["ingredients"]), 1), abs=0.05
    )
    assert out["weight_g"] == pytest.approx(150.0)
    assert db["lookups"] == 0
    assert all(i["macro_source"] == gemini_service.MACRO_SOURCE_AI_ESTIMATE
               for i in out["ingredients"])
