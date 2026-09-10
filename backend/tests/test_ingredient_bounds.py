"""Regression coverage for the "image + context_text scan 500s" bug.

Every route that returns a ScanResult declares it as `response_model=`, so
FastAPI validates the handler's return value during *serialization* — after
the handler has returned, and therefore outside the try/except that
routers/scan.py wraps its own work in. ScanResult's own top-level fields
carry no bounds, but IngredientItem's do (models.py), so a single
out-of-range ingredient figure could not be caught, worded, or refunded by
the router: it fell through to main.py's generic 500 with the user's scan
already spent.

The photo-scan path is where this was reachable most easily, because
context_text feeds Stage 1's EXPLICIT_VALUES rule and _resolve_ingredient
trusts a user-stated number above every other source by design — nothing
downstream questioned its magnitude.

These tests assert the pipeline's output actually satisfies IngredientItem,
by constructing the real model rather than by re-checking the same numbers
the clamp just wrote.
"""

import asyncio

import pytest

from models import (
    MAX_INGREDIENT_CALORIES,
    MAX_INGREDIENT_FIBER_G,
    MAX_INGREDIENT_MACRO_G,
    MAX_INGREDIENT_SODIUM_MG,
    MAX_INGREDIENT_WEIGHT_G,
    ScanResult,
)
from services import gemini_service


def _resolve(data: dict) -> dict:
    """Stage 2+3 with no user_id, so no custom-food prefetch runs (that is a
    Supabase call); grounding is already disabled suite-wide by conftest."""
    return asyncio.run(gemini_service._resolve_and_price_ingredients(data))


def _stage1(**ingredient) -> dict:
    """Stage 1's real output shape — ingredients carry identification and
    weight only, plus any explicit_* value lifted from the user's text."""
    ingredient.setdefault("food_name", "Tray bake")
    ingredient.setdefault("search_name", "tray bake")
    return {"food_name": "Tray bake", "ingredients": [ingredient]}


def test_user_stated_totals_from_context_text_stay_serializable():
    """The original repro: an image plus context_text reading like "the whole
    tray, about 5 kg, 30000 calories total". Every explicit_* value is taken
    at face value by _resolve_ingredient, which is the intended behavior —
    the clamp is what keeps it from reaching Pydantic over-range."""
    data = _resolve(
        _stage1(
            weight_g=5000,
            explicit_calories=30000,
            explicit_protein=2500,
            explicit_carbs=3000,
            explicit_fats=1200,
        )
    )

    result = ScanResult(**data)  # would raise ValidationError before the fix

    item = result.ingredients[0]
    assert item.calories == MAX_INGREDIENT_CALORIES
    assert item.carbs == MAX_INGREDIENT_MACRO_G
    # The user's stated figures are still honoured as far as the bounds
    # allow — this clamps magnitude, it does not discard provenance.
    assert item.macro_source == "user_stated"


def test_absurd_weight_is_clamped_and_stays_internally_consistent():
    """weight_g is Stage 1's own estimate and was only ever floored at 0.
    Clamping it has to re-run the existing reconcilers, or the row ends up
    field-by-field in range while describing an impossible food."""
    data = _resolve(_stage1(weight_g=50000, explicit_calories=46000,
                            explicit_protein=1, explicit_carbs=1, explicit_fats=1))

    item = ScanResult(**data).ingredients[0]

    assert item.weight_g == MAX_INGREDIENT_WEIGHT_G
    # Calories re-checked against the CLAMPED weight, not the original one.
    assert item.calories <= item.weight_g * gemini_service._CALORIE_DENSITY_CEILING


def test_top_level_totals_are_the_sum_of_the_clamped_ingredients():
    """The pipeline's "top-level == sum of ingredients, guaranteed by code"
    contract has to hold against the clamped figures, not the raw ones —
    otherwise the meal circle disagrees with the breakdown under it."""
    data = _resolve(
        {
            "food_name": "Platter",
            "ingredients": [
                {"food_name": "Tray bake", "search_name": "tray bake", "weight_g": 5000,
                 "explicit_calories": 30000, "explicit_protein": 100,
                 "explicit_carbs": 100, "explicit_fats": 100},
                {"food_name": "Bread", "search_name": "bread", "weight_g": 200,
                 "explicit_calories": 500, "explicit_protein": 10,
                 "explicit_carbs": 90, "explicit_fats": 5},
            ],
        }
    )

    result = ScanResult(**data)
    assert result.calories == round(sum(i.calories for i in result.ingredients))
    assert result.weight_g == pytest.approx(sum(i.weight_g for i in result.ingredients), abs=0.1)


def test_whitespace_only_food_name_falls_back_instead_of_failing_min_length():
    """food_name carries min_length=1, and the old
    `(item.get("food_name") or "Food").strip()` yielded "" for a
    whitespace-only name — a truthy string, so `or` never fired."""
    data = _resolve({"food_name": "  ", "ingredients": [{"food_name": "   ", "weight_g": 0}]})

    assert ScanResult(**data).ingredients[0].food_name == "Food"


@pytest.mark.parametrize(
    "field, value, ceiling",
    [
        # Milligrams, and reconciled against nothing — a salt-heavy per-100g
        # figure scaled to a large portion clears this on its own, with the
        # rest of the ingredient looking entirely ordinary.
        ("sodium", 99000, MAX_INGREDIENT_SODIUM_MG),
        ("fiber", 4000, MAX_INGREDIENT_FIBER_G),
        ("sugar", 9000, MAX_INGREDIENT_MACRO_G),
    ],
)
def test_unreconciled_micro_fields_are_clamped(field, value, ceiling):
    item = gemini_service._clamp_ingredient(
        {"food_name": "Soy sauce", "weight_g": 500, "calories": 300,
         "protein": 10, "carbs": 20, "fats": 1, field: value}
    )

    assert item[field] == ceiling


@pytest.mark.parametrize("bad", [None, "", "not-a-number", float("nan"), float("inf"), -50])
def test_non_numeric_and_non_finite_figures_become_zero(bad):
    """A model can emit a well-keyed but badly-typed value despite strict
    JSON mode. NaN matters specifically: it compares False against every
    bound, so it fails Pydantic's `le=` check while surviving a naive
    min()/max() clamp untouched."""
    item = gemini_service._clamp_ingredient(
        {"food_name": "Rice", "weight_g": 100, "calories": bad,
         "protein": bad, "carbs": bad, "fats": bad, "sodium": bad}
    )

    assert item["calories"] == 0
    assert item["protein"] == 0
    assert item["sodium"] == 0


def test_clamp_preserves_untouched_keys():
    """_clamp_ingredient rewrites figures only — provenance and any future
    key a caller attaches must survive it."""
    item = gemini_service._clamp_ingredient(
        {"food_name": "Rice", "weight_g": 100, "calories": 130, "protein": 3,
         "carbs": 28, "fats": 0.3, "macro_source": "usda"}
    )

    assert item["macro_source"] == "usda"
    assert item["calories"] == 130
