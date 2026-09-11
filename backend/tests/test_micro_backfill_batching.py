"""Fiber/sugar/sodium enrichment must cost ONE call, not one per ingredient.

THE COST BUG THIS GUARDS. A verified USDA/Open Food Facts match is often
silent on fiber/sugar/sodium, and nutrition_db_service deliberately OMITS
those fields rather than reporting a fabricated 0 (so "unverified" stays
distinguishable from "verified zero"). _fill_missing_micros filled the gap
from the model's own recall — correct, but it ran inside the per-ingredient
fan-out, so a six-ingredient plate made six billed calls, each carrying
TEXT_ONLY_MACRO_PROMPT's full ~1,850-token macro-estimation apparatus, to
keep three numbers out of the eight it asked for. That enrichment cost more
than the vision call that produced the meal.

The fix is batching, NOT dropping the data: one compact call for every
ingredient at once, after the fan-out. These tests pin both halves — the call
count AND that every micro still lands on the row, scaled, with the meal
totals still equal to the sum of their ingredients.
"""
import asyncio
import json

import pytest

import services.gemini_service as gemini_service
from services import custom_food_service, food_cache_service, nutrition_db_service

# A database match with calories/protein/carbs/fats but no micros at all —
# the Open Food Facts shape, which is most branded food.
DB_MATCH_NO_MICROS = {
    "calories_per_100g": 150.0,
    "protein_per_100g": 12.0,
    "carbs_per_100g": 10.0,
    "fats_per_100g": 8.0,
    "source": "openfoodfacts",
}
DB_MATCH_COMPLETE = {
    **DB_MATCH_NO_MICROS,
    "fiber_per_100g": 3.0,
    "sugar_per_100g": 2.0,
    "sodium_per_100g": 300.0,
    "source": "usda",
}


@pytest.fixture(autouse=True)
def _clean_caches():
    food_cache_service._cache.clear()
    yield
    food_cache_service._cache.clear()


@pytest.fixture
def pipeline(monkeypatch):
    """Stubs the provider transport and the nutrition DB, and records every
    call that would hit the paid key."""
    state = {"calls": [], "micro_requests": [], "db_match": DB_MATCH_NO_MICROS,
             "micro_reply": None, "micro_error": None}

    def _stage1(names):
        return json.dumps({
            "food_name": "Test meal",
            "confidence_note": "",
            "ingredients": [
                {"food_name": n, "search_name": n, "weight_g": 50} for n in names
            ],
        })

    state["names"] = ["egg, whole, cooked", "cheese, cheddar", "butter"]

    async def _fake_generate_content(*args, **kwargs):
        state["calls"].append("vision")

        class _R:
            text = _stage1(state["names"])
            candidates = []

        return _R()

    async def _fake_generate_text(*args, **kwargs):
        state["calls"].append("text")
        asked = [
            line.strip("- ").strip()
            for line in (kwargs.get("user_content") or "").splitlines()
            if line.strip()
        ]
        state["micro_requests"].append(asked)
        if state["micro_error"] is not None:
            raise state["micro_error"]
        if state["micro_reply"] is not None:
            return state["micro_reply"]
        return json.dumps({
            "items": [
                {"name": n, "fiber_per_100g": 2.0, "sugar_per_100g": 1.0,
                 "sodium_per_100g": 400.0}
                for n in asked
            ]
        })

    async def _lookup_best(*args, **kwargs):
        match = state["db_match"]
        return dict(match) if match else None

    async def _fuzzy(*args, **kwargs):
        return None

    async def _get_many(*args, **kwargs):
        return {}

    monkeypatch.setattr(gemini_service, "_generate_content", _fake_generate_content)
    monkeypatch.setattr(gemini_service, "_generate_text", _fake_generate_text)
    monkeypatch.setattr(nutrition_db_service, "lookup_best", _lookup_best)
    monkeypatch.setattr(nutrition_db_service, "lookup_custom_fuzzy", _fuzzy)
    monkeypatch.setattr(custom_food_service, "get_many", _get_many)
    return state


async def _scan(state):
    return await gemini_service.analyze_food_image(
        b"\xff\xd8fake", "image/jpeg", "", None, "en", None
    )


def _counts(state):
    out = {}
    for kind in state["calls"]:
        out[kind] = out.get(kind, 0) + 1
    return out


# --- the call count ---------------------------------------------------------


@pytest.mark.parametrize("n_ingredients", [1, 3, 6, 12])
def test_any_number_of_ingredients_costs_exactly_one_backfill_call(pipeline, n_ingredients):
    """The whole point. Before batching this was N calls; the assertion is on
    the COUNT, not on a ratio, so a regression to per-ingredient calls fails
    here loudly no matter how the fan-out is written."""
    pipeline["names"] = [f"test food {i}" for i in range(n_ingredients)]
    asyncio.run(_scan(pipeline))

    assert _counts(pipeline) == {"vision": 1, "text": 1}
    assert len(pipeline["micro_requests"]) == 1
    assert len(pipeline["micro_requests"][0]) == n_ingredients


