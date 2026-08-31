from datetime import datetime, time, timedelta

# Mirrors frontend/js/reminders.js's own constants exactly (FOOD_NUDGE_HOUR/
# WATER_NUDGE_HOUR/NUDGE_WINDOW_END_HOUR/RECAP_HOUR) — that file used to be
# the sole source of "when is a nudge due", firing from an open tab's own
# setInterval. Real Web Push moves the authoritative firing decision here
# (services/notification_scheduler.py), so these constants moved with it;
# reminders.js itself no longer contains this logic (see that file's own
# comment on why local-only firing was removed rather than left to
# potentially double-fire alongside a server push for the same event).
FOOD_NUDGE_HOUR = 14
WATER_NUDGE_HOUR = 15
NUDGE_WINDOW_END_HOUR = 22
# Phase 2 "closing the loop": the Discover "cook what fits tonight" nudge.
# 17:00 local is early enough to still be a dinner-planning prompt, late
# enough that the day's remaining-calorie budget is a real dinner slot
# rather than "the whole day". Shares NUDGE_WINDOW_END_HOUR as its cutoff.
DISCOVER_PICK_HOUR = 17
# Only nudge if there's a genuine dinner-sized budget left — never tell
# someone who's already at their target to go cook more.
DISCOVER_PICK_MIN_REMAINING_CALORIES = 300
# Python's date.weekday(): Monday=0 ... Sunday=6 — unlike JS's
# Date.getDay() (Sunday=0), which is what the constant this mirrors used.
RECAP_WEEKDAY = 6
RECAP_HOUR = 18

# Matches trends_service.ADHERENCE_TOLERANCE / app.js's WEEK_ADHERENCE_TOLERANCE
# exactly — "on target" means the same ±10% everywhere in the app.
WEEK_ADHERENCE_TOLERANCE = 0.10


def parse_hhmm(value: str, default: time) -> time:
    """Parses a "HH:MM" string (notification_preferences.daily_reminder_time /
    quiet_hours_start/end — validated at the API boundary by
    models.py::HHMM_PATTERN, but re-validated defensively here too since this
    also reads straight back out of the DB) into a time object. Falls back to
    `default` on anything malformed rather than raising — one bad row should
    never take down the whole scheduler sweep for every other user."""
    try:
        hours, minutes = value.split(":")
        return time(int(hours), int(minutes))
    except (ValueError, AttributeError):
        return default


def in_quiet_hours(now: time, start: time, end: time) -> bool:
    """Whether `now` falls inside the [start, end) quiet-hours window. Handles
    the common case of a window that wraps past midnight (e.g. 22:00 ->
    08:00): when start > end, "inside" means now >= start OR now < end,
    rather than the impossible start <= now < end. start == end is treated as
    "quiet hours off" (a zero-width window would otherwise wrap to mean
    "always", which is never what a user setting equal start/end intends)."""
    if start == end:
        return False
    if start < end:
        return start <= now < end
    return now >= start or now < end


def should_send_daily_reminder(
    *,
    enabled: bool,
    mode: str,
    reminder_time: time,
    interval_hours: int,
    now: datetime,
    quiet_start: time,
    quiet_end: time,
    last_sent_at: datetime | None,
) -> bool:
    """Unconditional (no "already logged?" check) — matches the old
    frontend-only reminder's own behavior (frontend/js/reminders.js's
    maybeFireReminder never checked hasLoggedFoodToday either): this is the
    user's own explicitly-chosen check-in cadence, not a conditional smart
    nudge.

    Two modes (notification_preferences.reminder_mode):
      - "fixed": once a day, at `reminder_time` local, same as the original
        single-reminder design.
      - "interval": repeats every `interval_hours`, no fixed clock time —
        fires as soon as that much time has elapsed since the last send.

    `now` and `last_sent_at` must already share the same tzinfo/awareness —
    this function only ever compares them to each other, it never assumes a
    particular zone itself (services/notification_scheduler.py normalizes
    the stored UTC timestamp to the user's own local tz before calling
    this, so plain date/time comparisons below are safe)."""
    if not enabled:
        return False
    if in_quiet_hours(now.time(), quiet_start, quiet_end):
        return False

    if mode == "interval":
        if last_sent_at is None:
            return True
        return now - last_sent_at >= timedelta(hours=interval_hours)

    # "fixed" (the default, and the safe fallback for any unrecognized value)
    if now.time() < reminder_time:
        return False
    return last_sent_at is None or last_sent_at.date() != now.date()


