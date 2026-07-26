from services.gemini_service import _reconcile_calories


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
