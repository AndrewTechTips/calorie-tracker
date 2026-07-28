from datetime import date, datetime, timezone

from services.daytime_service import is_day_ended, local_today


def test_local_today_can_be_a_day_behind_utc():
    # 02:00 UTC on the 23rd is still 19:00 on the 22nd in Los Angeles (UTC-7
    # in July, DST) — this is exactly the bug a purely UTC-based "today"
    # used to have: it rolls the day over hours before/after this user's
    # real local midnight, depending on their offset.
    instant = datetime(2026, 7, 23, 2, 0, tzinfo=timezone.utc)
    assert instant.date() == date(2026, 7, 23)
    assert local_today("America/Los_Angeles", now=instant) == date(2026, 7, 22)


def test_local_today_can_be_a_day_ahead_of_utc():
    # 23:00 UTC on the 23rd is already 11:00 on the 24th in Auckland
    # (NZST, UTC+12 — no DST in the southern-hemisphere winter this app's
    # dates fall in).
    instant = datetime(2026, 7, 23, 23, 0, tzinfo=timezone.utc)
    assert instant.date() == date(2026, 7, 23)
    assert local_today("Pacific/Auckland", now=instant) == date(2026, 7, 24)


def test_local_today_falls_back_to_utc_for_an_unrecognized_zone():
    instant = datetime(2026, 7, 23, 12, 0, tzinfo=timezone.utc)
    assert local_today("Not/AZone", now=instant) == local_today("UTC", now=instant)


def test_is_day_ended_true_when_ended_date_matches_today():
    assert is_day_ended(date(2026, 7, 23), date(2026, 7, 23)) is True


def test_is_day_ended_false_once_a_new_local_date_has_begun():
    """Self-clears the moment local midnight passes — no explicit reset
    needed, unlike the old day_number/day_boundary lazy-advance model."""
    assert is_day_ended(date(2026, 7, 22), date(2026, 7, 23)) is False


def test_is_day_ended_false_when_never_ended():
    assert is_day_ended(None, date(2026, 7, 23)) is False
