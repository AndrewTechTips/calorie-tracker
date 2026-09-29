"""Cardio energy expenditure from the numbers a machine actually displays.

Pure, deterministic math only — no Supabase, no HTTP — mirroring
services/workout_service.py's own shape, which is why both are fully
unit-testable (backend/tests/test_cardio_service.py). routers/workouts.py does
the reads and writes and calls in here for the figure.

WHY THIS EXISTS SEPARATELY FROM workout_service.CARDIO_MET_BY_ACTIVITY
----------------------------------------------------------------------
A flat MET table is the right tool for UNQUANTIFIED activity: "I went for a
walk" carries no more information than its name, and a single representative
number is an honest summary of it. That table stays, and the "Move it" action
in Damage Control still uses it.

It is the wrong tool for a MACHINE, because a machine displays its own
settings. Someone on a treadmill can read off speed and incline; someone on a
bike or a rower can read off watts. Those are the variables that determine the
answer, and a lookup keyed only on the word "run" throws all of them away:

  * `run: 9.8` is one number for 6 km/h at 12% incline and for 12 km/h on the
    flat. In the walking equation below, the GRADE term carries an 18x larger
    coefficient than the speed term, so on an inclined treadmill a flat MET is
    not merely imprecise — it is answering a different question.
  * A stairmaster has no entry at all and falls to CARDIO_DEFAULT_MET (4.3, a
    brisk walk) against a real 8-12 METs: roughly a 2.5x undercount.
  * `bike: 7.5` scores 50 W and 200 W identically.

The standard, published way to use those readings is the ACSM metabolic
equations, which is what this module implements.

WHAT THE NUMBERS MEAN, AND THEIR LIMITS
---------------------------------------
Every equation yields VO2 in mL O2 per kg of bodyweight per minute. Two steps
then convert that to kilocalories, and the distinction between them is
user-visible:

    kcal/min (gross) = (VO2 * kg / 1000) * KCAL_PER_L_O2
    kcal/min (net)   = ((VO2 - RESTING_VO2) * kg / 1000) * KCAL_PER_L_O2

GROSS includes the resting metabolism that would have happened on the sofa.
NET is what the activity actually cost on top of living. Most apps quietly
report gross because it is the bigger number; this module returns whichever is
asked for and reports which one it gave, so the UI can say so.

These equations are validated for STEADY-STATE SUBMAXIMAL work. They
over-report at maximal intensity and model no EPOC (the elevated burn after
stopping). They are also each validated over a stated range of inputs; outside
it they still compute, but the result is an extrapolation and comes back with
`is_estimate=True` rather than being silently presented as equally sound.
Nothing here is a clinical measurement, and the UI must not imply that it is.
"""

from dataclasses import dataclass
from typing import Optional

# --- shared physiological constants ---------------------------------------
# The energy yield of one litre of oxygen. Varies slightly with the fuel mix
# being burned (~4.7 kcal/L for pure fat, ~5.05 for pure carbohydrate); 5.0 is
# the standard figure used with these equations for mixed-substrate exercise.
KCAL_PER_L_O2 = 5.0

# One MET. Resting oxygen uptake, by definition, and the term subtracted to
# turn a gross figure into a net one.
RESTING_VO2 = 3.5

# Watts to kg*m/min, the unit ACSM's ergometry equation takes its work rate in.
WATT_TO_KGM_PER_MIN = 6.12

# Where the walking equation hands over to the running one. ACSM validates
# walking over 50-100 m/min and running above 134 m/min, leaving a gap; 107
# m/min (6.4 km/h) is the speed at which walking stops being more economical
# than jogging for most adults, so it is where a treadmill user actually
# changes gait. Inputs inside the gap are flagged as extrapolations.
WALK_RUN_THRESHOLD_M_MIN = 107.0

# Published validity bands, used only to decide `is_estimate`. Computing
# outside them is still better than refusing to answer — it is being quiet
# about it that would be wrong.
_WALK_VALID_M_MIN = (50.0, 100.0)
_RUN_VALID_M_MIN = (134.0, 300.0)
_STEP_VALID_PER_MIN = (12.0, 30.0)
_ERGOMETRY_VALID_WATTS = (50.0, 200.0)

