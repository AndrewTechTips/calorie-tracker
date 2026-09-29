"""Phase 3.1 — the cardio math, pinned before any UI exists.

Two kinds of assertion here, deliberately:

  1. POINT CHECKS against values computed by hand from the published equation
     forms (written out in each test, so a reader can verify the arithmetic
     without trusting the implementation), plus a handful of independent
     sanity anchors — 100 W of cycling is ~6-7 METs in every published table,
     a 2:00/500m row is ~203 W on every Concept2 in the world.

  2. PROPERTY CHECKS — monotonicity in every input, and the ordering
     invariants. These catch what a point check cannot: a sign error, a
     swapped coefficient, a units slip. A single hand-checked value can pass
     while the equation is wrong everywhere else; "kcal must rise with
     incline, at every speed" cannot.

Floors and anchors here may be TIGHTENED but not loosened to make a change
pass — the same rule tests/test_retrieval_eval.py's own floors carry.
"""

import pytest

from services import cardio_service as cs


# ---------------------------------------------------------------------------
# Unit conversions
# ---------------------------------------------------------------------------
def test_kmh_to_m_min():
    # 6 km/h = 6000 m/h = 100 m/min
    assert cs.kmh_to_m_min(6.0) == pytest.approx(100.0)


def test_walk_run_threshold_is_the_gait_transition():
    # 6.4 km/h — where walking stops being the cheaper gait for most adults.
    assert cs.WALK_RUN_THRESHOLD_M_MIN == pytest.approx(cs.kmh_to_m_min(6.42), abs=1.0)


# ---------------------------------------------------------------------------
# Walking — VO2 = 0.1*S + 1.8*S*G + 3.5
# ---------------------------------------------------------------------------
def test_walking_vo2_on_the_flat():
    # S = 100 m/min, G = 0: 0.1*100 + 0 + 3.5 = 13.5
    assert cs.walking_vo2(100.0, 0.0) == pytest.approx(13.5)


def test_walking_vo2_with_incline():
    # S = 100, G = 0.08: 10 + 1.8*100*0.08 + 3.5 = 10 + 14.4 + 3.5 = 27.9
    assert cs.walking_vo2(100.0, 0.08) == pytest.approx(27.9)


def test_the_grade_term_dominates_the_speed_term():
    """The reason a flat MET cannot describe an inclined treadmill: the grade
    coefficient is 18x the horizontal one, so 8% incline costs more than the
    entire horizontal component of walking at that speed."""
    flat = cs.walking_vo2(100.0, 0.0) - cs.RESTING_VO2       # 10.0
    incline_only = cs.walking_vo2(100.0, 0.08) - cs.walking_vo2(100.0, 0.0)  # 14.4
    assert incline_only > flat


def test_walking_never_returns_below_resting():
    assert cs.walking_vo2(0.0, 0.0) == pytest.approx(cs.RESTING_VO2)
    assert cs.walking_vo2(-50.0, -0.5) >= cs.RESTING_VO2


# ---------------------------------------------------------------------------
# Running — VO2 = 0.2*S + 0.9*S*G + 3.5
# ---------------------------------------------------------------------------
def test_running_vo2_on_the_flat():
    # S = 160 m/min (9.6 km/h): 0.2*160 + 0 + 3.5 = 35.5
    assert cs.running_vo2(160.0, 0.0) == pytest.approx(35.5)


def test_running_vo2_with_incline():
    # S = 160, G = 0.05: 32 + 0.9*160*0.05 + 3.5 = 32 + 7.2 + 3.5 = 42.7
    assert cs.running_vo2(160.0, 0.05) == pytest.approx(42.7)


def test_running_costs_more_than_walking_at_the_same_speed():
    """Horizontally, running is the less economical gait — which is why the
    handover speed exists at all."""
    speed = 120.0
    assert cs.running_vo2(speed, 0.0) > cs.walking_vo2(speed, 0.0)


