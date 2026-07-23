from datetime import datetime, timezone

from services.day_service import compute_effective_day_state, effective_cutoff


def _dt(y, m, d, h=0, mi=0):
    return datetime(y, m, d, h, mi, tzinfo=timezone.utc)


def test_no_change_when_boundary_already_covers_today():
    day_number, boundary, changed = compute_effective_day_state(
        stored_day_number=3,
        stored_boundary=_dt(2026, 7, 23, 8, 0),  # an End Day earlier today
        now=_dt(2026, 7, 23, 14, 0),
    )
    assert (day_number, boundary, changed) == (3, _dt(2026, 7, 23, 8, 0), False)


def test_advances_by_one_after_exactly_one_midnight():
    day_number, boundary, changed = compute_effective_day_state(
        stored_day_number=5,
        stored_boundary=_dt(2026, 7, 22, 0, 0),  # yesterday's midnight
        now=_dt(2026, 7, 23, 9, 0),
    )
    assert day_number == 6
    assert boundary == _dt(2026, 7, 23, 0, 0)
    assert changed is True


def test_advances_by_multiple_days_after_being_away(monkeypatch=None):
    """User hasn't opened the app in 4 days — the counter should catch up
    by the real number of calendar days passed, not just +1."""
    day_number, boundary, changed = compute_effective_day_state(
        stored_day_number=10,
        stored_boundary=_dt(2026, 7, 19, 0, 0),
        now=_dt(2026, 7, 23, 9, 0),
    )
    assert day_number == 14  # 4 days passed
    assert boundary == _dt(2026, 7, 23, 0, 0)
    assert changed is True


def test_first_ever_run_boundary_equals_now_still_advances_zero():
    """A boundary set to right now (e.g. a brand-new profile) should never
    look like a day has already passed."""
    day_number, boundary, changed = compute_effective_day_state(
        stored_day_number=1,
        stored_boundary=_dt(2026, 7, 23, 10, 0),
        now=_dt(2026, 7, 23, 10, 0),
    )
    assert (day_number, changed) == (1, False)
    assert boundary == _dt(2026, 7, 23, 10, 0)


def test_effective_cutoff_uses_manual_end_day_boundary_when_later_today():
    cutoff = effective_cutoff(_dt(2026, 7, 23, 20, 0), now=_dt(2026, 7, 23, 21, 0))
    assert cutoff == _dt(2026, 7, 23, 20, 0)


def test_effective_cutoff_ignores_stale_boundary_from_a_previous_day():
    """A manual End Day from yesterday evening must never suppress today's
    own entries once a new calendar day has genuinely begun."""
    cutoff = effective_cutoff(_dt(2026, 7, 22, 20, 0), now=_dt(2026, 7, 23, 9, 0))
    assert cutoff == _dt(2026, 7, 23, 0, 0)


def test_effective_cutoff_defaults_to_todays_midnight_with_no_manual_override():
    cutoff = effective_cutoff(_dt(2026, 7, 23, 0, 0), now=_dt(2026, 7, 23, 15, 0))
    assert cutoff == _dt(2026, 7, 23, 0, 0)
