import pytest

from services.analytics_service import calculate_bmr
from services.workout_service import (
    BASE_MET_BY_CATEGORY,
    CARDIO_DEFAULT_MET,
    CARDIO_MET_BY_ACTIVITY,
    DEFAULT_MET,
    average_daily_calories_burned,
    estimate_cardio_calories,
    DENSITY_MAX,
    DENSITY_MIN,
    estimate_session_calories,
    estimate_session_duration_hours,
    resting_kcal,
    session_energy,
    set_density_factor,
    strength_duration_hours,
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


# ---------------------------------------------------------------------------
# Phase 5.1 — set density
#
# Two kinds of case, deliberately, matching tests/test_cardio_service.py's own
# discipline: POINT CHECKS against arithmetic written out in the test so a
# reader can verify them without trusting the code, and PROPERTY checks, which
# catch a sign or ordering error that a single hand-checked value cannot.
# ---------------------------------------------------------------------------
def test_density_is_one_at_the_reference_density():
    # 22 sets x 160 s = 3520 s of "reference session"; over 3600 s elapsed that
    # is a ratio of 0.978, and sqrt(0.978) = 0.989 — within 2% of neutral, which
    # is the point: an ordinary session must barely move.
    factor = set_density_factor(22, 1.0)
    assert factor == pytest.approx((22 * 160 / 3600) ** 0.5, abs=1e-6)
    assert 0.97 < factor < 1.01


def test_density_separates_the_two_sessions_the_old_formula_could_not():
    """Bottleneck F1, stated as a test: 90 minutes with 30 hard sets and 90
    minutes with 4 sets and a lot of phone-scrolling used to price identically,
    because once ended_at is set the duration is real elapsed time and nothing
    else entered the formula."""
    dense = set_density_factor(30, 1.5)
    sparse = set_density_factor(4, 1.5)
    assert dense > sparse
    # And not marginally: the dense session must be worth clearly more.
    assert dense / sparse > 1.6


def test_density_floor_and_ceiling_are_the_asserted_values():
    # 4 sets in 90 minutes has a raw ratio of 0.119; a linear factor would price
    # that session at 12% of a normal one, i.e. as if the user had been lying
    # down. The floor is what stops that.
    assert set_density_factor(4, 1.5) == DENSITY_MIN
    assert set_density_factor(2, 3.0) == DENSITY_MIN
    # A very dense circuit gains, but only up to the ceiling — intensity is
    # already carried by the MET table and by rpe_effort_scale.
    assert set_density_factor(40, 0.5) == DENSITY_MAX
    assert DENSITY_MIN < set_density_factor(30, 1.5) < DENSITY_MAX


def test_density_rises_with_sets_and_falls_with_duration():
    for hours in (0.5, 1.0, 1.5, 2.0):
        values = [set_density_factor(n, hours) for n in (2, 6, 12, 20, 30)]
        assert values == sorted(values), (hours, values)
    for sets_n in (5, 15, 25):
        values = [set_density_factor(sets_n, h) for h in (0.5, 1.0, 1.5, 2.0)]
        assert values == sorted(values, reverse=True), (sets_n, values)


def test_density_is_neutral_with_nothing_to_measure():
    assert set_density_factor(0, 1.0) == 1.0
    assert set_density_factor(10, 0.0) == 1.0


# ---------------------------------------------------------------------------
# Phase 5.2 — gross vs net
# ---------------------------------------------------------------------------
def test_resting_kcal_is_one_days_bmr_prorated_over_the_elapsed_time():
    assert resting_kcal(1760.0, 1.0) == pytest.approx(1760 / 24)
    assert resting_kcal(1760.0, 1.5) == pytest.approx(1760 / 24 * 1.5)
    assert resting_kcal(0.0, 1.0) == 0.0
    assert resting_kcal(1760.0, 0.0) == 0.0


def test_the_weight_only_bmr_fallback_agrees_with_one_met():
    """calculate_bmr's weight-only branch is 22 kcal/kg/day and one MET is
    ~24 by definition, so workout_service's resting term and cardio_service's
    "subtract 3.5 ml/kg/min" shortcut are talking about the same thing. If these
    ever diverged badly, a session holding both would subtract two different
    amounts of "resting" from its two halves."""
    weight = 80.0
    from_bmr = resting_kcal(calculate_bmr(weight), 1.0)
    one_met_hour = 1.0 * weight  # 1 MET x kg x 1 h, the textbook definition
    assert from_bmr == pytest.approx(one_met_hour, rel=0.10)


def test_session_energy_typical_hour_matches_hand_arithmetic():
    # 22 Chest sets at RPE 7, 80 kg, one real hour.
    #   rpe scale   = 0.8 + (7 - 5) * 0.08          = 0.96
    #   effective   = 5.0 (chest) * 0.96            = 4.80 MET
    #   gross@ref   = 4.80 * 80 * 1.0               = 384.0 kcal
    #   density     = sqrt(22 * 160 / 3600)         = 0.98883
    #   gross       = 384.0 * 0.98883               = 379.7
    #   resting     = 22 * 80 / 24 * 1.0            = 73.3   (22 kcal/kg/day)
    #   net         = 379.7 - 73.3                  = 306.4
    sets = [{"category": "Chest", "rpe": 7}] * 22
    energy = session_energy(sets, 80.0, 1.0, measured_duration=True, bmr_kcal_per_day=calculate_bmr(80.0))
    assert energy.density_factor == pytest.approx(0.98883, abs=1e-4)
    assert energy.gross == pytest.approx(379.7, abs=0.1)
    assert energy.resting == pytest.approx(73.3, abs=0.1)
    assert energy.net == pytest.approx(306.4, abs=0.2)
    # The figure this app used to store, for the record — see CLAUDE.md.
    assert estimate_session_calories(sets, 80.0, 1.0) == pytest.approx(384.0, abs=0.1)


def test_session_energy_sparse_session_matches_hand_arithmetic():
    # The same lifter, 90 minutes, 4 sets.
    #   gross@ref = 4.80 * 80 * 1.5 = 576.0
    #   density   = clamp(sqrt(4 * 160 / 5400)) = clamp(0.344) = 0.55
    #   gross     = 576.0 * 0.55 = 316.8
    #   resting   = 1760 / 24 * 1.5 = 110.0
    #   net       = 206.8
    sets = [{"category": "Chest", "rpe": 7}] * 4
    energy = session_energy(sets, 80.0, 1.5, measured_duration=True, bmr_kcal_per_day=calculate_bmr(80.0))
    assert energy.gross == pytest.approx(316.8, abs=0.1)
    assert energy.net == pytest.approx(206.8, abs=0.2)


def test_net_is_always_below_gross_and_never_negative():
    for sets_n, hours in ((1, 0.05), (5, 0.5), (20, 1.0), (40, 2.5)):
        sets = [{"category": "Legs", "rpe": 8}] * sets_n
        energy = session_energy(sets, 80.0, hours, measured_duration=True, bmr_kcal_per_day=calculate_bmr(80.0))
        assert energy.net <= energy.gross
        assert energy.net >= 0.0


def test_the_density_floor_sits_above_resting_for_an_ordinary_body():
    """A property worth stating rather than discovering: the WEAKEST session
    this module can produce is the lowest base MET (4.0, arms/core) at the
    lowest RPE scale (0.6) at the density floor (0.55) — 1.32 effective METs.
    Resting for a user on the weight-only BMR is 22/24 = 0.92 METs. So a real
    logged session can never net to zero, however lazy it was, which is the
    right answer: being in a gym is not the same as being on the sofa."""
    sets = [{"category": "Arms", "rpe": 1}] * 2
    energy = session_energy(sets, 80.0, 2.0, measured_duration=True, bmr_kcal_per_day=calculate_bmr(80.0))
    assert energy.density_factor == DENSITY_MIN
    assert energy.net > 0
    assert energy.gross > energy.resting


def test_net_clamps_at_zero_rather_than_going_negative():
    """Not dead code, despite the property above. calculate_bmr's Mifflin branch
    is per-person, not per-kilogram, so a light, tall, young body genuinely can
    land above 1.32 kcal/kg/h — e.g. 45 kg at 190 cm, age 18, which Mifflin puts
    at ~34 kcal/kg/day against the fallback's 22. A user must never be shown a
    negative burn; the honest reading of that case is "this cost essentially
    nothing beyond being alive"."""
    sets = [{"category": "Arms", "rpe": 1}] * 2
    bmr = calculate_bmr(45.0, age=18, height_cm=190, sex="male")
    energy = session_energy(sets, 45.0, 2.0, measured_duration=True, bmr_kcal_per_day=bmr)
    assert energy.gross < energy.resting
    assert energy.net == 0.0


def test_an_unfinished_session_gets_no_density_adjustment():
    """Its duration was DERIVED from its own set count, so its density is a
    constant by construction (90/160 = 0.56) and applying the factor would
    silently discount every live estimate by a quarter. The resting subtraction
    still applies — that one is about elapsed time, not about density."""
    sets = [{"category": "Chest", "rpe": 7}] * 10
    hours = estimate_session_duration_hours(started_at="2026-09-28T09:00:00Z", ended_at=None, set_count=10)
    live = session_energy(sets, 80.0, hours, measured_duration=False, bmr_kcal_per_day=calculate_bmr(80.0))
    assert live.density_factor == 1.0
    assert live.gross == pytest.approx(estimate_session_calories(sets, 80.0, hours), abs=0.1)
    assert live.net < live.gross


def test_a_richer_profile_changes_the_resting_term_not_the_gross():
    sets = [{"category": "Back", "rpe": 7}] * 20
    plain = session_energy(sets, 80.0, 1.0, measured_duration=True, bmr_kcal_per_day=calculate_bmr(80.0))
    mifflin = session_energy(
        sets, 80.0, 1.0, measured_duration=True,
        bmr_kcal_per_day=calculate_bmr(80.0, age=30, height_cm=180, sex="male"),
    )
    assert plain.gross == mifflin.gross
    assert plain.resting != mifflin.resting
    # 1760 vs 1780 kcal/day — the two are close, which is the point of the
    # fallback; a user who has told the app who they are simply gets the better
    # of two similar answers.
    assert mifflin.resting == pytest.approx(1780 / 24, abs=0.1)


# ---------------------------------------------------------------------------
# Phase 5 — strength and cardio must not bill the same minutes twice
# ---------------------------------------------------------------------------
def test_cardio_minutes_come_out_of_the_strength_window():
    # An hour-long session with twenty minutes of it on a bike leaves forty
    # minutes of lifting to price, not sixty.
    assert strength_duration_hours(1.0, 20.0, measured_duration=True) == pytest.approx(40 / 60)
    assert strength_duration_hours(1.0, 0.0, measured_duration=True) == 1.0


def test_cardio_minutes_are_ignored_for_an_unfinished_session():
    """Its duration came from the set count, not from a clock, so there is no
    elapsed window for the cardio to sit inside."""
    assert strength_duration_hours(0.25, 20.0, measured_duration=False) == 0.25


def test_cardio_longer_than_the_session_clamps_rather_than_going_negative():
    # Logging a 30-minute ride against a session that has only been open for
    # ten minutes is legitimate — people log after the fact.
    assert strength_duration_hours(10 / 60, 30.0, measured_duration=True) == 0.0
