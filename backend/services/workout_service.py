"""Workout Diary — MET-based calorie-burn estimation.

Pure, deterministic math only, mirroring services/trends_service.py and
services/analytics_service.py's own "no Supabase, fully unit-testable"
shape (see backend/tests/test_workout_service.py) — the routers/workouts.py
router does the actual Supabase reads/writes and calls into this module.

The formula is the standard, widely-used MET approximation every mainstream
fitness app is built on: calories = MET x bodyweight_kg x duration_hours.
MET values are approximate Compendium-of-Physical-Activities figures for
resistance training (code ~02050-02054) and cardio (code ~02061), not a
per-exercise lookup — precise enough for a "how much did that session cost
you" estimate, not a clinical measurement.

PHASE 5 — TWO HONESTY CORRECTIONS, AND THEY CHANGE NUMBERS USERS HAVE SEEN
--------------------------------------------------------------------------
Both were documented as known problems before they were fixed, and both make
the reported figure SMALLER.
`session_energy()` below is the function that applies them; the two older
`estimate_*` functions keep their exact previous meaning so the correction is
visible as a diff rather than hidden inside an unchanged call.

1. SET DENSITY (`set_density_factor`). `avg_MET x kg x hours` says a 90-minute
   session with 30 hard sets and a 90-minute session with 4 sets and a lot of
   phone-scrolling cost the same. Once `ended_at` is set the duration is real
   elapsed time, so the sparse session simply collects credit for standing
   still. A bounded multiplier now scales the effective MET by how dense the
   session actually was against the density a Compendium resistance figure
   already assumes.

2. GROSS vs NET (`resting_kcal`). `MET x kg x hours` is GROSS energy
   expenditure: it includes the resting metabolism that would have happened on
   the sofa. Every burn figure this app has ever shown was therefore inflated
   by roughly one MET for the duration (~70-110 kcal/hour). The session's
   stored `calories_burned` is now NET — what the training cost ON TOP of
   living — computed by subtracting the user's own BMR over the same elapsed
   time, via analytics_service.calculate_bmr. This is the same distinction
   services/cardio_service.py has drawn since Phase 3; strength was simply
   never brought in line with it, so a session holding both reported its two
   halves on two different bases.

Neither correction is applied retroactively to figures already stored. A
session's `calories_burned` is rewritten only when that session is next
recomputed (a set added, edited or deleted, a cardio entry changed, or the
session finished), because nothing here can reconstruct the bodyweight and
profile that were current when an old row was written. History therefore shows
the old, larger numbers until it is touched — stated here rather than
discovered later.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Optional, TypedDict

# Keyed by lowercased category — matches both the curated
# backend/data/discover_data.py::POPULAR_EXERCISES categories (Chest, Back,
# Legs, Shoulders, Arms, Core, Cardio) and wger.de's own exerciseinfo
# category names (services/exercise_cache_service.py), which use the same
# vocabulary plus a few extras (e.g. "Calves"). Anything not covered here
# (an unmapped/legacy category, or the pre-existing workout_logs migration
# rows that never had a category at all) falls back to DEFAULT_MET.
BASE_MET_BY_CATEGORY: dict[str, float] = {
    "chest": 5.0,
    "back": 5.0,
    "legs": 6.0,
    "shoulders": 4.5,
    "arms": 4.0,
    "core": 4.0,
    "abs": 4.0,
    "calves": 4.0,
    "cardio": 8.0,
    "full body": 6.0,
}

# General resistance training, moderate-to-vigorous effort — a reasonable
# middle-of-the-road figure when an exercise's category is missing or
# doesn't match any key above.
DEFAULT_MET = 5.0

# Used only when the user has never logged a weight_logs entry — an
# approximate average adult bodyweight, same "fall back to a sane average
# rather than refuse to estimate" posture as
# analytics_service.calculate_bmr's own weight-only fallback.
DEFAULT_BODYWEIGHT_KG = 70.0

# A working set plus its rest period, in seconds — used only to estimate the
# duration of a session that's still in progress (no ended_at yet), so a
# live "estimated calories so far" figure has something non-zero to show
# before the user taps "Finish workout". A documented heuristic, not a
# measurement.
AVG_SECONDS_PER_SET = 90

# rpe_effort_scale anchors: RPE 5 (a comfortably-paced working set) scales
# the base MET down to 0.8x; RPE 10 (an all-out max effort) scales it up to
# 1.2x. Clamped beyond those anchors so an edge-case RPE of 1 or 10 doesn't
# produce an implausible multiplier.
_RPE_SCALE_MIN = 0.6
_RPE_SCALE_MAX = 1.3
_RPE_NEUTRAL = 5.0
_RPE_SCALE_PER_POINT = 0.08
_RPE_BASELINE_SCALE = 0.8


class SetInput(TypedDict, total=False):
    category: Optional[str]
    rpe: Optional[float]


def rpe_effort_scale(rpe: Optional[float]) -> float:
    """1.0-neutral effort multiplier when RPE wasn't logged for a set (the
    field is optional — see sql/schema.sql's workout_sets.rpe comment);
    otherwise scales base MET by how hard that set actually felt."""
    if rpe is None:
        return 1.0
    scale = _RPE_BASELINE_SCALE + (rpe - _RPE_NEUTRAL) * _RPE_SCALE_PER_POINT
    return max(_RPE_SCALE_MIN, min(_RPE_SCALE_MAX, scale))


def estimate_session_duration_hours(
    *,
    started_at: Optional[str],
    ended_at: Optional[str],
    set_count: int,
) -> float:
    """Real elapsed time once a session has been finished (ended_at set);
    otherwise an estimate from set count x AVG_SECONDS_PER_SET, for a
    session still in progress. `set_count` is floored at 1 so a
    freshly-started session with its very first set logged doesn't read as
    a zero-duration, zero-calorie session."""
    if started_at and ended_at:
        start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
        return max((end - start).total_seconds() / 3600, 0.0)
    return max(set_count, 1) * AVG_SECONDS_PER_SET / 3600


def estimate_session_calories(
    sets: list[SetInput],
    weight_kg: float,
    duration_hours: float,
) -> float:
    """calories = average_effective_MET x bodyweight_kg x duration_hours.
    `sets` need only carry `category`/`rpe` — the router passes the
    session's actual workout_sets rows through as-is."""
    if not sets or duration_hours <= 0 or weight_kg <= 0:
        return 0.0
    effective_mets = [
        BASE_MET_BY_CATEGORY.get((s.get("category") or "").strip().lower(), DEFAULT_MET) * rpe_effort_scale(s.get("rpe"))
        for s in sets
    ]
    avg_met = sum(effective_mets) / len(effective_mets)
    return round(avg_met * weight_kg * duration_hours, 1)


