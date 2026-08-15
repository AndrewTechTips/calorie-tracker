"""Predictive Analytics — weight forecast + Adaptive Goals engine.

Pure, deterministic math only — no AI/LLM call anywhere in this module (see
CLAUDE.md/the task this was built against: "do NOT use any external AI/LLM
API calls for these features"). Every formula here is a named, published,
industry-standard method:

  - Mifflin-St Jeor for BMR (the same formula frontend/js/nutritionMath.js's
    calculateBMR already uses for the Settings target calculator — the
    constants below are kept identical to that file's ACTIVITY_MULTIPLIERS/
    GOAL_CALORIE_OFFSET/GOAL_PROTEIN_PER_KG/FAT_FRACTION_OF_CALORIES so the
    calculator and this engine never disagree on the same inputs).
  - A Goldberg EI:BMR-style cutoff (Goldberg et al. 1991; Black 2000) for
    flagging implausibly low self-reported intake as likely under-logging,
    adapted here to a single-day heuristic (see
    UNDER_LOGGING_RATIO_THRESHOLD's own comment for why the classic
    multi-day-average cutoff value isn't used directly).
  - An empirical TDEE estimate backed out from this user's own observed
    weight-trend regression vs. their logged intake (the same
    "TDEE = intake - rate_of_change x energy_density" approach modern
    adaptive-TDEE tracking apps use), preferred over a population formula
    whenever there's enough weight-log history to trust it.
  - A "dynamic" (not naive-linear) forecast: each simulated day recomputes
    TDEE from that day's own projected weight before advancing, so the
    projection decelerates as weight changes — a simplified single-pool
    approximation of the same feedback the NIH Body Weight Planner (Hall et
    al.) models with a full differential equation, without requiring that
    equation's extra fat-mass/lean-mass state this app doesn't track.

Kept side-effect-free and Supabase-independent, mirroring
services/trends_service.py's own "pure aggregation function, unit-tested
without a live DB" shape — see backend/tests/test_analytics_service.py.
"""

from datetime import datetime
from typing import Literal, Optional

from models import AdaptiveGoalSuggestion, AnomalyDay, WeightForecastPoint, WeightForecastResponse

# ---------------------------------------------------------------------------
# Shared constants — kept byte-for-byte equivalent (same values, same keys)
# to frontend/js/nutritionMath.js's own constants of the same name, since
# both this engine and the existing "Calculate my targets" calculator must
# agree on what e.g. "moderate activity" or "a cut" numerically means.
# ---------------------------------------------------------------------------
ACTIVITY_MULTIPLIERS: dict[str, float] = {
    "sedentary": 1.2,
    "light": 1.375,
    "moderate": 1.55,
    "active": 1.725,
    "very_active": 1.9,
}

GOAL_CALORIE_OFFSET: dict[str, float] = {
    "cut": -0.2,
    "maintain": 0.0,
    "bulk": 0.12,
}

GOAL_PROTEIN_PER_KG: dict[str, float] = {
    "cut": 2.2,
    "maintain": 1.8,
    "bulk": 1.8,
}

FAT_FRACTION_OF_CALORIES = 0.25

# Standard energy-density-of-tissue-change conversion (~3500 kcal/lb,
# widely rounded to 7700 kcal/kg in nutrition science/apps) — a simplification
# (the true figure drifts slightly with fat-vs-lean composition of the
# change), but the same one every mainstream calorie-forecasting tool uses.
ENERGY_DENSITY_KCAL_PER_KG = 7700.0

FORECAST_HORIZONS_DAYS = [30, 60, 90]

# A regression-based (empirical) TDEE is only trusted once there's a real
# trend to fit — fewer points, or a too-short span, is closer to noise than
# signal (day-to-day weight swings ~0.5-1.5kg from water/sodium/glycogen
# alone). Below this, the engine falls back to the Mifflin-St Jeor formula
# instead of a shaky regression (WeightForecastResponse.method="formula").
MIN_WEIGHT_ENTRIES_FOR_REGRESSION = 4
MIN_WEIGHT_SPAN_DAYS_FOR_REGRESSION = 10

# At least this many (non-anomalous) logged days are required before an
# average daily intake is considered meaningful enough to drive a TDEE
# regression or a forecast's projected intake.
MIN_CALORIE_DAYS_FOR_AVERAGE = 3

