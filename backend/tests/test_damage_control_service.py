from datetime import date

import pytest

from services import damage_control_service as dc
from services.effective_targets import effective_calorie_target

TODAY = date(2026, 9, 2)


# ---------------------------------------------------------------------------
# compute_deflation — the "shrink the number" arithmetic
# ---------------------------------------------------------------------------
def test_compute_deflation_spreads_overage_across_the_default_week():
    result = dc.compute_deflation(700)
    assert result["spread_days"] == 7
    assert result["per_day_kcal"] == 100  # 700 / 7
    assert result["fat_equiv_g"] == 78  # 700 / 9 -> 77.8 -> 78


def test_compute_deflation_rounds_per_day_to_nearest_kcal():
    # 705 / 7 = 100.71 -> 101
    assert dc.compute_deflation(705)["per_day_kcal"] == 101


def test_compute_deflation_clamps_spread_days_to_minimum_three():
    result = dc.compute_deflation(600, spread_days=1)
    assert result["spread_days"] == 3
    assert result["per_day_kcal"] == 200  # 600 / 3, not 600 / 1


def test_compute_deflation_clamps_spread_days_to_maximum_fourteen():
    result = dc.compute_deflation(1400, spread_days=99)
    assert result["spread_days"] == 14
    assert result["per_day_kcal"] == 100  # 1400 / 14


def test_compute_deflation_zero_or_negative_overage_never_divides_or_goes_negative():
    for over in (0, -50):
        result = dc.compute_deflation(over)
        assert result["per_day_kcal"] == 0
        assert result["fat_equiv_g"] == 0
        assert result["spread_days"] == 7


# ---------------------------------------------------------------------------
# build_sparkline — the dense "zoom-out" series
# ---------------------------------------------------------------------------
def test_build_sparkline_returns_exactly_window_days_oldest_first_ending_today():
    points = dc.build_sparkline([], today=TODAY, window_days=14, default_target=2200)
    assert len(points) == 14
    assert points[0]["date"] == "2026-08-20"
    assert points[-1]["date"] == "2026-09-02"
    assert points[-1]["is_today"] is True
    assert sum(1 for p in points if p["is_today"]) == 1


def test_build_sparkline_missing_days_are_gaps_not_zero_bars_and_keep_the_target_line_flat():
    points = dc.build_sparkline([], today=TODAY, window_days=14, default_target=2200)
    assert all(p["logged"] is False and p["calories"] == 0.0 for p in points)
    # target still populated so the reference line doesn't collapse to 0
    assert all(p["target"] == 2200 for p in points)


def test_build_sparkline_fills_logged_days_from_summary_rows():
    rows = [
        {"date": "2026-09-01", "calories": 2150, "target": 2200},
        {"date": "2026-09-02", "calories": 3000, "target": 2200},
    ]
    points = dc.build_sparkline(rows, today=TODAY, window_days=14, default_target=2200)
    by_date = {p["date"]: p for p in points}
    assert by_date["2026-09-01"]["calories"] == 2150 and by_date["2026-09-01"]["logged"] is True
    assert by_date["2026-09-02"]["calories"] == 3000 and by_date["2026-09-02"]["logged"] is True
    assert by_date["2026-08-31"]["logged"] is False


def test_build_sparkline_ignores_rows_outside_the_window():
    rows = [{"date": "2026-07-01", "calories": 9999, "target": 2200}]
    points = dc.build_sparkline(rows, today=TODAY, window_days=14, default_target=2200)
    assert all(p["calories"] == 0.0 for p in points)


def test_build_sparkline_accepts_date_objects_as_row_keys():
    rows = [{"date": date(2026, 9, 2), "calories": 2800, "target": 2100}]
    points = dc.build_sparkline(rows, today=TODAY, window_days=7, default_target=2200)
    assert points[-1]["calories"] == 2800
    assert points[-1]["target"] == 2100  # row's own target wins over the default


# ---------------------------------------------------------------------------
# trailing_average
# ---------------------------------------------------------------------------
def _sparkline_with(calorie_by_date):
    rows = [{"date": d, "calories": c, "target": 2200} for d, c in calorie_by_date.items()]
    return dc.build_sparkline(rows, today=TODAY, window_days=14, default_target=2200)