def test_no_backfill_call_at_all_when_the_database_supplied_every_micro(pipeline):
    """USDA maps fiber/sugar/sodium, so a USDA-grounded meal must not pay for
    an enrichment call it does not need."""
    pipeline["db_match"] = DB_MATCH_COMPLETE
    asyncio.run(_scan(pipeline))

    assert _counts(pipeline) == {"vision": 1}


def test_repeated_food_names_are_asked_about_once(pipeline):
    pipeline["names"] = ["butter", "butter", "butter"]
    asyncio.run(_scan(pipeline))

    assert pipeline["micro_requests"][0] == ["butter"]


# --- the data, which must NOT be lost ---------------------------------------


def test_every_micro_lands_on_its_row_scaled_to_that_row_s_weight(pipeline):
    """2.0g fiber per 100g on a 50g portion is 1.0g. Zero is a failure here,
    not an acceptable degradation — that was the explicit requirement."""
    result = asyncio.run(_scan(pipeline))

    for row in result["ingredients"]:
        assert row["fiber"] == 1.0
        assert row["sugar"] == 0.5
        assert row["sodium"] == 200.0


def test_meal_totals_still_equal_the_sum_of_their_ingredients(pipeline):
    """The backfill runs before the totals are summed. If it ever moved after
    them, the meal would report the pre-backfill zeros while the rows beneath
    showed real figures."""
    result = asyncio.run(_scan(pipeline))
    rows = result["ingredients"]

    assert result["fiber"] == round(sum(r["fiber"] for r in rows), 1)
    assert result["sugar"] == round(sum(r["sugar"] for r in rows), 1)
    assert result["sodium"] == round(sum(r["sodium"] for r in rows), 1)


def test_internal_pending_marker_never_reaches_the_response(pipeline):
    """_pending_micros is plumbing between two passes of the pricing stage.
    IngredientItem would not carry it and a client must never see it."""
    result = asyncio.run(_scan(pipeline))

    for row in result["ingredients"]:
        assert not [key for key in row if key.startswith("_")]


def test_a_name_the_model_failed_to_echo_falls_back_to_position(pipeline):
    """The prompt asks for the list back in order with `name` echoed. Models
    tidy spellings and translate; when the echo misses, the Nth answer is
    still the Nth food, and using it beats discarding real data."""
    pipeline["names"] = ["unt", "branza"]
    pipeline["micro_reply"] = json.dumps({
        "items": [
            {"name": "Butter", "fiber_per_100g": 0.0, "sugar_per_100g": 0.1, "sodium_per_100g": 11.0},
            {"name": "Cheese", "fiber_per_100g": 0.0, "sugar_per_100g": 0.5, "sodium_per_100g": 621.0},
        ]
    })
    result = asyncio.run(_scan(pipeline))

    assert result["ingredients"][0]["sodium"] == 5.5   # 11.0 mg/100g at 50g
    assert result["ingredients"][1]["sodium"] == 310.5  # 621.0 mg/100g at 50g


# --- best-effort: a backfill failure must never fail the scan ---------------


def test_a_failed_backfill_leaves_micros_at_zero_and_still_returns_the_meal(pipeline):
    """Same contract the per-ingredient version had: enrichment is the last,
    most optional thing in the pipeline. It may never take a scan down."""
    pipeline["micro_error"] = RuntimeError("provider exploded")
    result = asyncio.run(_scan(pipeline))

    assert result["calories"] > 0, "the meal must still be priced"
    for row in result["ingredients"]:
        assert row["fiber"] == 0.0
        assert not [key for key in row if key.startswith("_")], "marker cleared even on failure"


def test_a_malformed_backfill_reply_is_ignored_rather_than_trusted(pipeline):
    pipeline["micro_reply"] = json.dumps({"items": [{"name": "egg, whole, cooked",
                                                     "fiber_per_100g": "not a number",
                                                     "sugar_per_100g": -5,
                                                     "sodium_per_100g": 400.0}]})
    result = asyncio.run(_scan(pipeline))

    first = result["ingredients"][0]
    assert first["fiber"] == 0.0, "a non-numeric figure must not be written"
    assert first["sugar"] == 0.0, "a negative figure must not be written"
    assert first["sodium"] == 200.0, "the valid field on the same item still applies"


# --- the prompt itself ------------------------------------------------------


def test_the_batch_prompt_is_far_cheaper_than_the_macro_prompt_it_replaced():
    """It used to reuse TEXT_ONLY_MACRO_PROMPT, which mandates a four-part
    visible scratchpad plus all eight macro fields — of which this path keeps
    three. The input saving is per call AND the call count dropped to one."""
    assert len(gemini_service.MICRO_BACKFILL_PROMPT) < len(gemini_service.TEXT_ONLY_MACRO_PROMPT) / 4


def test_the_batch_prompt_keeps_the_untrusted_data_framing():
    """Every prompt in this file carries the same injection defence and the
    same invalid_input escape hatch, regardless of task. A cheaper prompt does
    not get to opt out of the security contract."""
    prompt = gemini_service.MICRO_BACKFILL_PROMPT
    assert "untrusted" in prompt.lower()
    assert "invalid_input" in prompt