# Goldberg's original cutoff (EI:BMR < ~1.05, at the individual level,
# 95%-CI-adjusted for a multi-day average) identifies implausibly low
# self-reported energy intake relative to what sustaining that body weight
# requires at rest. Applied here to a SINGLE day's total instead of a
# multi-day average (all this app has within the 7-day retention window on
# any given day), so it's deliberately relaxed well below 1.05 — a single
# real, correctly-logged light-eating day is common and not itself
# suspicious; a single day this far under BMR usually means the log is
# incomplete (e.g. only breakfast was entered), not that the user is
# accurately reporting reduced intake.
UNDER_LOGGING_RATIO_THRESHOLD = 0.7

# Maintain-goal weight is expected to hold roughly flat; this is the
# noise-vs-signal line for calling it "drifting" instead.
MAINTAIN_DRIFT_TOLERANCE_KG_PER_WEEK = 0.3

# For a cut/bulk goal, the minimum weekly rate of change (already signed to
# be positive when the goal calls for movement of that sign) below which
# progress counts as "stalled" rather than merely "a bit slow".
MIN_PROGRESS_RATE_KG_PER_WEEK = 0.1


def calculate_bmr(
    weight_kg: float,
    age: Optional[int] = None,
    height_cm: Optional[float] = None,
    sex: Optional[Literal["male", "female"]] = None,
) -> float:
    """Mifflin-St Jeor when age/height/sex are all known (identical formula
    to nutritionMath.js's calculateBMR). Falls back to a weight-only
    approximation — ~22 kcal/kg/day, a commonly cited quick BMR estimate for
    an average adult body composition (roughly what Mifflin-St Jeor itself
    outputs for a typical adult height/age, just without needing those two
    inputs) — when any of the three is missing, e.g. a user who's never
    opened the target calculator."""
    if age is not None and height_cm is not None and sex is not None:
        base = 10 * weight_kg + 6.25 * height_cm - 5 * age
        return base - 161 if sex == "female" else base + 5
    return 22.0 * weight_kg


def calculate_tdee(bmr: float, activity_level: str) -> float:
    return bmr * ACTIVITY_MULTIPLIERS.get(activity_level, ACTIVITY_MULTIPLIERS["moderate"])


def calculate_tdee_with_logged_activity(bmr: float, activity_level: str, avg_workout_calories_burned: float = 0.0) -> float:
    """A more accurate TDEE when the Workout Diary (services/workout_service.py)
    has real logged training data: BMR x the "little/no exercise" sedentary
    multiplier (the one ACTIVITY_MULTIPLIERS entry that doesn't already bake
    in an assumed training frequency) as a non-exercise baseline, plus the
    user's own measured average daily workout calorie burn on top — rather
    than a generic activity_level guess that likely already assumes roughly
    this much training. Falls through to the unchanged calculate_tdee() when
    there's no logged workout data yet, so a user who hasn't adopted the
    Workout Diary sees zero behavior change.

    Deliberately NOT used on the regression-derived TDEE path
    (estimate_tdee_from_regression) — see build_weight_forecast, which only
    calls this on its "formula" branch. The regression path already backs
    out real energy expenditure (including any exercise) from observed
    weight change vs. logged intake, so adding workout calories on top of
    that estimate too would double-count the same energy twice."""
    if avg_workout_calories_burned <= 0:
        return calculate_tdee(bmr, activity_level)
    return bmr * ACTIVITY_MULTIPLIERS["sedentary"] + avg_workout_calories_burned


def detect_anomalous_days(daily_calories: dict[str, float], bmr_estimate: float) -> list[AnomalyDay]:
    """Flags any day (within `daily_calories`, already summed per calendar
    date) whose total is implausibly low against this user's own BMR — see
    UNDER_LOGGING_RATIO_THRESHOLD. Only days that actually have a nonzero
    log are candidates; a day with no logs at all simply isn't in this dict
    to begin with (the caller only includes real daily_logs rows), so it's
    excluded from averaging without being flagged as a *suspicious* value."""
    if bmr_estimate <= 0:
        return []
    anomalies = []
    for day_date, calories in daily_calories.items():
        if calories <= 0:
            continue
        ratio = calories / bmr_estimate
        if ratio < UNDER_LOGGING_RATIO_THRESHOLD:
            anomalies.append(AnomalyDay(date=day_date, calories=calories, bmr_estimate=bmr_estimate, ratio=round(ratio, 3)))
    anomalies.sort(key=lambda a: a.date)
    return anomalies


