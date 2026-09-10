"""Regression coverage for the barcode path's own serialization 500s.

routers/barcode.py returns a ScanResult built by
barcode_lookup.reshape_off_product, from figures Open Food Facts
contributors typed by hand. Nothing between those two points validated
magnitude or even type, and the router wraps none of it in a try/except —
so a single odd community entry was a 500 for whoever scanned that product.

Five distinct shapes did it, all reproduced below from real-world data
patterns rather than invented extremes. The long-product-name case is the
one that mattered most in practice: it needs no bad data at all, just a
product whose name runs past 100 characters, which is ordinary on Open
Food Facts.

These assert against the constructed ScanResult, so they fail if the bounds
in models.py and the clamp ever drift apart again.
"""

import pytest

from models import (
    MAX_INGREDIENT_CALORIES,
    MAX_INGREDIENT_NAME_CHARS,
    MAX_INGREDIENT_SODIUM_MG,
)
from services.barcode_lookup import reshape_off_product

# A complete, entirely ordinary label — each test perturbs one field of it.
_BASE = {"energy-kcal_100g": 250, "proteins_100g": 5, "carbohydrates_100g": 30, "fat_100g": 10}


def _product(name="Test product", **nutriments):
    return {"product_name": name, "nutriments": {**_BASE, **nutriments}}


def test_product_name_over_100_chars_is_truncated_for_the_ingredient_row():
    """No bad data needed — IngredientItem.food_name stops at 100 while the
    reshape truncates at 200, so any longer-named product was a hard 500."""
    long_name = (
        "Chocolat noir 70% cacao bio equitable tablette de degustation origine "
        "Perou fabrique en France sans huile de palme edition limitee"
    )
    assert len(long_name) > MAX_INGREDIENT_NAME_CHARS

    result = reshape_off_product(_product(long_name))

    # <=, not ==: the clamp strips after truncating, so a name cut mid-space
    # lands just under the ceiling.
    ingredient_name = result.ingredients[0].food_name
    assert 0 < len(ingredient_name) <= MAX_INGREDIENT_NAME_CHARS
    assert long_name.startswith(ingredient_name)
    # The header keeps the fuller name, since that is what the user saves and
    # DailyLogCreate.food_name accepts 200 of it.
    assert result.food_name == long_name


def test_salt_sodium_is_clamped_rather_than_rejected():
    """Sea salt really is ~38.7g of sodium per 100g. Open Food Facts reports
    that field in grams, so x1000 puts a CORRECT label past the mg bound."""
    result = reshape_off_product(_product("Sea salt", sodium_100g=38.7))

    assert result.ingredients[0].sodium == MAX_INGREDIENT_SODIUM_MG
    assert result.sodium == result.ingredients[0].sodium


def test_kilojoules_typed_into_the_kcal_field_is_clamped():
    result = reshape_off_product(_product("Olive oil", **{"energy-kcal_100g": 37000}))

    assert result.ingredients[0].calories == MAX_INGREDIENT_CALORIES


def test_negative_value_is_floored_at_zero():
    result = reshape_off_product(_product("Typo'd entry", proteins_100g=-5))

    assert result.ingredients[0].protein == 0


def test_numeric_strings_are_accepted():
    """Community entries commonly store nutriments as strings; this already
    worked via float() and must keep working."""
    result = reshape_off_product(
        _product("Yogurt", **{"energy-kcal_100g": "250", "proteins_100g": "5",
                              "carbohydrates_100g": "30", "fat_100g": "10"})
    )

    assert result.calories == 250


@pytest.mark.parametrize("junk", ["n/a", "", "unknown", float("nan")])
def test_unparseable_required_field_reads_as_incomplete_data(junk):
    """None is the "incomplete nutrition data" signal both callers already
    handle (barcode.py's 422, discover.py skipping the row) — the right
    reading for "n/a" in the fat field, and not a 500."""
    assert reshape_off_product(_product("Mystery", fat_100g=junk)) is None


@pytest.mark.parametrize("junk", ["n/a", "", float("inf")])
def test_unparseable_optional_field_degrades_to_zero(junk):
    """An unusable fibre figure is not worth rejecting an otherwise-complete
    label over — same reasoning as an absent one."""
    result = reshape_off_product(_product("Cereal", fiber_100g=junk))

    assert result is not None
    assert result.ingredients[0].fiber == 0


def test_a_correct_high_fibre_label_is_not_rewritten():
    """The barcode path clamps magnitude but must NOT run the AI pipeline's
    Atwater consistency pass: fibre isn't fully metabolised, so a correct
    label legitimately prints fewer calories than 4/4/9 implies. Reconciling
    here would inflate this product's real 250 kcal to 325."""
    result = reshape_off_product(
        _product("High fibre cereal", **{"energy-kcal_100g": 250, "proteins_100g": 10,
                                         "carbohydrates_100g": 60, "fat_100g": 5,
                                         "fiber_100g": 30})
    )

    assert result.calories == 250
    assert result.ingredients[0].calories == 250


def test_ordinary_product_passes_through_untouched():
    """The clamp must be invisible for the overwhelmingly common case."""
    result = reshape_off_product(_product("Plain yogurt", sodium_100g=0.05))

    item = result.ingredients[0]
    assert (item.calories, item.protein, item.carbs, item.fats) == (250, 5.0, 30.0, 10.0)
    assert item.sodium == 50.0
    assert item.weight_g == 100.0