# ---------------------------------------------------------------------------
# Phase 5.1 — set density
#
# WHY A MULTIPLIER RATHER THAN A WORK/REST SPLIT. The obvious model is to price
# the working sets at the session MET and the rest periods at something near
# resting. It is wrong HERE, and the reason matters: the Compendium's
# resistance-training codes are already whole-session averages that include the
# rest between sets (02050 "multiple exercises, 8-15 reps" is 3.5 METs; 02054
# "vigorous effort" is 6.0 — neither is the MET of the set itself). Splitting
# work from rest on top of a figure that has already done so would discount the
# rest twice and land a normal hour of lifting near 210 kcal gross, roughly half
# of every published measurement of the same activity.
#
# So the base MET keeps meaning what it means — a typical session, rest
# included — and this only asks how far from typical THIS session was.
#
# DENSITY_REFERENCE_SECONDS_PER_SET is that "typical": 160 s per set, i.e. a
# working set plus a ~2-minute rest, which is what 60 min/22 sets, 90 min/34
# sets and 45 min/17 sets all come out at. It is deliberately NOT
# AVG_SECONDS_PER_SET (90) above — that constant answers a different question
# ("how long has this unfinished session probably been going"), where people
# under-estimate because early sets are quicker, and reusing it here would
# penalise every ordinary session by 25%.
DENSITY_REFERENCE_SECONDS_PER_SET = 160.0

