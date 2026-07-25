from services.trends_service import compute_trends


def _log(day_number: int, calories: float, protein=0.0, carbs=0.0, fats=0.0, logged_at="2026-07-23T12:00:00+00:00"):
    return {
        "day_number": day_number,
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fats": fats,
        "logged_at": logged_at,
    }


def _water(day_number: int, amount_ml: int, logged_at="2026-07-23T12:00:00+00:00"):
    return {"day_number": day_number, "amount_ml": amount_ml, "logged_at": logged_at}


def test_empty_window_has_no_streak_and_zeroed_days():
    result = compute_trends([], [], [], retention_days=7, target_calories=2000, current_day_number=7)
    assert len(result.days) == 7
    assert result.streak == 0
    assert all(d.calories == 0 and not d.adherent for d in result.days)
    # Oldest first, current day last.
    assert result.days[0].day_number == 1
    assert result.days[-1].day_number == 7


def test_fresh_account_only_shows_days_that_have_existed():
    """A brand-new account (current_day_number=2) must never show phantom
    days before it was created, even though retention_days=7 would otherwise
    allow up to 7 rows."""
    result = compute_trends([], [], [], retention_days=7, target_calories=2000, current_day_number=2)
    assert len(result.days) == 2
    assert [d.day_number for d in result.days] == [1, 2]


def test_day_within_tolerance_is_adherent():
    logs = [_log(6, 2050)]  # 2.5% over a 2000 target — within ±10%
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    day = next(d for d in result.days if d.day_number == 6)
    assert day.adherent is True
    assert day.calories == 2050


def test_day_outside_tolerance_is_not_adherent():
    logs = [_log(6, 2500)]  # 25% over — outside ±10%
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    day = next(d for d in result.days if d.day_number == 6)
    assert day.adherent is False


def test_multiple_logs_same_day_number_are_summed():
    logs = [
        _log(6, 800, protein=50),
        _log(6, 700, protein=40),
        _log(6, 500, protein=30),
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    day = next(d for d in result.days if d.day_number == 6)
    assert day.calories == 2000
    assert day.protein == 120


def test_two_end_day_presses_same_calendar_date_are_two_separate_rows():
    """Pressing 'End Day' twice on the same real date advances day_number
    twice — trends must show that as two rows, not merge them by date."""
    logs = [
        _log(5, 1200, logged_at="2026-07-23T09:00:00+00:00"),
        _log(6, 900, logged_at="2026-07-23T20:00:00+00:00"),
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=6)
    day5 = next(d for d in result.days if d.day_number == 5)
    day6 = next(d for d in result.days if d.day_number == 6)
    assert day5.calories == 1200
    assert day6.calories == 900
    assert day5.date == day6.date == "2026-07-23"


def test_streak_counts_consecutive_adherent_days_ending_at_current_day():
    logs = [
        _log(5, 2000),
        _log(6, 2000),
        _log(7, 2000),  # current day, adherent
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    assert result.streak == 3


def test_streak_breaks_on_a_non_adherent_past_day():
    logs = [
        _log(4, 2000),
        _log(5, 5000),  # blown day
        _log(6, 2000),
        _log(7, 2000),
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    assert result.streak == 2  # only day_number 6 and 7


def test_current_day_with_no_logs_yet_does_not_zero_an_intact_streak():
    """The current day isn't over yet — 'nothing logged so far' must never
    read as a broken streak, only a bad day *already logged* should."""
    logs = [
        _log(5, 2000),
        _log(6, 2000),
        # nothing for day 7 (current) yet
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    assert result.streak == 2


def test_current_day_with_a_bad_log_does_break_the_streak():
    logs = [
        _log(5, 2000),
        _log(6, 2000),
        _log(7, 9000),  # current day, already blown
    ]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    assert result.streak == 0


def test_water_is_grouped_per_logical_day():
    water = [
        _water(6, 250, logged_at="2026-07-22T08:00:00+00:00"),
        _water(6, 500, logged_at="2026-07-22T18:00:00+00:00"),
    ]
    result = compute_trends([], water, [], retention_days=7, target_calories=2000, current_day_number=7)
    day = next(d for d in result.days if d.day_number == 6)
    assert day.water_ml == 750


def test_weight_is_matched_by_the_calendar_date_of_the_days_latest_log():
    logs = [_log(6, 2000, logged_at="2026-07-22T12:00:00+00:00")]
    weight = [
        {"weight_kg": 80.5, "logged_at": "2026-07-22T07:00:00+00:00"},
        {"weight_kg": 80.2, "logged_at": "2026-07-22T20:00:00+00:00"},  # later same day — should win
    ]
    result = compute_trends(logs, [], weight, retention_days=7, target_calories=2000, current_day_number=7)
    day = next(d for d in result.days if d.day_number == 6)
    assert day.weight_kg == 80.2


def test_z_suffixed_timestamps_parse_the_same_as_offset_timestamps():
    logs = [_log(6, 1000, logged_at="2026-07-22T12:00:00Z")]
    result = compute_trends(logs, [], [], retention_days=7, target_calories=2000, current_day_number=7)
    day = next(d for d in result.days if d.day_number == 6)
    assert day.calories == 1000
