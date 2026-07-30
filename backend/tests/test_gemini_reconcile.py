from services.gemini_service import _finalize_ingredients, _reconcile_calories


def test_reconcile_calories_leaves_consistent_values_alone():
    # 40g protein + 50g carbs + 10g fat -> 40*4 + 50*4 + 10*9 = 450 kcal
    assert _reconcile_calories(450, protein=40, carbs=50, fats=10) == 450


def test_reconcile_calories_leaves_small_rounding_noise_alone():
    # Within tolerance (well under 15%/50kcal of the 450 expected minimum) —
    # this is normal model rounding, not a broken response.
    assert _reconcile_calories(470, protein=40, carbs=50, fats=10) == 470


def test_reconcile_calories_corrects_genuine_undercount():
    # 100g protein + 100g carbs + 50g fat -> expected minimum = 100*4 + 100*4 + 50*9 = 1250
    # Reported far below that (a broken/hallucinated figure) gets corrected up.
    assert _reconcile_calories(400, protein=100, carbs=100, fats=50) == 1250.0


def test_reconcile_calories_never_lowers_a_legitimate_overcount():
    # Alcoholic drinks (and similar) legitimately exceed the protein/carbs/fats
    # Atwater sum — e.g. a beer's ~150 kcal vs. ~48 kcal implied by its
    # (mostly carb) macros, since alcohol itself isn't tracked as a macro
    # here. This must never be "corrected" down to the macro-implied minimum.
    assert _reconcile_calories(150, protein=1, carbs=12, fats=0) == 150


def _item(food_name, weight_g, calories, protein=0.0, carbs=0.0, fats=0.0, fiber=0.0):
    return {
        "food_name": food_name,
        "weight_g": weight_g,
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fats": fats,
        "fiber": fiber,
    }


def test_finalize_ingredients_sums_top_level_from_ingredients_not_model():
    # Top-level fields deliberately disagree with what the ingredients array
    # actually sums to — this is the scenario _finalize_ingredients exists
    # for: the deterministic sum must win, never the model's own top-level
    # arithmetic.
    data = {
        "food_name": "Porridge with banana",
        "weight_g": 999,
        "calories": 999,
        "protein": 999,
        "carbs": 999,
        "fats": 999,
        "fiber": 999,
        "ingredients": [
            _item("Oats", 80, 300, protein=10, carbs=54, fats=6, fiber=8),
            _item("Banana", 118, 105, protein=1.3, carbs=27, fats=0.4, fiber=3.1),
        ],
    }
    result = _finalize_ingredients(data)
    assert result["weight_g"] == 198
    assert result["calories"] == 405
    assert result["protein"] == 11.3
    assert result["carbs"] == 81
    assert result["fats"] == 6.4
    assert result["fiber"] == 11.1
    assert len(result["ingredients"]) == 2


def test_finalize_ingredients_reconciles_each_ingredient_before_summing():
    # The oats entry under-counts calories relative to its own macros
    # (10*4 + 54*4 + 6*9 = 310, well above the reported 120) — this must be
    # corrected per-ingredient BEFORE the sum, not just once at the top level,
    # otherwise a broken component-level guess would silently survive inside
    # an otherwise-plausible-looking total.
    data = {
        "food_name": "Oats only",
        "weight_g": 80,
        "calories": 120,
        "protein": 10,
        "carbs": 54,
        "fats": 6,
        "fiber": 8,
        "ingredients": [_item("Oats", 80, 120, protein=10, carbs=54, fats=6, fiber=8)],
    }
    result = _finalize_ingredients(data)
    assert result["ingredients"][0]["calories"] == 310.0
    assert result["calories"] == 310.0


def test_finalize_ingredients_falls_back_to_implicit_single_ingredient():
    # A schema-violation edge case (model didn't populate the array despite
    # it being required) must still produce a consistent, non-empty
    # ingredients list rather than an inconsistent/empty one.
    data = {
        "food_name": "Chicken breast",
        "weight_g": 150,
        "calories": 250,
        "protein": 45,
        "carbs": 0,
        "fats": 6,
        "fiber": 0,
        "ingredients": [],
    }
    result = _finalize_ingredients(data)
    assert len(result["ingredients"]) == 1
    assert result["ingredients"][0]["food_name"] == "Chicken breast"
    assert result["weight_g"] == 150
    assert result["calories"] == 250