# The band the multiplier is clamped to.
#
# The FLOOR is the load-bearing one: a session at 4 sets in 90 minutes has a raw
# density ratio of 0.12, and a linear factor would price it at 12% of a normal
# session — i.e. as if the user had been lying down. They were not: they were in
# a gym, upright, walking between machines, setting up, recovering. 0.55 encodes
# "even a very sparse gym session costs meaningfully more than rest", which is
# the honest floor.
#
# The CEILING is modest on purpose. A very dense session is a real thing
# (circuits, supersets) and deserves credit, but the base MET already carries
# most of the intensity signal and RPE carries the rest, so letting density
# alone add more than 15% would be double-counting effort that
# rpe_effort_scale() has already priced.
DENSITY_MIN = 0.55
DENSITY_MAX = 1.15


def set_density_factor(set_count: int, duration_hours: float) -> float:
    """How dense this session was, as a multiplier on its effective MET.

    1.0 means "exactly as dense as the base MET already assumes". The square
    root is what keeps the fall-off gentle: energy cost is not proportional to
    density, because the non-set time is still time spent upright in a gym, so
    halving the density must not halve the burn. sqrt(0.5) = 0.71 is a
    defensible 29% discount; 0.5 would not be.

    Returns 1.0 (no adjustment) for a session with no sets or no duration —
    there is nothing to be denser or sparser than.
    """
    if set_count <= 0 or duration_hours <= 0:
        return 1.0
    reference_hours = set_count * DENSITY_REFERENCE_SECONDS_PER_SET / 3600
    ratio = reference_hours / duration_hours
    return max(DENSITY_MIN, min(DENSITY_MAX, ratio**0.5))


# ---------------------------------------------------------------------------
# Phase 5.2 — gross vs net
# ---------------------------------------------------------------------------
HOURS_PER_DAY = 24.0


def resting_kcal(bmr_kcal_per_day: float, duration_hours: float) -> float:
    """The resting metabolism that would have happened anyway over the same
    elapsed time — the term that turns a gross figure into a net one.

    `bmr_kcal_per_day` comes from analytics_service.calculate_bmr, which is
    Mifflin-St Jeor when the user has filled in age/height/sex and a weight-only
    ~22 kcal/kg/day approximation otherwise. Worth noting that the fallback and
    the "subtract 1 MET" shortcut cardio_service uses agree to within about 8%
    (1 MET is ~24 kcal/kg/day by definition), so the two modules do not disagree
    about what resting means — this one is simply more accurate for a user who
    has told the app who they are.
    """
    if bmr_kcal_per_day <= 0 or duration_hours <= 0:
        return 0.0
    return bmr_kcal_per_day / HOURS_PER_DAY * duration_hours


def strength_duration_hours(
    duration_hours: float,
    cardio_minutes: float,
    *,
    measured_duration: bool,
) -> float:
    """The part of a session's elapsed time that was NOT cardio.

    A session can hold both — a lift and a bike finisher — and until Phase 5
    both halves were priced over overlapping time: the strength figure used the
    session's WHOLE elapsed window (including the twenty minutes on the bike)
    and the cardio rows then added their own twenty minutes on top. Sixty
    minutes of real time was billed as eighty minutes of work.

    That was invisible while the two halves used different bases anyway. Making
    them share one (5.2) is what made it visible, so it is corrected here.

    Only applies to a MEASURED duration. For a session still in progress the
    duration was derived from the set count, not from a clock, so there is no
    elapsed window for cardio to sit inside and nothing to subtract. Clamped at
    zero: cardio logged after the fact can legitimately exceed the session's own
    elapsed time.
    """
    if not measured_duration:
        return duration_hours
    return max(duration_hours - max(cardio_minutes, 0.0) / 60.0, 0.0)


