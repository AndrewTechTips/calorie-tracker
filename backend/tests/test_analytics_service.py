import pytest

from services.analytics_service import (
    build_weight_forecast,
    calculate_bmr,
    calculate_tdee,
    calculate_tdee_with_logged_activity,
    compute_weight_trend_rate,
    detect_anomalous_days,
    estimate_tdee_from_regression,
    evaluate_adaptive_goal,
    project_weight_forecast,
    rebalance_macros,
)


def _weight_row(day: int, weight_kg: float) -> dict:
    return {"logged_at": f"2026-08-{day:02d}T08:00:00Z", "weight_kg": weight_kg}


# ---------------------------------------------------------------------------
# calculate_bmr / calculate_tdee
# ---------------------------------------------------------------------------
def test_calculate_bmr_mifflin_male():
    # 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
    assert calculate_bmr(80, age=30, height_cm=180, sex="male") == pytest.approx(1780)


def test_calculate_bmr_mifflin_female():
    # Same inputs as above, -161 instead of +5 = 1614
    assert calculate_bmr(80, age=30, height_cm=180, sex="female") == pytest.approx(1614)


def test_calculate_bmr_falls_back_to_weight_only_when_biometrics_missing():
    assert calculate_bmr(80) == pytest.approx(22 * 80)
    # Partial biometrics (missing sex) still falls back — all three required.
    assert calculate_bmr(80, age=30, height_cm=180) == pytest.approx(22 * 80)


def test_calculate_tdee_applies_activity_multiplier():
    assert calculate_tdee(1780, "moderate") == pytest.approx(1780 * 1.55)
    assert calculate_tdee(1780, "sedentary") == pytest.approx(1780 * 1.2)


def test_calculate_tdee_unknown_activity_defaults_to_moderate():
    assert calculate_tdee(1780, "not_a_real_level") == calculate_tdee(1780, "moderate")


# ---------------------------------------------------------------------------
# calculate_tdee_with_logged_activity — Workout Diary integration
# ---------------------------------------------------------------------------
def test_calculate_tdee_with_logged_activity_falls_through_when_no_workout_data():
    # Zero behavior change for a user who hasn't adopted the Workout Diary.
    assert calculate_tdee_with_logged_activity(1780, "active", 0) == calculate_tdee(1780, "active")


def test_calculate_tdee_with_logged_activity_uses_sedentary_baseline_plus_measured_burn():
    result = calculate_tdee_with_logged_activity(1780, "active", 300)
    assert result == pytest.approx(1780 * 1.2 + 300)
    # Deliberately NOT bmr * the "active" multiplier + 300 — that would
    # double-count, since "active" already assumes real training frequency.
    assert result != pytest.approx(calculate_tdee(1780, "active") + 300)


# ---------------------------------------------------------------------------
# detect_anomalous_days — Goldberg-EI:BMR-style under-logging heuristic
# ---------------------------------------------------------------------------
def test_detect_anomalous_days_flags_implausibly_low_day_only():
    daily_calories = {"2026-08-01": 500, "2026-08-02": 1900, "2026-08-03": 0}
    anomalies = detect_anomalous_days(daily_calories, bmr_estimate=1800)
    assert [a.date for a in anomalies] == ["2026-08-01"]
    assert anomalies[0].ratio == pytest.approx(500 / 1800, rel=1e-2)


def test_detect_anomalous_days_ignores_zero_calorie_days():
    # A day with literally no logs shouldn't be flagged as *suspicious* data —
    # it's just absent, handled upstream by never being in this dict at all.
    anomalies = detect_anomalous_days({"2026-08-01": 0}, bmr_estimate=1800)
    assert anomalies == []


def test_detect_anomalous_days_no_bmr_returns_nothing():
    assert detect_anomalous_days({"2026-08-01": 100}, bmr_estimate=0) == []


# ---------------------------------------------------------------------------
# compute_weight_trend_rate — mirrors nutritionMath.js's computeLinearTrendRate
# ---------------------------------------------------------------------------
def test_compute_weight_trend_rate_perfect_linear_loss():
    rows = [_weight_row(day, 80.0 - 0.1 * (day - 1)) for day in range(1, 8)]  # -0.1kg/day
    rate = compute_weight_trend_rate(rows)
    assert rate == pytest.approx(-0.7, abs=1e-6)  # -0.1kg/day * 7