def _parse_weight_rows(weight_rows: list[dict]) -> list[tuple[datetime, float]]:
    points = []
    for row in weight_rows:
        ts = datetime.fromisoformat(row["logged_at"].replace("Z", "+00:00"))
        points.append((ts, float(row["weight_kg"])))
    points.sort(key=lambda p: p[0])
    return points


def compute_weight_trend_rate(weight_rows: list[dict]) -> Optional[float]:
    """Ordinary-least-squares slope of weight-over-time, in kg/week —
    mirrors frontend/js/nutritionMath.js's computeLinearTrendRate exactly
    (same x-in-days-since-first-entry construction, same *7 conversion),
    just reimplemented server-side since this engine runs entirely on the
    backend. Returns None with fewer than 2 points (can't fit a line) —
    callers additionally gate on MIN_WEIGHT_ENTRIES_FOR_REGRESSION/
    MIN_WEIGHT_SPAN_DAYS_FOR_REGRESSION before trusting this for a TDEE
    regression, but the raw slope is still returned here whenever it's at
    least computable, for callers (e.g. the "formula" method) that just want
    the best available rate estimate rather than a hard cutoff."""
    points = _parse_weight_rows(weight_rows)
    if len(points) < 2:
        return None
    first_ts = points[0][0]
    xs = [(ts - first_ts).total_seconds() / 86400 for ts, _ in points]
    ys = [w for _, w in points]
    n = len(points)
    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_xx = sum(x * x for x in xs)
    denominator = n * sum_xx - sum_x * sum_x
    if denominator == 0:
        return 0.0
    slope_per_day = (n * sum_xy - sum_x * sum_y) / denominator
    return round(slope_per_day * 7, 3)


def _regression_is_trustworthy(weight_rows: list[dict]) -> bool:
    points = _parse_weight_rows(weight_rows)
    if len(points) < MIN_WEIGHT_ENTRIES_FOR_REGRESSION:
        return False
    span_days = (points[-1][0] - points[0][0]).total_seconds() / 86400
    return span_days >= MIN_WEIGHT_SPAN_DAYS_FOR_REGRESSION


def estimate_tdee_from_regression(mean_daily_calories: float, weekly_rate_kg: float) -> float:
    """TDEE = average intake - (rate of weight change x energy density) —
    the standard empirical-TDEE approach: if you're eating X and losing Y
    kg/week, your true maintenance is higher than X by exactly the energy
    that Y kg/week represents (and lower than X if Y is positive, i.e. gaining).
    """
    return mean_daily_calories - (weekly_rate_kg / 7) * ENERGY_DENSITY_KCAL_PER_KG


def project_weight_forecast(
    current_weight_kg: float,
    avg_daily_calories: float,
    tdee_at_current_weight: float,
    horizons_days: list[int] = FORECAST_HORIZONS_DAYS,
) -> list[WeightForecastPoint]:
    """Simulates forward one day at a time, assuming intake stays at
    `avg_daily_calories` (the recent, anomaly-excluded average) while TDEE is
    recomputed each day from that day's own projected weight — a simple
    proportional scaling of `tdee_at_current_weight` by weight ratio, which
    is what makes this "dynamic" rather than a naive straight-line
    extrapolation: as projected weight drops, TDEE drops with it, so the
    same daily deficit produces progressively smaller daily losses (and the
    reverse on a surplus) — the same directional feedback the NIH Body
    Weight Planner's full model captures, simplified to avoid needing this
    app's untracked fat-mass/lean-mass split.
    """
    if current_weight_kg <= 0:
        return []
    tdee_per_kg = tdee_at_current_weight / current_weight_kg
    weight = current_weight_kg
    horizon_set = set(horizons_days)
    max_day = max(horizons_days)
    points: list[WeightForecastPoint] = []
    for day in range(1, max_day + 1):
        tdee_today = tdee_per_kg * weight
        delta_kg = (avg_daily_calories - tdee_today) / ENERGY_DENSITY_KCAL_PER_KG
        weight += delta_kg
        if day in horizon_set:
            points.append(WeightForecastPoint(days=day, weight_kg=round(weight, 1)))
    return points