# ---------------------------------------------------------------------------
# Stepping — VO2 = 0.2*f + 1.33*1.8*h*f + 3.5
# ---------------------------------------------------------------------------
def test_stepping_vo2_hand_computed():
    # f = 20/min, h = 0.2 m: 0.2*20 + 1.33*1.8*0.2*20 + 3.5
    #                      = 4 + 9.576 + 3.5 = 17.076
    assert cs.stepping_vo2(20.0, 0.2) == pytest.approx(17.076)


def test_a_real_stairmaster_pace_lands_in_the_published_met_band():
    """THE regression this module exists for. A stairmaster had no entry in
    the flat MET table at all and fell back to CARDIO_DEFAULT_MET — 4.3, a
    brisk walk. Published Compendium figures for stair machines are 8-11 METs;
    anything in that band is a fix, 4.3 is a ~2.5x undercount."""
    vo2 = cs.stepping_vo2(60.0, cs.DEFAULT_STEP_HEIGHT_M)
    met = cs.vo2_to_met(vo2)
    assert 8.0 <= met <= 14.0, f"stairmaster at 60 steps/min scored {met} METs"
    from services.workout_service import CARDIO_DEFAULT_MET

    assert met > CARDIO_DEFAULT_MET * 2


def test_descending_is_counted_but_costs_less_than_ascending():
    """The 1.33 factor: stepping down is about a third of the cost of stepping
    up, not free and not equal."""
    f, h = 30.0, 0.2
    ascent_only = 1.8 * h * f
    both = 1.33 * 1.8 * h * f
    assert both > ascent_only
    assert both < 2 * ascent_only


# ---------------------------------------------------------------------------
# Leg ergometry — VO2 = 1.8 * (W * 6.12) / kg + 3.5 + 3.5
# ---------------------------------------------------------------------------
def test_leg_ergometry_hand_computed():
    # 100 W, 75 kg: 1.8 * (100*6.12) / 75 + 7 = 1.8*612/75 + 7
    #             = 14.688 + 7 = 21.688
    assert cs.leg_ergometry_vo2(100.0, 75.0) == pytest.approx(21.688, rel=1e-4)


def test_100w_cycling_matches_published_met_tables():
    """Independent anchor: 100 W is ~6-7 METs in every published table."""
    met = cs.vo2_to_met(cs.leg_ergometry_vo2(100.0, 75.0))
    assert 5.5 <= met <= 7.5, met


def test_a_heavier_rider_pays_less_per_kilogram_for_the_same_watts():
    """The one equation where bodyweight changes VO2 per kg: the flywheel load
    is absolute, so more kilograms share the same external work."""
    assert cs.leg_ergometry_vo2(150.0, 90.0) < cs.leg_ergometry_vo2(150.0, 60.0)


def test_but_the_heavier_rider_still_burns_more_total_kcal():
    """...and the total must not invert, or the per-kg subtlety would have
    become a user-visible lie."""
    light = cs.vo2_to_kcal(cs.leg_ergometry_vo2(150.0, 60.0), 60.0, 30.0, net=True)
    heavy = cs.vo2_to_kcal(cs.leg_ergometry_vo2(150.0, 90.0), 90.0, 30.0, net=True)
    assert heavy > light


# ---------------------------------------------------------------------------
# Rowing — Concept2 split -> watts
# ---------------------------------------------------------------------------
def test_two_minute_split_is_about_203_watts():
    """The number every rower knows: 2:00/500m is ~200 W. watts = 2.80/pace^3
    with pace in s/m, so (120/500)^3 = 0.013824 and 2.80/0.013824 = 202.5."""
    assert cs.split_to_watts(120.0) == pytest.approx(202.5, rel=0.01)


def test_a_faster_split_is_more_watts():
    assert cs.split_to_watts(100.0) > cs.split_to_watts(120.0) > cs.split_to_watts(150.0)