def test_compute_weight_trend_rate_needs_at_least_two_points():
    assert compute_weight_trend_rate([_weight_row(1, 80.0)]) is None
    assert compute_weight_trend_rate([]) is None


# ---------------------------------------------------------------------------
# estimate_tdee_from_regression
# ---------------------------------------------------------------------------
def test_estimate_tdee_from_regression_losing_weight_implies_higher_tdee():
    # Eating 2500/day while losing 0.5kg/week means true TDEE is above 2500.
    tdee = estimate_tdee_from_regression(mean_daily_calories=2500, weekly_rate_kg=-0.5)
    assert tdee == pytest.approx(2500 + (0.5 / 7) * 7700)


def test_estimate_tdee_from_regression_gaining_weight_implies_lower_tdee():
    tdee = estimate_tdee_from_regression(mean_daily_calories=2500, weekly_rate_kg=0.5)
    assert tdee == pytest.approx(2500 - (0.5 / 7) * 7700)


# ---------------------------------------------------------------------------
# project_weight_forecast — the "dynamic" (not naive-linear) simulation
# ---------------------------------------------------------------------------
def test_project_weight_forecast_decelerates_as_deficit_narrows():
    # A large starting deficit (1300 kcal/day) makes the deceleration clear
    # well above the projection's 1-decimal rounding — a modest deficit
    # decelerates too, just by less than 0.1kg per 30-day window here.
    points = project_weight_forecast(100.0, avg_daily_calories=1200.0, tdee_at_current_weight=2500.0)
    by_day = {p.days: p.weight_kg for p in points}
    assert set(by_day) == {30, 60, 90}
    loss_0_30 = 100.0 - by_day[30]
    loss_30_60 = by_day[30] - by_day[60]
    loss_60_90 = by_day[60] - by_day[90]
    # Weight is dropping throughout (sustained deficit)...
    assert loss_0_30 > 0 and loss_30_60 > 0 and loss_60_90 > 0
    # ...but each successive 30-day window loses LESS than the one before it,
    # because TDEE itself falls as projected weight falls — the deceleration
    # a naive straight-line projection wouldn't show.
    assert loss_0_30 > loss_30_60 > loss_60_90


def test_project_weight_forecast_surplus_gains_weight():
    points = project_weight_forecast(70.0, avg_daily_calories=3000.0, tdee_at_current_weight=2500.0)
    by_day = {p.days: p.weight_kg for p in points}
    assert by_day[90] > by_day[60] > by_day[30] > 70.0


def test_project_weight_forecast_invalid_current_weight_returns_empty():
    assert project_weight_forecast(0, 2000, 2500) == []
    assert project_weight_forecast(-5, 2000, 2500) == []


# ---------------------------------------------------------------------------
# build_weight_forecast — orchestration
# ---------------------------------------------------------------------------
def test_build_weight_forecast_no_weight_logs_is_insufficient():
    result = build_weight_forecast(
        weight_rows=[],
        daily_calories={},
        age=None,
        height_cm=None,
        biological_sex=None,
        activity_level="moderate",
        retention_days=7,
    )
    assert result.data_sufficient is False
    assert result.method == "insufficient"
    assert result.projections == []
    assert result.anomaly_window_days == 7


def test_build_weight_forecast_uses_regression_with_enough_history():
    weight_rows = [_weight_row(day, 90.0 - 0.15 * (day - 1)) for day in range(1, 8)]  # 7 pts, 6-day span...
    # Extend span to satisfy MIN_WEIGHT_SPAN_DAYS_FOR_REGRESSION (10 days) —
    # use every-other-day entries across 15 days instead.
    weight_rows = [_weight_row(day, 90.0 - 0.05 * i) for i, day in enumerate(range(1, 16, 2))]
    daily_calories = {f"2026-08-{d:02d}": 2400.0 for d in range(1, 6)}  # 5 clean days
    result = build_weight_forecast(
        weight_rows=weight_rows,
        daily_calories=daily_calories,
        age=None,
        height_cm=None,
        biological_sex=None,
        activity_level="moderate",
        retention_days=7,
    )
    assert result.data_sufficient is True
    assert result.method == "regression"
    assert len(result.projections) == 3
    assert result.current_weight_kg == pytest.approx(weight_rows[-1]["weight_kg"], abs=0.05)


