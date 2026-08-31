from services.pet_service import MAX_HEARTS, apply_result, evaluate_day, heal_one, mood_for_hearts


def test_evaluate_day_good_day():
    assert evaluate_day(
        has_food_logs=True, calories=2000, target_calories=2000, water_ml=3000, target_water_ml=3000
    ) is True


def test_evaluate_day_fails_with_no_food_logs():
    assert evaluate_day(
        has_food_logs=False, calories=0, target_calories=2000, water_ml=3000, target_water_ml=3000
    ) is False


def test_evaluate_day_fails_when_calories_over_tolerance():
    # 2000 target, +10% tolerance = 2200 ceiling — 2201 is just over it
    assert evaluate_day(
        has_food_logs=True, calories=2201, target_calories=2000, water_ml=3000, target_water_ml=3000
    ) is False


def test_evaluate_day_fails_when_calories_under_tolerance():
    # 2000 target, -10% tolerance = 1800 floor — 1799 is just under it
    assert evaluate_day(
        has_food_logs=True, calories=1799, target_calories=2000, water_ml=3000, target_water_ml=3000
    ) is False


def test_evaluate_day_exact_tolerance_boundary_passes():
    assert evaluate_day(
        has_food_logs=True, calories=2200, target_calories=2000, water_ml=3000, target_water_ml=3000
    ) is True
    assert evaluate_day(
        has_food_logs=True, calories=1800, target_calories=2000, water_ml=3000, target_water_ml=3000
    ) is True


def test_evaluate_day_fails_when_water_short_of_target():
    assert evaluate_day(
        has_food_logs=True, calories=2000, target_calories=2000, water_ml=2999, target_water_ml=3000
    ) is False


def test_evaluate_day_water_over_target_is_fine():
    assert evaluate_day(
        has_food_logs=True, calories=2000, target_calories=2000, water_ml=5000, target_water_ml=3000
    ) is True


def test_apply_result_good_day_regenerates_a_heart():
    assert apply_result(1, good_day=True) == 2


def test_apply_result_good_day_clamps_at_max():
    assert apply_result(MAX_HEARTS, good_day=True) == MAX_HEARTS


def test_apply_result_bad_day_costs_a_heart():
    assert apply_result(2, good_day=False) == 1


def test_apply_result_bad_day_clamps_at_zero():
    assert apply_result(0, good_day=False) == 0


def test_heal_one_restores_a_heart():
    # The weekly Discover-challenge reward — +1, never -1.
    assert heal_one(1) == 2


def test_heal_one_clamps_at_max():
    assert heal_one(MAX_HEARTS) == MAX_HEARTS


def test_heal_one_from_zero():
    assert heal_one(0) == 1


def test_mood_for_hearts():
    assert mood_for_hearts(4) == "happy"
    assert mood_for_hearts(3) == "content"
    assert mood_for_hearts(2) == "hungry"
    assert mood_for_hearts(1) == "worried"
    assert mood_for_hearts(0) == "sick"