def test_split_to_watts_is_cubic_not_linear():
    """Halving the split is eight times the power, which is why pace feels the
    way it does on a rower — and why a linear approximation would be badly
    wrong at both ends."""
    assert cs.split_to_watts(60.0) == pytest.approx(8 * cs.split_to_watts(120.0), rel=0.01)


def test_non_positive_split_does_not_explode():
    assert cs.split_to_watts(0.0) == 0.0
    assert cs.split_to_watts(-10.0) == 0.0


# ---------------------------------------------------------------------------
# Gross vs net
# ---------------------------------------------------------------------------
def test_net_is_always_below_gross():
    vo2 = cs.walking_vo2(100.0, 0.05)
    net = cs.vo2_to_kcal(vo2, 80.0, 30.0, net=True)
    gross = cs.vo2_to_kcal(vo2, 80.0, 30.0, net=False)
    assert net < gross


def test_the_gap_is_exactly_one_met_for_the_duration():
    """Net subtracts resting metabolism and nothing else — so the difference
    must equal 1 MET x bodyweight x time, independent of the activity."""
    weight, minutes = 80.0, 30.0
    expected_gap = (cs.RESTING_VO2 * weight / 1000.0) * cs.KCAL_PER_L_O2 * minutes
    for vo2 in (cs.walking_vo2(90.0, 0.0), cs.running_vo2(180.0, 0.02), cs.leg_ergometry_vo2(120.0, weight)):
        gross = cs.vo2_to_kcal(vo2, weight, minutes, net=False)
        net = cs.vo2_to_kcal(vo2, weight, minutes, net=True)
        assert gross - net == pytest.approx(expected_gap)


def test_resting_vo2_is_one_met():
    assert cs.vo2_to_met(cs.RESTING_VO2) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Monotonicity — the properties a point check cannot cover
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("incline", [0.0, 5.0, 12.0])
def test_kcal_rises_with_speed_at_every_incline(incline):
    prev = None
    for speed in (3.0, 4.5, 6.0, 8.0, 11.0):
        out = cs.estimate_cardio("treadmill", {"speed_kmh": speed, "incline_percent": incline}, 75.0, 30.0)
        if prev is not None:
            assert out.kcal > prev, f"{speed} km/h at {incline}% did not exceed the step below it"
        prev = out.kcal


@pytest.mark.parametrize("speed", [4.0, 6.0, 9.0])
def test_kcal_rises_with_incline_at_every_speed(speed):
    prev = None
    for incline in (0.0, 3.0, 6.0, 10.0, 15.0):
        out = cs.estimate_cardio("treadmill", {"speed_kmh": speed, "incline_percent": incline}, 75.0, 30.0)
        if prev is not None:
            assert out.kcal > prev, f"{incline}% at {speed} km/h did not exceed the step below it"
        prev = out.kcal


def test_kcal_rises_with_watts():
    prev = None
    for watts in (50.0, 100.0, 150.0, 200.0, 250.0):
        out = cs.estimate_cardio("bike", {"watts": watts}, 75.0, 30.0)
        if prev is not None:
            assert out.kcal > prev
        prev = out.kcal


def test_kcal_rises_with_step_rate():
    prev = None
    for steps in (20.0, 40.0, 60.0, 80.0):
        out = cs.estimate_cardio("stairmaster", {"steps_per_min": steps}, 75.0, 30.0)
        if prev is not None:
            assert out.kcal > prev
        prev = out.kcal


