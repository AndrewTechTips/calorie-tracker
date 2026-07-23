from datetime import date

from services.trends_service import compute_trends


def _log(day: str, calories: float, protein=0.0, carbs=0.0, fats=0.0):
    return {
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fats": fats,
        "logged_at": f"{day}T12:00:00+00:00",
    }


def test_empty_window_has_no_streak_and_zeroed_days():
    result = compute_trends([], [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    assert len(result.days) == 7
    assert result.streak == 0
    assert all(d.calories == 0 and not d.adherent for d in result.days)
    # Oldest first, today last.
    assert result.days[0].date == "2026-07-17"
    assert result.days[-1].date == "2026-07-23"


def test_day_within_tolerance_is_adherent():
    logs = [_log("2026-07-22", 2050)]  # 2.5% over a 2000 target — within ±10%
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    day = next(d for d in result.days if d.date == "2026-07-22")
    assert day.adherent is True
    assert day.calories == 2050


def test_day_outside_tolerance_is_not_adherent():
    logs = [_log("2026-07-22", 2500)]  # 25% over — outside ±10%
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    day = next(d for d in result.days if d.date == "2026-07-22")
    assert day.adherent is False


def test_multiple_logs_same_day_are_summed():
    logs = [
        _log("2026-07-22", 800, protein=50),
        _log("2026-07-22", 700, protein=40),
        _log("2026-07-22", 500, protein=30),
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    day = next(d for d in result.days if d.date == "2026-07-22")
    assert day.calories == 2000
    assert day.protein == 120


def test_streak_counts_consecutive_adherent_days_ending_today():
    logs = [
        _log("2026-07-21", 2000),
        _log("2026-07-22", 2000),
        _log("2026-07-23", 2000),  # today, adherent
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    assert result.streak == 3


def test_streak_breaks_on_a_non_adherent_past_day():
    logs = [
        _log("2026-07-20", 2000),
        _log("2026-07-21", 5000),  # blown day
        _log("2026-07-22", 2000),
        _log("2026-07-23", 2000),
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    assert result.streak == 2  # only the 22nd and 23rd


def test_today_with_no_logs_yet_does_not_zero_an_intact_streak():
    """The day isn't over yet — 'nothing logged so far today' must never
    read as a broken streak, only a bad day *already logged* should."""
    logs = [
        _log("2026-07-21", 2000),
        _log("2026-07-22", 2000),
        # nothing for the 23rd (today) yet
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    assert result.streak == 2


def test_today_with_a_bad_log_does_break_the_streak():
    logs = [
        _log("2026-07-21", 2000),
        _log("2026-07-22", 2000),
        _log("2026-07-23", 9000),  # today, already blown
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    assert result.streak == 0


def test_water_and_weight_are_grouped_per_day():
    water = [
        {"amount_ml": 250, "logged_at": "2026-07-22T08:00:00+00:00"},
        {"amount_ml": 500, "logged_at": "2026-07-22T18:00:00+00:00"},
    ]
    weight = [
        {"weight_kg": 80.5, "logged_at": "2026-07-22T07:00:00+00:00"},
        {"weight_kg": 80.2, "logged_at": "2026-07-22T20:00:00+00:00"},  # later same day — should win
    ]
    result = compute_trends([], water, weight, retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    day = next(d for d in result.days if d.date == "2026-07-22")
    assert day.water_ml == 750
    assert day.weight_kg == 80.2


def test_z_suffixed_timestamps_parse_the_same_as_offset_timestamps():
    logs = [_log("2026-07-22", 1000)]
    logs[0]["logged_at"] = "2026-07-22T12:00:00Z"
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, today=date(2026, 7, 23))
    day = next(d for d in result.days if d.date == "2026-07-22")
    assert day.calories == 1000