def test_trailing_average_incl_and_excl_today():
    points = _sparkline_with({"2026-08-31": 2000, "2026-09-01": 2200, "2026-09-02": 3300})
    assert dc.trailing_average(points, include_today=True) == 2500  # (2000+2200+3300)/3
    assert dc.trailing_average(points, include_today=False) == 2100  # (2000+2200)/2 — "barely moves"


def test_trailing_average_no_logged_days_is_zero_not_zerodivision():
    points = dc.build_sparkline([], today=TODAY, window_days=14, default_target=2200)
    assert dc.trailing_average(points, include_today=True) == 0
    assert dc.trailing_average(points, include_today=False) == 0


def test_trailing_average_excl_today_with_only_today_logged_is_zero():
    points = _sparkline_with({"2026-09-02": 3300})
    assert dc.trailing_average(points, include_today=False) == 0
    assert dc.trailing_average(points, include_today=True) == 3300


# ---------------------------------------------------------------------------
# walk_minutes_for — "Move it" prefill
# ---------------------------------------------------------------------------
def test_walk_minutes_scales_with_overage_and_clamps_to_a_realistic_range():
    # 70 kg, MET 4.3 -> ~5.27 kcal/min
    assert dc.walk_minutes_for(150, 70) == 28
    assert dc.walk_minutes_for(2000, 70) == 60  # clamped, not "walk for 6 hours"
    assert dc.walk_minutes_for(10, 70) == 5  # floored


def test_walk_minutes_uses_default_bodyweight_when_weight_unknown():
    assert dc.walk_minutes_for(300, None) == dc.walk_minutes_for(300, dc.DEFAULT_BODYWEIGHT_KG)


def test_walk_minutes_zero_overage_is_the_floor_not_zero():
    assert dc.walk_minutes_for(0, 70) == 5


# ---------------------------------------------------------------------------
# trimmed_target_for_tomorrow — "Trim tomorrow"
# ---------------------------------------------------------------------------
def test_trimmed_target_subtracts_the_per_day_figure():
    assert dc.trimmed_target_for_tomorrow(2200, 100) == 2100


def test_trimmed_target_never_below_the_safety_floor():
    assert dc.trimmed_target_for_tomorrow(1600, 400) == dc.TRIM_FLOOR_KCAL  # 1200 -> 1500


def test_trimmed_target_rounds_to_whole_kcal():
    assert dc.trimmed_target_for_tomorrow(2200.4, 100.4) == 2100


# ---------------------------------------------------------------------------
# effective_calorie_target — the "Trim tomorrow" override read path
# ---------------------------------------------------------------------------
def test_effective_target_returns_override_when_date_is_today():
    profile = {"daily_calories": 2200, "temp_calorie_override": 2000, "temp_override_date": "2026-09-02"}
    assert effective_calorie_target(profile, TODAY) == 2000


def test_effective_target_ignores_a_stale_override():
    profile = {"daily_calories": 2200, "temp_calorie_override": 2000, "temp_override_date": "2026-09-01"}
    assert effective_calorie_target(profile, TODAY) == 2200


def test_effective_target_ignores_a_future_override():
    profile = {"daily_calories": 2200, "temp_calorie_override": 2000, "temp_override_date": "2026-09-03"}
    assert effective_calorie_target(profile, TODAY) == 2200


def test_effective_target_accepts_a_date_object_override_date():
    profile = {"daily_calories": 2200, "temp_calorie_override": 1900, "temp_override_date": date(2026, 9, 2)}
    assert effective_calorie_target(profile, TODAY) == 1900


def test_effective_target_falls_back_to_default_when_profile_or_column_missing():
    assert effective_calorie_target(None, TODAY) == 2200
    assert effective_calorie_target({}, TODAY) == 2200
    assert effective_calorie_target({"daily_calories": None}, TODAY) == 2200


def test_effective_target_no_override_returns_daily_calories():
    assert effective_calorie_target({"daily_calories": 2450}, TODAY) == 2450