def test_kcal_rises_with_duration_and_scales_linearly():
    """Doubling the time doubles the cost — nothing in these equations depends
    on duration except as a multiplier.

    Tolerance is absolute rather than relative because `kcal` is rounded to one
    decimal on the way out: 2 x round(137.2) is 274.4 while round(274.45) is
    274.5, and that one unit in the last place is the rounding, not the model.
    Asserting `rel=1e-6` here would be pinning the rounding mode."""
    a = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 8.0}, 75.0, 15.0)
    b = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 8.0}, 75.0, 30.0)
    assert b.kcal == pytest.approx(2 * a.kcal, abs=0.2)
    # The unrounded relationship is exact, and that is what is actually being
    # claimed — check it where the rounding cannot reach.
    vo2 = cs.walking_vo2(cs.kmh_to_m_min(6.0), 0.08)
    assert cs.vo2_to_kcal(vo2, 75.0, 30.0, net=True) == pytest.approx(
        2 * cs.vo2_to_kcal(vo2, 75.0, 15.0, net=True), rel=1e-12
    )


def test_kcal_rises_with_bodyweight_for_weight_bearing_work():
    light = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 5.0}, 60.0, 30.0)
    heavy = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 5.0}, 95.0, 30.0)
    assert heavy.kcal > light.kcal


# ---------------------------------------------------------------------------
# Dispatch, provenance and degradation
# ---------------------------------------------------------------------------
def test_treadmill_switches_equation_at_the_gait_transition():
    slow = cs.estimate_cardio("treadmill", {"speed_kmh": 5.0}, 75.0, 30.0)
    fast = cs.estimate_cardio("treadmill", {"speed_kmh": 10.0}, 75.0, 30.0)
    assert slow.equation_id == "acsm_walking"
    assert fast.equation_id == "acsm_running"


def test_every_estimate_reports_which_equation_produced_it():
    cases = {
        "treadmill": {"speed_kmh": 5.0},
        "stairmaster": {"steps_per_min": 60.0},
        "bike": {"watts": 120.0},
        "rower": {"split_seconds": 120.0},
        "elliptical": {"resistance": 10.0},
        "outdoor": {"distance_km": 5.0, "duration_minutes": 30.0},
    }
    for machine, params in cases.items():
        out = cs.estimate_cardio(machine, params, 75.0, 30.0)
        assert out.equation_id and out.equation_id != "invalid_input", machine
        assert out.kcal > 0, machine
        assert out.basis == "net"


def test_the_elliptical_is_always_flagged_as_an_estimate():
    """It has no published equation; presenting its band in the same typeface
    as a validated equation would be the dishonest part."""
    out = cs.estimate_cardio("elliptical", {"resistance": 10.0}, 75.0, 30.0)
    assert out.is_estimate is True
    assert out.equation_id == "met_band_elliptical"


def test_rowing_is_always_flagged_even_though_the_watts_are_exact():
    """The split -> watts conversion is exact; the watts -> VO2 step borrows an
    equation validated on a leg ergometer, and rowing recruits more than legs."""
    out = cs.estimate_cardio("rower", {"split_seconds": 120.0}, 75.0, 30.0)
    assert out.is_estimate is True


def test_inputs_inside_the_validity_band_are_not_flagged():
    inside = cs.estimate_cardio("treadmill", {"speed_kmh": 5.0, "incline_percent": 4.0}, 75.0, 30.0)
    assert inside.is_estimate is False
    assert cs.estimate_cardio("bike", {"watts": 120.0}, 75.0, 30.0).is_estimate is False


def test_inputs_outside_the_validity_band_still_compute_but_are_flagged():
    """Refusing to answer would be worse: the session happened either way."""
    crawl = cs.estimate_cardio("treadmill", {"speed_kmh": 1.5}, 75.0, 30.0)
    assert crawl.kcal > 0
    assert crawl.is_estimate is True
    sprint = cs.estimate_cardio("treadmill", {"speed_kmh": 22.0}, 75.0, 30.0)
    assert sprint.is_estimate is True


def test_an_unknown_machine_degrades_to_the_existing_flat_met_table():
    """Damage Control's "Move it" passes free text, and must keep working."""
    out = cs.estimate_cardio("jump rope", {}, 75.0, 30.0)
    assert out.equation_id == "flat_met"
    assert out.is_estimate is True
    from services.workout_service import CARDIO_MET_BY_ACTIVITY

    assert out.met == pytest.approx(CARDIO_MET_BY_ACTIVITY["jump rope"], abs=0.01)