# A stepmill/StairMaster step. 8 inches is the near-universal commercial
# tread rise; a bench-stepping class would pass its own height instead.
DEFAULT_STEP_HEIGHT_M = 0.2032

# The elliptical has no published metabolic equation — its stride length,
# resistance scale and arm involvement are all manufacturer-specific and none
# of them are standardised. A MET band keyed on the machine's own resistance
# setting is the honest ceiling of what can be said, and every answer from it
# is flagged as an estimate.
_ELLIPTICAL_MET_MIN = 4.5
_ELLIPTICAL_MET_MAX = 9.5
_ELLIPTICAL_MAX_RESISTANCE = 20.0


@dataclass(frozen=True)
class CardioEstimate:
    """The figure plus its provenance. `equation_id` and `is_estimate` exist so
    the UI can show WHICH method produced a number rather than presenting a
    hand-waved band and a physiological equation in identical type."""

    kcal: float
    met: float
    vo2_ml_kg_min: float
    equation_id: str
    is_estimate: bool
    basis: str  # "net" | "gross"


def _clamp_non_negative(value: float) -> float:
    """VO2 below rest is not physically meaningful. It can only arise from an
    input below the equation's own floor (a treadmill at 0.5 km/h), and the
    honest answer there is resting metabolism, not a negative burn."""
    return max(value, RESTING_VO2)


def _outside(value: float, band: tuple[float, float]) -> bool:
    return value < band[0] or value > band[1]


def vo2_to_kcal(vo2_ml_kg_min: float, weight_kg: float, duration_minutes: float, *, net: bool) -> float:
    """The one place VO2 becomes kilocalories, so gross and net cannot drift
    apart. Net subtracts one MET for the whole duration — the resting cost the
    user would have paid anyway."""
    effective = vo2_ml_kg_min - RESTING_VO2 if net else vo2_ml_kg_min
    effective = max(effective, 0.0)
    litres_per_min = effective * weight_kg / 1000.0
    return litres_per_min * KCAL_PER_L_O2 * duration_minutes


def vo2_to_met(vo2_ml_kg_min: float) -> float:
    return vo2_ml_kg_min / RESTING_VO2


# ---------------------------------------------------------------------------
# The equations
# ---------------------------------------------------------------------------
def walking_vo2(speed_m_min: float, grade_fraction: float) -> float:
    """ACSM walking: VO2 = 0.1*S + 1.8*S*G + 3.5

    The grade term's coefficient is EIGHTEEN TIMES the horizontal one, which is
    the whole reason a flat MET cannot describe an inclined treadmill: at 5
    km/h, going from 0% to 10% incline roughly doubles the cost."""
    return _clamp_non_negative(0.1 * speed_m_min + 1.8 * speed_m_min * grade_fraction + RESTING_VO2)


def running_vo2(speed_m_min: float, grade_fraction: float) -> float:
    """ACSM running: VO2 = 0.2*S + 0.9*S*G + 3.5

    Both coefficients differ from walking: running is less economical
    horizontally (0.2 vs 0.1) and, counter-intuitively, cheaper per unit of
    grade (0.9 vs 1.8), because the published grade term already accounts for
    the runner's shorter ground contact on an incline."""
    return _clamp_non_negative(0.2 * speed_m_min + 0.9 * speed_m_min * grade_fraction + RESTING_VO2)


def stepping_vo2(steps_per_min: float, step_height_m: float) -> float:
    """ACSM stepping: VO2 = 0.2*f + 1.33 * 1.8 * h * f + 3.5

    The 1.33 is the cost of stepping DOWN expressed as a fraction of stepping
    up — descending is not free, it is about a third of the ascent.

    Validated for bench stepping at 12-30 steps/min. A stairmaster runs at
    50-100, so a real session is an extrapolation and is flagged; the resulting
    8-13 METs nonetheless agrees with the published Compendium figures for
    stair machines far better than the 4.3 a missing table entry gave it."""
    return _clamp_non_negative(0.2 * steps_per_min + 1.33 * 1.8 * step_height_m * steps_per_min + RESTING_VO2)


