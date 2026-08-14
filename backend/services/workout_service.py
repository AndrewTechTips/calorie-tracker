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
"""

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