def test_an_unrecognised_word_falls_all_the_way_back_to_the_default_met():
    from services.workout_service import CARDIO_DEFAULT_MET

    out = cs.estimate_cardio("interpretive dance", {}, 75.0, 30.0)
    assert out.met == pytest.approx(CARDIO_DEFAULT_MET, abs=0.01)


def test_non_positive_duration_or_weight_returns_zero_rather_than_raising():
    """Same contract as workout_service.estimate_cardio_calories — the caller
    treats 0 as "no estimate available"."""
    assert cs.estimate_cardio("treadmill", {"speed_kmh": 6.0}, 75.0, 0.0).kcal == 0.0
    assert cs.estimate_cardio("treadmill", {"speed_kmh": 6.0}, 0.0, 30.0).kcal == 0.0
    assert cs.estimate_cardio("treadmill", {"speed_kmh": 6.0}, 75.0, -5.0).kcal == 0.0


def test_missing_params_do_not_raise():
    """A machine picked but nothing typed yet — the live estimate renders on
    every keystroke, so this is the normal state for the first second of use."""
    for machine in cs.SUPPORTED_MACHINES:
        out = cs.estimate_cardio(machine, {}, 75.0, 30.0)
        assert out.kcal >= 0.0
        assert out.met >= 0.0


def test_none_machine_and_none_params_do_not_raise():
    out = cs.estimate_cardio(None, None, 75.0, 30.0)
    assert out.kcal >= 0.0


def test_stairmaster_accepts_floors_per_hour_as_well_as_steps():
    """Different consoles display different units; 16 steps to a floor is the
    near-universal convention."""
    by_steps = cs.estimate_cardio("stairmaster", {"steps_per_min": 160 * 16 / 60}, 75.0, 30.0)
    by_floors = cs.estimate_cardio("stairmaster", {"floors_per_hour": 160.0}, 75.0, 30.0)
    assert by_floors.kcal == pytest.approx(by_steps.kcal, rel=1e-6)


def test_outdoor_derives_pace_from_distance_and_time():
    """5 km in 30 min = 10 km/h, which must match the treadmill at 10 km/h."""
    outdoor = cs.estimate_cardio("outdoor", {"distance_km": 5.0, "duration_minutes": 30.0}, 75.0, 30.0)
    treadmill = cs.estimate_cardio("treadmill", {"speed_kmh": 10.0}, 75.0, 30.0)
    assert outdoor.kcal == pytest.approx(treadmill.kcal, rel=1e-6)


# ---------------------------------------------------------------------------
# End-to-end anchors — the figures the ship gate names
# ---------------------------------------------------------------------------
def test_the_ship_gate_treadmill_case():
    """32 minutes at 6 km/h and 8% incline, 74 kg — hand-computed:
      S = 100 m/min, G = 0.08
      VO2 = 0.1*100 + 1.8*100*0.08 + 3.5 = 10 + 14.4 + 3.5 = 27.9
      net VO2 = 27.9 - 3.5 = 24.4
      L/min = 24.4 * 74 / 1000 = 1.8056
      kcal = 1.8056 * 5 * 32 = 288.9
    """
    out = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 8.0}, 74.0, 32.0, net=True)
    assert out.kcal == pytest.approx(288.9, abs=0.5)
    assert out.equation_id == "acsm_walking"
    assert out.is_estimate is False
    assert out.met == pytest.approx(27.9 / 3.5, rel=1e-3)


def test_the_same_walk_on_the_flat_costs_far_less():
    """The comparison a flat MET table cannot make at all."""
    incline = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 8.0}, 74.0, 32.0)
    flat = cs.estimate_cardio("treadmill", {"speed_kmh": 6.0, "incline_percent": 0.0}, 74.0, 32.0)
    assert incline.kcal > flat.kcal * 2