def test_build_weight_forecast_falls_back_to_formula_with_sparse_weight_history():
    weight_rows = [_weight_row(1, 85.0), _weight_row(3, 84.8)]  # only 2 points
    result = build_weight_forecast(
        weight_rows=weight_rows,
        daily_calories={"2026-08-01": 2200.0},
        age=30,
        height_cm=180,
        biological_sex="male",
        activity_level="moderate",
        retention_days=7,
    )
    assert result.data_sufficient is True
    assert result.method == "formula"
    # Current weight is the LATEST entry chronologically (day 3 = 84.8kg),
    # not the first one in the list.
    assert result.bmr_estimate == pytest.approx(round(calculate_bmr(84.8, 30, 180, "male")), abs=1)


def test_build_weight_forecast_regression_path_ignores_workout_calories():
    # Proves no double-counting leak: with enough weight-trend history to
    # trust the regression, the output must be byte-identical whether or
    # not avg_daily_workout_calories is supplied — that path already nets
    # out real expenditure via observed weight change vs. intake.
    weight_rows = [_weight_row(day, 90.0 - 0.05 * i) for i, day in enumerate(range(1, 16, 2))]
    daily_calories = {f"2026-08-{d:02d}": 2400.0 for d in range(1, 6)}
    kwargs = dict(
        weight_rows=weight_rows,
        daily_calories=daily_calories,
        age=None,
        height_cm=None,
        biological_sex=None,
        activity_level="moderate",
        retention_days=7,
    )
    without_workouts = build_weight_forecast(**kwargs)
    with_workouts = build_weight_forecast(**kwargs, avg_daily_workout_calories=400)
    assert without_workouts.method == "regression"
    assert with_workouts.tdee_estimate == without_workouts.tdee_estimate
    assert with_workouts.projections == without_workouts.projections


def test_build_weight_forecast_formula_path_uses_workout_calories():
    # activity_level="sedentary" ("little or no exercise") assumes roughly
    # zero training, so adding a real measured workout burn on top must
    # increase TDEE above the no-workout-data baseline.
    weight_rows = [_weight_row(1, 85.0), _weight_row(3, 84.8)]  # sparse -> formula path
    kwargs = dict(
        weight_rows=weight_rows,
        daily_calories={"2026-08-01": 2200.0},
        age=30,
        height_cm=180,
        biological_sex="male",
        activity_level="sedentary",
        retention_days=7,
    )
    without_workouts = build_weight_forecast(**kwargs)
    with_workouts = build_weight_forecast(**kwargs, avg_daily_workout_calories=350)
    assert without_workouts.method == "formula"
    assert with_workouts.tdee_estimate == pytest.approx(without_workouts.tdee_estimate + 350)


def test_build_weight_forecast_excludes_anomalous_days_from_average():
    weight_rows = [_weight_row(day, 80.0) for day in (1, 3, 5, 7, 9, 11, 13, 15)]
    daily_calories = {
        "2026-08-01": 2200.0,
        "2026-08-02": 2300.0,
        "2026-08-03": 2100.0,
        "2026-08-04": 50.0,  # implausibly low — should be flagged and excluded
    }
    result = build_weight_forecast(
        weight_rows=weight_rows,
        daily_calories=daily_calories,
        age=None,
        height_cm=None,
        biological_sex=None,
        activity_level="moderate",
        retention_days=7,
    )
    assert any(a.date == "2026-08-04" for a in result.anomalies)