def leg_ergometry_vo2(watts: float, weight_kg: float) -> float:
    """ACSM leg ergometry: VO2 = 1.8 * work_rate / kg + 3.5 + 3.5

    Work rate in kg*m/min. The two 3.5s are not a typo: one is resting
    metabolism, the other the cost of moving the legs with no resistance.

    Note this is the one equation where BODYWEIGHT changes the VO2 per kg — the
    flywheel's resistance is an absolute load, so a heavier rider spreads the
    same external work over more kilograms and pays less per kilogram for it
    (though more in total kilocalories)."""
    work_rate_kgm_min = watts * WATT_TO_KGM_PER_MIN
    return _clamp_non_negative(1.8 * work_rate_kgm_min / weight_kg + RESTING_VO2 + RESTING_VO2)


def split_to_watts(split_seconds_per_500m: float) -> float:
    """Concept2's published relation: watts = 2.80 / pace^3, pace in seconds per
    metre. A 2:00/500m split is ~203 W, which is the figure every rower knows.

    Included because a rower's display shows a split far more often than it
    shows watts, and asking a user to convert in their head is how an input
    gets skipped."""
    if split_seconds_per_500m <= 0:
        return 0.0
    pace_s_per_m = split_seconds_per_500m / 500.0
    return 2.80 / (pace_s_per_m**3)


def elliptical_vo2(resistance: Optional[float]) -> float:
    """No published equation exists (see _ELLIPTICAL_MET_MIN's comment), so this
    is an interpolation across a MET band keyed on the machine's own resistance
    setting, normalised to a nominal 1-20 scale. Always an estimate, and says
    so — the alternative is presenting a guess in the same typeface as a
    validated equation."""
    if resistance is None:
        met = (_ELLIPTICAL_MET_MIN + _ELLIPTICAL_MET_MAX) / 2
    else:
        fraction = min(max(resistance, 0.0), _ELLIPTICAL_MAX_RESISTANCE) / _ELLIPTICAL_MAX_RESISTANCE
        met = _ELLIPTICAL_MET_MIN + fraction * (_ELLIPTICAL_MET_MAX - _ELLIPTICAL_MET_MIN)
    return met * RESTING_VO2


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
def kmh_to_m_min(kmh: float) -> float:
    return kmh * 1000.0 / 60.0


def _treadmill(params: dict, weight_kg: float) -> tuple[float, str, bool]:
    speed_m_min = kmh_to_m_min(float(params.get("speed_kmh") or 0.0))
    # Incline is entered as a PERCENT because that is what the console shows;
    # every equation here wants a fraction.
    grade = float(params.get("incline_percent") or 0.0) / 100.0
    if speed_m_min >= WALK_RUN_THRESHOLD_M_MIN:
        return running_vo2(speed_m_min, grade), "acsm_running", _outside(speed_m_min, _RUN_VALID_M_MIN)
    return walking_vo2(speed_m_min, grade), "acsm_walking", _outside(speed_m_min, _WALK_VALID_M_MIN)


def _stairmaster(params: dict, weight_kg: float) -> tuple[float, str, bool]:
    steps = params.get("steps_per_min")
    if steps is None and params.get("floors_per_hour") is not None:
        # Machines that report floors: the near-universal convention is 16
        # steps to a floor.
        steps = float(params["floors_per_hour"]) * 16.0 / 60.0
    steps = float(steps or 0.0)
    height = float(params.get("step_height_m") or DEFAULT_STEP_HEIGHT_M)
    return stepping_vo2(steps, height), "acsm_stepping", _outside(steps, _STEP_VALID_PER_MIN)


def _bike(params: dict, weight_kg: float) -> tuple[float, str, bool]:
    watts = params.get("watts")
    if watts is None and params.get("resistance") is not None and params.get("rpm") is not None:
        # A crude but standard stand-in for machines that show only a
        # resistance level and a cadence. Explicitly an estimate: the mapping
        # from "level 8" to watts is manufacturer-specific and unstandardised.
        watts = float(params["resistance"]) * float(params["rpm"]) * 0.13
        vo2 = leg_ergometry_vo2(float(watts), weight_kg)
        return vo2, "acsm_leg_ergometry_from_resistance", True
    watts = float(watts or 0.0)
    return leg_ergometry_vo2(watts, weight_kg), "acsm_leg_ergometry", _outside(watts, _ERGOMETRY_VALID_WATTS)