@dataclass(frozen=True)
class SessionEnergy:
    """The figure AND how it was reached — the same "return the provenance
    beside the number" shape services/cardio_service.py's CardioEstimate
    already uses, and for the same reason: `net` is what gets stored and shown,
    so everything that produced it has to be inspectable rather than implied.

    `net` is floored at zero. A very short, very sparse session can price below
    its own resting metabolism, and a NEGATIVE burn is not a thing a user can be
    shown — the honest reading of that case is "this cost essentially nothing
    beyond being alive", which is 0.
    """

    gross: float
    net: float
    resting: float
    density_factor: float
    duration_hours: float
    basis: str = "net"


def session_energy(
    sets: list[SetInput],
    weight_kg: float,
    duration_hours: float,
    *,
    measured_duration: bool,
    bmr_kcal_per_day: float = 0.0,
) -> SessionEnergy:
    """The whole Phase 5 calculation, in one place.

    `measured_duration` is load-bearing and is why density is not applied
    unconditionally. For a session still in progress, `duration_hours` was
    DERIVED from the set count (estimate_session_duration_hours), so its density
    is fixed by construction and asking how dense it is would be circular — the
    answer would be a constant, and a constant one that happens to be 0.56,
    which would silently discount every live estimate. Density is a claim about
    real elapsed time, so it is applied only when there is real elapsed time.
    """
    gross_at_reference_density = estimate_session_calories(sets, weight_kg, duration_hours)
    factor = set_density_factor(len(sets), duration_hours) if measured_duration else 1.0
    gross = round(gross_at_reference_density * factor, 1)
    resting = round(resting_kcal(bmr_kcal_per_day, duration_hours), 1)
    return SessionEnergy(
        gross=gross,
        net=round(max(gross - resting, 0.0), 1),
        resting=resting,
        density_factor=round(factor, 4),
        duration_hours=duration_hours,
    )


# Duration-based cardio (a walk/run/ride), logged as a whole activity with a
# time — not as sets of reps. Used by the "Move it" action in Damage Control
# (frontend/js/damageControl.js -> POST /workouts/sessions with
# activity/duration_minutes) and available to any future "quick cardio"
# entry. Same MET x bodyweight x hours formula as estimate_session_calories
# above, just with the duration given directly instead of inferred from set
# count / elapsed time. Keys are lowercased; anything unrecognised falls back
# to CARDIO_DEFAULT_MET (a brisk walk).
CARDIO_MET_BY_ACTIVITY: dict[str, float] = {
    "walk": 3.0,
    "brisk walk": 4.3,
    "power walk": 5.0,
    "jog": 7.0,
    "run": 9.8,
    "cycling": 7.5,
    "bike": 7.5,
    "swim": 7.0,
    "row": 7.0,
    "elliptical": 5.0,
    "hike": 6.0,
    "jump rope": 11.0,
}
CARDIO_DEFAULT_MET = 4.3


def estimate_cardio_calories(activity: str | None, duration_minutes: float, weight_kg: float) -> float:
    """calories = MET x bodyweight_kg x duration_hours, for a single
    duration-based cardio activity. Returns 0.0 for a non-positive duration or
    weight rather than raising — the caller (routers/workouts.py) treats a 0
    the same as "no estimate available", exactly like estimate_session_calories."""
    if duration_minutes <= 0 or weight_kg <= 0:
        return 0.0
    met = CARDIO_MET_BY_ACTIVITY.get((activity or "").strip().lower(), CARDIO_DEFAULT_MET)
    return round(met * weight_kg * (duration_minutes / 60.0), 1)


def average_daily_calories_burned(session_rows: list[dict], window_days: int) -> float:
    """Sum of calories_burned across `session_rows` (already fetched for
    some window, e.g. the last 7 days) divided by the FULL window length —
    not just the days a session happened — so a rest day correctly pulls
    the daily average down rather than being excluded from it. This is the
    figure fed into analytics_service.calculate_tdee_with_logged_activity;
    see that function for why it's only ever applied on the formula-based
    TDEE path."""
    if window_days <= 0:
        return 0.0
    total = sum(row.get("calories_burned") or 0 for row in session_rows)
    return round(total / window_days, 1)
