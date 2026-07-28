from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_today(tz_name: str, now: datetime | None = None) -> date:
    """The current calendar date in the user's own timezone — this, not UTC,
    is what "today"/"midnight" means everywhere in the app now. Falls back to
    UTC on a bad/unrecognized zone name (e.g. a deprecated IANA alias a
    browser occasionally reports) rather than raising — the value is already
    validated against zoneinfo.available_timezones() when it's saved (see
    routers/day.py), so this is defense in depth, not the primary guard.

    `now` (any aware datetime, defaults to real UTC now) exists purely so
    this is testable at a fixed instant — same pattern as trends_service's
    `today` parameter — without it there'd be no way to prove a timestamp
    that's "today" in UTC can be yesterday/tomorrow in a real local zone."""
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    reference = now or datetime.now(timezone.utc)
    return reference.astimezone(tz).date()


def is_day_ended(day_ended_date: date | None, today: date) -> bool:
    """A day is locked for further logging iff the user pressed "End day"
    on today's own local date. This self-clears for free the moment local
    midnight passes real time — day_ended_date from yesterday (or earlier)
    no longer equals today, so there's no counter to advance or boundary to
    persist, unlike the old day_number/day_boundary model this replaces."""
    return day_ended_date is not None and day_ended_date == today