def build_weight_forecast(
    *,
    weight_rows: list[dict],
    daily_calories: dict[str, float],
    age: Optional[int],
    height_cm: Optional[float],
    biological_sex: Optional[Literal["male", "female"]],
    activity_level: str,
    retention_days: int,
    avg_daily_workout_calories: float = 0.0,
) -> WeightForecastResponse:
    """Orchestrates the whole forecast: BMR/TDEE, anomaly detection, the
    empirical-vs-formula TDEE choice, and the day-by-day projection. Pure
    function — `weight_rows` (weight_logs rows: {logged_at, weight_kg}) and
    `daily_calories` (already summed per log_date from daily_logs, over
    whatever window the caller fetched) are the only inputs, so this is
    fully unit-testable without touching Supabase.

    `avg_daily_workout_calories` (from services/workout_service.py's
    average_daily_calories_burned, default 0 for a user with no Workout
    Diary history) is used ONLY inside the "formula" branch below, via
    calculate_tdee_with_logged_activity — see that function's docstring for
    why the "regression" branch must never receive it."""
    points = _parse_weight_rows(weight_rows)
    if not points:
        return WeightForecastResponse(data_sufficient=False, method="insufficient", anomaly_window_days=retention_days)

    current_weight_kg = points[-1][1]
    bmr_estimate = calculate_bmr(current_weight_kg, age, height_cm, biological_sex)
    anomalies = detect_anomalous_days(daily_calories, bmr_estimate)
    anomalous_dates = {a.date for a in anomalies}
    clean_calories = [cal for day, cal in daily_calories.items() if day not in anomalous_dates and cal > 0]

    use_regression = _regression_is_trustworthy(weight_rows) and len(clean_calories) >= MIN_CALORIE_DAYS_FOR_AVERAGE
    if use_regression:
        weekly_rate_kg = compute_weight_trend_rate(weight_rows)
        mean_calories = sum(clean_calories) / len(clean_calories)
        tdee_estimate = estimate_tdee_from_regression(mean_calories, weekly_rate_kg)
        avg_daily_calories = mean_calories
        method: Literal["regression", "formula"] = "regression"
    else:
        tdee_estimate = calculate_tdee_with_logged_activity(bmr_estimate, activity_level, avg_daily_workout_calories)
        # No trustworthy empirical rate — fall back to whatever raw
        # regression slope is computable (may be None with <2 weigh-ins) for
        # display purposes only, and assume future intake matches the
        # formula-derived TDEE (i.e. "if you eat at your estimated
        # maintenance") when there isn't enough logged-calorie history to
        # average a real recent intake either.
        weekly_rate_kg = compute_weight_trend_rate(weight_rows)
        avg_daily_calories = (sum(clean_calories) / len(clean_calories)) if clean_calories else tdee_estimate
        method = "formula"

    projections = project_weight_forecast(current_weight_kg, avg_daily_calories, tdee_estimate)

    return WeightForecastResponse(
        data_sufficient=True,
        method=method,
        current_weight_kg=round(current_weight_kg, 1),
        bmr_estimate=round(bmr_estimate),
        tdee_estimate=round(tdee_estimate),
        weekly_rate_kg=weekly_rate_kg,
        projections=projections,
        anomalies=anomalies,
        anomaly_window_days=retention_days,
    )


