import pytest

from services.workout_service import (
    BASE_MET_BY_CATEGORY,
    CARDIO_DEFAULT_MET,
    CARDIO_MET_BY_ACTIVITY,
    DEFAULT_MET,
    average_daily_calories_burned,
    estimate_cardio_calories,
    estimate_session_calories,
    estimate_session_duration_hours,
    rpe_effort_scale,
)


# ---------------------------------------------------------------------------
# rpe_effort_scale
# ---------------------------------------------------------------------------
def test_rpe_effort_scale_none_is_neutral():
    assert rpe_effort_scale(None) == 1.0


def test_rpe_effort_scale_anchors():
    assert rpe_effort_scale(5) == pytest.approx(0.8)
    assert rpe_effort_scale(10) == pytest.approx(1.2)


def test_rpe_effort_scale_below_neutral_scales_down():
    assert rpe_effort_scale(1) < rpe_effort_scale(5)


def test_rpe_effort_scale_clamped_at_extremes():
    # RPE is schema-constrained to 1-10, but the function itself still
    # clamps out-of-range input rather than returning an implausible
    # multiplier.
    assert rpe_effort_scale(1) >= 0.6
    assert rpe_effort_scale(20) <= 1.3


# ---------------------------------------------------------------------------
# estimate_session_duration_hours
# ---------------------------------------------------------------------------
def test_duration_uses_real_elapsed_time_once_finished():
    hours = estimate_session_duration_hours(
        started_at="2026-08-14T08:00:00Z", ended_at="2026-08-14T09:00:00Z", set_count=10
    )
    assert hours == pytest.approx(1.0)


def test_duration_estimates_from_set_count_while_in_progress():
    hours = estimate_session_duration_hours(started_at="2026-08-14T08:00:00Z", ended_at=None, set_count=20)
    assert hours == pytest.approx(20 * 90 / 3600)


def test_duration_floors_at_one_set_for_a_brand_new_session():
    hours = estimate_session_duration_hours(started_at="2026-08-14T08:00:00Z", ended_at=None, set_count=0)
    assert hours == pytest.approx(90 / 3600)


# ---------------------------------------------------------------------------
# estimate_session_calories
# ---------------------------------------------------------------------------
def test_estimate_session_calories_matches_manual_met_math():
    sets = [{"category": "Chest", "rpe": 5}, {"category": "Chest", "rpe": 5}]
    calories = estimate_session_calories(sets, weight_kg=80, duration_hours=1)
    expected_met = BASE_MET_BY_CATEGORY["chest"] * 0.8
    assert calories == pytest.approx(expected_met * 80 * 1, abs=0.05)


def test_estimate_session_calories_unknown_category_falls_back_to_default_met():
    sets = [{"category": "Not A Real Category", "rpe": None}]
    calories = estimate_session_calories(sets, weight_kg=80, duration_hours=1)
    assert calories == pytest.approx(DEFAULT_MET * 80 * 1, abs=0.05)


def test_estimate_session_calories_missing_category_falls_back_to_default_met():
    sets = [{"category": None, "rpe": None}]
    calories = estimate_session_calories(sets, weight_kg=80, duration_hours=1)
    assert calories == pytest.approx(DEFAULT_MET * 80 * 1, abs=0.05)


def test_estimate_session_calories_higher_rpe_burns_more():
    low = estimate_session_calories([{"category": "Legs", "rpe": 5}], weight_kg=80, duration_hours=1)
    high = estimate_session_calories([{"category": "Legs", "rpe": 10}], weight_kg=80, duration_hours=1)
    assert high > low


def test_estimate_session_calories_empty_sets_is_zero():
    assert estimate_session_calories([], weight_kg=80, duration_hours=1) == 0.0


def test_estimate_session_calories_zero_duration_is_zero():
    assert estimate_session_calories([{"category": "Legs", "rpe": 7}], weight_kg=80, duration_hours=0) == 0.0


# ---------------------------------------------------------------------------
# average_daily_calories_burned
# ---------------------------------------------------------------------------
def test_average_daily_calories_burned_divides_by_full_window_not_session_count():
    # Only 2 of 7 days had a session — a rest day should pull the average
    # down, not be excluded from the denominator.
    sessions = [{"calories_burned": 350}, {"calories_burned": 210}]
    assert average_daily_calories_burned(sessions, window_days=7) == pytest.approx((350 + 210) / 7, abs=0.05)


def test_average_daily_calories_burned_no_sessions_is_zero():
    assert average_daily_calories_burned([], window_days=7) == 0.0


def test_average_daily_calories_burned_tolerates_null_calories_burned():
    # A session whose calories_burned hasn't been computed yet (shouldn't
    # happen post-migration, but defensive) shouldn't blow up the sum.
    sessions = [{"calories_burned": None}, {"calories_burned": 300}]
    assert average_daily_calories_burned(sessions, window_days=7) == pytest.approx(300 / 7, abs=0.05)


# ---------------------------------------------------------------------------
# estimate_cardio_calories — duration-based activity (Damage Control "Move it")
# ---------------------------------------------------------------------------
def test_estimate_cardio_calories_brisk_walk_matches_met_formula():
    # MET 4.3 x 70 kg x 0.5 h = 150.5
    assert estimate_cardio_calories("Brisk walk", 30, 70) == pytest.approx(150.5, abs=0.05)


def test_estimate_cardio_calories_is_case_insensitive_on_activity():
    assert estimate_cardio_calories("BRISK WALK", 30, 70) == estimate_cardio_calories("brisk walk", 30, 70)


def test_estimate_cardio_calories_unknown_activity_uses_brisk_walk_default_met():
    assert estimate_cardio_calories("moonwalk", 30, 70) == pytest.approx(CARDIO_DEFAULT_MET * 70 * 0.5, abs=0.05)


def test_estimate_cardio_calories_running_burns_more_than_walking():
    assert estimate_cardio_calories("run", 30, 70) > estimate_cardio_calories("walk", 30, 70)


def test_estimate_cardio_calories_zero_or_negative_inputs_return_zero():
    assert estimate_cardio_calories("run", 0, 70) == 0.0
    assert estimate_cardio_calories("run", 30, 0) == 0.0
    assert estimate_cardio_calories("run", -10, 70) == 0.0


def test_cardio_met_table_keys_are_all_lowercase():
    assert all(k == k.lower() for k in CARDIO_MET_BY_ACTIVITY)