def _rower(params: dict, weight_kg: float) -> tuple[float, str, bool]:
    watts = params.get("watts")
    equation = "acsm_leg_ergometry_adapted"
    if watts is None and params.get("split_seconds") is not None:
        watts = split_to_watts(float(params["split_seconds"]))
        equation = "concept2_split_to_watts"
    watts = float(watts or 0.0)
    # Rowing has no ACSM equation of its own. The ergometry form is used
    # because the relationship between external power and oxygen cost is the
    # physiologically stable part; what it under-counts is the extra muscle
    # mass a rowing stroke recruits. Always flagged as an estimate for that
    # reason, whichever way the watts were obtained.
    return leg_ergometry_vo2(watts, weight_kg), equation, True


def _elliptical(params: dict, weight_kg: float) -> tuple[float, str, bool]:
    resistance = params.get("resistance")
    return elliptical_vo2(None if resistance is None else float(resistance)), "met_band_elliptical", True


def _outdoor(params: dict, weight_kg: float) -> tuple[float, str, bool]:
    """Distance and duration rather than a console speed — the same two
    equations, with the pace derived instead of read off."""
    speed_kmh = params.get("speed_kmh")
    if speed_kmh is None and params.get("distance_km") is not None and params.get("duration_minutes"):
        hours = float(params["duration_minutes"]) / 60.0
        speed_kmh = float(params["distance_km"]) / hours if hours > 0 else 0.0
    return _treadmill({**params, "speed_kmh": speed_kmh or 0.0}, weight_kg)


_MACHINES = {
    "treadmill": _treadmill,
    "stairmaster": _stairmaster,
    "stepmill": _stairmaster,
    "bike": _bike,
    "cycling": _bike,
    "rower": _rower,
    "rowing": _rower,
    "elliptical": _elliptical,
    "outdoor": _outdoor,
    "walk": _outdoor,
    "run": _outdoor,
}

SUPPORTED_MACHINES = tuple(sorted(_MACHINES))


def estimate_cardio(
    machine: Optional[str],
    params: Optional[dict],
    weight_kg: float,
    duration_minutes: float,
    *,
    net: bool = True,
) -> CardioEstimate:
    """The single entry point. Returns the figure AND how it was reached.

    Degrades rather than failing, in three steps, because a cardio session
    already happened and refusing to record it is the worst possible answer:
      1. an unrecognised machine falls back to workout_service's flat MET table
         (which is what the existing "Move it" action already uses), flagged;
      2. a non-positive duration or weight returns a zero-kcal estimate rather
         than raising, matching estimate_cardio_calories' own contract;
      3. any equation given inputs outside its published validity band still
         computes, and reports `is_estimate=True`.
    """
    params = params or {}
    key = (machine or "").strip().lower()

    if duration_minutes <= 0 or weight_kg <= 0:
        return CardioEstimate(0.0, 0.0, 0.0, "invalid_input", True, "net" if net else "gross")

    handler = _MACHINES.get(key)
    if handler is None:
        # Imported lazily and locally: workout_service does not import this
        # module, and keeping the dependency one-way means neither can become
        # the other's import cycle later.
        from services.workout_service import CARDIO_DEFAULT_MET, CARDIO_MET_BY_ACTIVITY

        met = CARDIO_MET_BY_ACTIVITY.get(key, CARDIO_DEFAULT_MET)
        vo2 = met * RESTING_VO2
        kcal = vo2_to_kcal(vo2, weight_kg, duration_minutes, net=net)
        return CardioEstimate(
            round(kcal, 1), round(met, 2), round(vo2, 2), "flat_met", True, "net" if net else "gross"
        )

    vo2, equation_id, extrapolated = handler(params, weight_kg)
    kcal = vo2_to_kcal(vo2, weight_kg, duration_minutes, net=net)
    return CardioEstimate(
        kcal=round(kcal, 1),
        met=round(vo2_to_met(vo2), 2),
        vo2_ml_kg_min=round(vo2, 2),
        equation_id=equation_id,
        is_estimate=extrapolated,
        basis="net" if net else "gross",
    )