def rebalance_macros(
    *,
    calories: float,
    goal_type: str,
    weight_kg: float,
    current_protein_g: float,
    current_carbs_g: float,
    current_fats_g: float,
    locked_macro: Optional[Literal["protein", "carbs", "fats"]],
) -> tuple[float, float, float]:
    """Splits `calories` into (protein_g, carbs_g, fats_g).

    With no lock, recomputes all three from scratch using the exact same
    formula as nutritionMath.js's calculateTargets (protein scaled to
    bodyweight by goal, fat as a fixed fraction of calories, carbs fill
    whatever remains) — so an unlocked suggestion always matches what the
    "Calculate my targets" tool would itself suggest at this calorie level.

    With a lock, the locked macro's current GRAM value is held fixed and the
    other two absorb 100% of the calorie change, split between themselves in
    whatever ratio they were already in (so a user's existing carb/fat
    preference is preserved, not reset to a fixed default) — falling back to
    the same default formula split for those two if they were previously
    both zero (nothing to infer a ratio from).
    """
    if locked_macro is None:
        protein_g = round(weight_kg * GOAL_PROTEIN_PER_KG.get(goal_type, GOAL_PROTEIN_PER_KG["maintain"]), 1)
        fat_cal = calories * FAT_FRACTION_OF_CALORIES
        fats_g = round(fat_cal / 9, 1)
        remaining_cal = max(calories - protein_g * 4 - fat_cal, 0)
        carbs_g = round(remaining_cal / 4, 1)
        return protein_g, carbs_g, fats_g

    default_protein_g = weight_kg * GOAL_PROTEIN_PER_KG.get(goal_type, GOAL_PROTEIN_PER_KG["maintain"])

    if locked_macro == "protein":
        protein_g = current_protein_g
        remaining = max(calories - protein_g * 4, 0)
        carb_cal, fat_cal = current_carbs_g * 4, current_fats_g * 9
        total = carb_cal + fat_cal
        if total <= 0:
            fat_cal = remaining * FAT_FRACTION_OF_CALORIES
            carb_cal = remaining - fat_cal
        else:
            carb_cal, fat_cal = remaining * (carb_cal / total), remaining * (fat_cal / total)
        return round(protein_g, 1), round(carb_cal / 4, 1), round(fat_cal / 9, 1)

    if locked_macro == "carbs":
        carbs_g = current_carbs_g
        remaining = max(calories - carbs_g * 4, 0)
        protein_cal, fat_cal = current_protein_g * 4, current_fats_g * 9
        total = protein_cal + fat_cal
        if total <= 0:
            protein_cal = min(default_protein_g * 4, remaining)
            fat_cal = remaining - protein_cal
        else:
            protein_cal, fat_cal = remaining * (protein_cal / total), remaining * (fat_cal / total)
        return round(protein_cal / 4, 1), round(carbs_g, 1), round(fat_cal / 9, 1)

    # locked_macro == "fats"
    fats_g = current_fats_g
    remaining = max(calories - fats_g * 9, 0)
    protein_cal, carb_cal = current_protein_g * 4, current_carbs_g * 4
    total = protein_cal + carb_cal
    if total <= 0:
        protein_cal = min(default_protein_g * 4, remaining)
        carb_cal = remaining - protein_cal
    else:
        protein_cal, carb_cal = remaining * (protein_cal / total), remaining * (carb_cal / total)
    return round(protein_cal / 4, 1), round(carb_cal / 4, 1), round(fats_g, 1)


def evaluate_adaptive_goal(
    *,
    goal_type: str,
    current_daily_calories: float,
    current_protein_g: float,
    current_carbs_g: float,
    current_fats_g: float,
    weight_kg: float,
    tdee_estimate: float,
    weekly_rate_kg: Optional[float],
    method: Literal["regression", "formula"],
    locked_macro: Optional[Literal["protein", "carbs", "fats"]],
) -> AdaptiveGoalSuggestion:
    """The weekly evaluation: is the user's observed weight trend actually
    matching their stated goal, and if not, what calorie/macro change would
    get them back on track — computed from this user's own TDEE estimate
    (see build_weight_forecast), not their possibly-stale existing target.
    """
    ideal_calories = tdee_estimate * (1 + GOAL_CALORIE_OFFSET.get(goal_type, 0.0))

    if method == "formula" or weekly_rate_kg is None:
        # Not enough weight-log history for a trustworthy regression — still
        # surface a formula-based suggestion, but flagged low-confidence and
        # never as an actionable "you're stalled" claim, since there's no
        # real trend yet to judge that against.
        reason: Literal["on_track", "stalled_no_progress", "stalled_wrong_direction", "drifting", "insufficient_data"] = "insufficient_data"
        stalled = False
    elif goal_type == "maintain":
        stalled = abs(weekly_rate_kg) > MAINTAIN_DRIFT_TOLERANCE_KG_PER_WEEK
        reason = "drifting" if stalled else "on_track"
    else:
        expected_sign = -1 if goal_type == "cut" else 1
        signed_progress = weekly_rate_kg * expected_sign
        if signed_progress < 0:
            stalled, reason = True, "stalled_wrong_direction"
        elif signed_progress < MIN_PROGRESS_RATE_KG_PER_WEEK:
            stalled, reason = True, "stalled_no_progress"
        else:
            stalled, reason = False, "on_track"

    suggested_daily_calories = round(ideal_calories)
    protein_g, carbs_g, fats_g = rebalance_macros(
        calories=suggested_daily_calories,
        goal_type=goal_type,
        weight_kg=weight_kg,
        current_protein_g=current_protein_g,
        current_carbs_g=current_carbs_g,
        current_fats_g=current_fats_g,
        locked_macro=locked_macro,
    )

    return AdaptiveGoalSuggestion(
        reason=reason,
        suggested_daily_calories=suggested_daily_calories,
        suggested_protein=protein_g,
        suggested_carbs=carbs_g,
        suggested_fats=fats_g,
        locked_macro=locked_macro,
    )