# ---------------------------------------------------------------------------
# rebalance_macros — the Macro Lock feature
# ---------------------------------------------------------------------------
def test_rebalance_macros_no_lock_matches_calculator_formula():
    protein, carbs, fats = rebalance_macros(
        calories=2000, goal_type="cut", weight_kg=80,
        current_protein_g=100, current_carbs_g=200, current_fats_g=60,
        locked_macro=None,
    )
    assert protein == pytest.approx(80 * 2.2, abs=0.05)  # GOAL_PROTEIN_PER_KG["cut"]
    fat_cal = 2000 * 0.25
    assert fats == pytest.approx(fat_cal / 9, abs=0.05)
    assert carbs == pytest.approx((2000 - protein * 4 - fat_cal) / 4, abs=0.1)


def test_rebalance_macros_locked_protein_preserves_grams_and_ratio():
    protein, carbs, fats = rebalance_macros(
        calories=1800, goal_type="cut", weight_kg=70,
        current_protein_g=150, current_carbs_g=200, current_fats_g=60,
        locked_macro="protein",
    )
    assert protein == 150  # unchanged
    original_ratio = (200 * 4) / (60 * 9)
    new_ratio = (carbs * 4) / (fats * 9)
    assert new_ratio == pytest.approx(original_ratio, rel=0.02)
    # Total calories still add up (protein/carbs/fats fully spend `calories`).
    assert protein * 4 + carbs * 4 + fats * 9 == pytest.approx(1800, abs=1)


def test_rebalance_macros_locked_carbs_falls_back_to_default_split_when_others_are_zero():
    protein, carbs, fats = rebalance_macros(
        calories=2000, goal_type="maintain", weight_kg=70,
        current_protein_g=0, current_carbs_g=100, current_fats_g=0,
        locked_macro="carbs",
    )
    assert carbs == 100  # unchanged
    assert protein == pytest.approx(70 * 1.8, abs=0.05)  # GOAL_PROTEIN_PER_KG["maintain"]


def test_rebalance_macros_locked_fats_preserves_grams():
    protein, carbs, fats = rebalance_macros(
        calories=2200, goal_type="bulk", weight_kg=75,
        current_protein_g=160, current_carbs_g=250, current_fats_g=70,
        locked_macro="fats",
    )
    assert fats == 70
    assert protein * 4 + carbs * 4 + fats * 9 == pytest.approx(2200, abs=1)


# ---------------------------------------------------------------------------
# evaluate_adaptive_goal — the weekly stall evaluation
# ---------------------------------------------------------------------------
def _base_goal_kwargs(**overrides):
    kwargs = dict(
        goal_type="cut",
        current_daily_calories=2200,
        current_protein_g=150,
        current_carbs_g=200,
        current_fats_g=60,
        weight_kg=80,
        tdee_estimate=2500,
        weekly_rate_kg=-0.6,
        method="regression",
        locked_macro=None,
    )
    kwargs.update(overrides)
    return kwargs


def test_adaptive_goal_formula_method_is_always_insufficient_data():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(method="formula", weekly_rate_kg=None))
    assert result.reason == "insufficient_data"


def test_adaptive_goal_cut_on_track():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(weekly_rate_kg=-0.6))
    assert result.reason == "on_track"


def test_adaptive_goal_cut_stalled_no_progress():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(weekly_rate_kg=-0.02))
    assert result.reason == "stalled_no_progress"


def test_adaptive_goal_cut_stalled_wrong_direction():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(weekly_rate_kg=0.3))
    assert result.reason == "stalled_wrong_direction"


def test_adaptive_goal_maintain_drifting():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(goal_type="maintain", weekly_rate_kg=0.5))
    assert result.reason == "drifting"


def test_adaptive_goal_maintain_on_track():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(goal_type="maintain", weekly_rate_kg=0.1))
    assert result.reason == "on_track"


def test_adaptive_goal_suggested_calories_reflect_goal_offset():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(goal_type="cut", tdee_estimate=2500))
    assert result.suggested_daily_calories == round(2500 * 0.8)  # cut = -20%


def test_adaptive_goal_passes_through_locked_macro():
    result = evaluate_adaptive_goal(**_base_goal_kwargs(locked_macro="protein"))
    assert result.locked_macro == "protein"
    assert result.suggested_protein == 150  # preserved, same as rebalance_macros' own test