def should_send_food_nudge(
    *,
    enabled: bool,
    now: datetime,
    quiet_start: time,
    quiet_end: time,
    already_sent_today: bool,
    has_logged_food_today: bool,
) -> bool:
    if not enabled or already_sent_today or has_logged_food_today:
        return False
    if not (FOOD_NUDGE_HOUR <= now.hour < NUDGE_WINDOW_END_HOUR):
        return False
    return not in_quiet_hours(now.time(), quiet_start, quiet_end)


def should_send_water_nudge(
    *,
    enabled: bool,
    now: datetime,
    quiet_start: time,
    quiet_end: time,
    already_sent_today: bool,
    water_ml: float,
    water_target_ml: float,
) -> bool:
    if not enabled or already_sent_today or water_ml >= water_target_ml:
        return False
    if not (WATER_NUDGE_HOUR <= now.hour < NUDGE_WINDOW_END_HOUR):
        return False
    return not in_quiet_hours(now.time(), quiet_start, quiet_end)


def should_send_discover_pick(
    *,
    enabled: bool,
    now: datetime,
    quiet_start: time,
    quiet_end: time,
    already_sent_today: bool,
    calories_remaining: float,
) -> bool:
    """The Discover "cook what fits tonight" nudge (kind "discover_pick").
    Conditional, like the food/water nudges (not an unconditional check-in
    like the daily reminder): it only makes sense when there's still a
    dinner-sized calorie budget to fill.

    Fires at most once per local day, inside
    [DISCOVER_PICK_HOUR, NUDGE_WINDOW_END_HOUR), outside quiet hours, when
    `calories_remaining` (target minus everything logged today) is at least
    DISCOVER_PICK_MIN_REMAINING_CALORIES. `enabled` is the caller's
    smart-nudges master toggle — this nudge has no toggle of its own."""
    if not enabled or already_sent_today:
        return False
    if not (DISCOVER_PICK_HOUR <= now.hour < NUDGE_WINDOW_END_HOUR):
        return False
    if calories_remaining < DISCOVER_PICK_MIN_REMAINING_CALORIES:
        return False
    return not in_quiet_hours(now.time(), quiet_start, quiet_end)


def should_send_weekly_recap(
    *, enabled: bool, now: datetime, quiet_start: time, quiet_end: time, already_sent_today: bool
) -> bool:
    if not enabled or already_sent_today:
        return False
    if now.weekday() != RECAP_WEEKDAY or now.hour < RECAP_HOUR:
        return False
    return not in_quiet_hours(now.time(), quiet_start, quiet_end)


def compute_week_adherence(log_rows: list[dict], target_calories: float) -> tuple[int, int]:
    """(adherent_days, logged_days) over whatever window `log_rows` spans —
    a direct Python port of frontend/js/app.js's computeWeekAdherence, kept
    logically identical (same grouping-by-log_date, same ±10% tolerance) so
    the server-pushed weekly recap text always matches what the in-app
    Progress tab would show for the same data. Named "week" for the same
    reason app.js's version is: in practice it's always called with the full
    retention-window log set (7 days by default), not a literal calendar
    week."""
    if not target_calories:
        return 0, 0
    calories_by_date: dict[str, float] = {}
    for row in log_rows:
        calories_by_date[row["log_date"]] = calories_by_date.get(row["log_date"], 0.0) + row["calories"]
    adherent_days = sum(
        1
        for calories in calories_by_date.values()
        if abs(calories - target_calories) <= target_calories * WEEK_ADHERENCE_TOLERANCE
    )
    return adherent_days, len(calories_by_date)
