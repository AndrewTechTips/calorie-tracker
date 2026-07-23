from datetime import datetime, timezone


def _today_midnight(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def compute_effective_day_state(
    stored_day_number: int,
    stored_boundary: datetime,
    now: datetime | None = None,
) -> tuple[int, datetime, bool]:
    """Lazily advances the day counter for each real midnight that's passed
    since stored_boundary, without touching the boundary itself beyond
    moving it up to today's midnight. This is read-time reconciliation, not
    an "End day" action — those are different things:

    - A normal midnight rollover (this function) should only ever move the
      cutoff to today's midnight, so it doesn't retroactively hide any of
      today's own hours that haven't happened yet.
    - Pressing "End day" (see the router) moves the boundary to *right now*
      instead, deliberately hiding the rest of today from the live view.

    Returns (day_number, boundary, changed) — `changed` tells the caller
    whether this needs to be persisted.
    """
    now = now or datetime.now(timezone.utc)
    today_midnight = _today_midnight(now)

    if stored_boundary >= today_midnight:
        return stored_day_number, stored_boundary, False

    days_passed = (today_midnight.date() - stored_boundary.date()).days
    new_day_number = stored_day_number + max(days_passed, 1)
    return new_day_number, today_midnight, True


def effective_cutoff(day_boundary: datetime, now: datetime | None = None) -> datetime:
    """The actual 'today' cutoff to filter logs/water by: whichever is
    later, the stored day_boundary (set by a manual End Day) or today's
    real midnight. The max() matters — a boundary left over from a manual
    End Day yesterday must never suppress today's own entries once a new
    calendar day has actually begun."""
    now = now or datetime.now(timezone.utc)
    return max(day_boundary, _today_midnight(now))
