from datetime import datetime, time, timedelta

from services.notification_service import (
    DISCOVER_PICK_MIN_REMAINING_CALORIES,
    compute_week_adherence,
    in_quiet_hours,
    parse_hhmm,
    should_send_daily_reminder,
    should_send_discover_pick,
    should_send_food_nudge,
    should_send_water_nudge,
    should_send_weekly_recap,
)

# A Wednesday, deliberately not the recap's own Sunday — weekly-recap tests
# override this with a real Sunday instant instead.
WEDNESDAY_EVENING = datetime(2026, 7, 22, 20, 0)  # 20:00 local
SUNDAY_EVENING = datetime(2026, 7, 26, 19, 0)  # 19:00 local, a real Sunday


def test_parse_hhmm_valid():
    assert parse_hhmm("19:30", time(0, 0)) == time(19, 30)


def test_parse_hhmm_falls_back_on_malformed_input():
    assert parse_hhmm("not-a-time", time(9, 15)) == time(9, 15)
    assert parse_hhmm(None, time(9, 15)) == time(9, 15)


def test_in_quiet_hours_normal_window():
    start, end = time(9, 0), time(17, 0)
    assert in_quiet_hours(time(12, 0), start, end) is True
    assert in_quiet_hours(time(8, 59), start, end) is False
    assert in_quiet_hours(time(17, 0), start, end) is False  # end is exclusive


def test_in_quiet_hours_wraps_midnight():
    start, end = time(22, 0), time(8, 0)
    assert in_quiet_hours(time(23, 30), start, end) is True
    assert in_quiet_hours(time(3, 0), start, end) is True
    assert in_quiet_hours(time(12, 0), start, end) is False


def test_in_quiet_hours_equal_bounds_means_never():
    assert in_quiet_hours(time(22, 0), time(22, 0), time(22, 0)) is False


def _daily_reminder(**overrides):
    args = dict(
        enabled=True,
        mode="fixed",
        reminder_time=time(19, 0),
        interval_hours=4,
        now=WEDNESDAY_EVENING,
        quiet_start=time(22, 0),
        quiet_end=time(8, 0),
        last_sent_at=None,
    )
    args.update(overrides)
    return should_send_daily_reminder(**args)


def test_daily_reminder_fixed_fires_once_past_its_time():
    assert _daily_reminder() is True


def test_daily_reminder_fixed_does_not_fire_twice_same_day():
    assert _daily_reminder(last_sent_at=WEDNESDAY_EVENING.replace(hour=19, minute=1)) is False


def test_daily_reminder_fixed_fires_again_a_new_day_after_the_reminder_time():
    yesterday_send = WEDNESDAY_EVENING.replace(hour=19, minute=1) - timedelta(days=1)
    assert _daily_reminder(last_sent_at=yesterday_send) is True


def test_daily_reminder_fixed_waits_for_its_own_time():
    assert _daily_reminder(now=WEDNESDAY_EVENING.replace(hour=10)) is False


def test_daily_reminder_suppressed_during_quiet_hours():
    # Reminder time itself sits inside the quiet-hours window here.
    assert _daily_reminder(now=WEDNESDAY_EVENING.replace(hour=22, minute=30)) is False


def test_daily_reminder_interval_fires_immediately_if_never_sent():
    assert _daily_reminder(mode="interval", interval_hours=4, last_sent_at=None) is True


def test_daily_reminder_interval_waits_out_the_full_interval():
    just_under = WEDNESDAY_EVENING - timedelta(hours=3, minutes=59)
    assert _daily_reminder(mode="interval", interval_hours=4, last_sent_at=just_under) is False


def test_daily_reminder_interval_fires_once_elapsed():
    exactly_elapsed = WEDNESDAY_EVENING - timedelta(hours=4)
    assert _daily_reminder(mode="interval", interval_hours=4, last_sent_at=exactly_elapsed) is True


def test_daily_reminder_interval_suppressed_during_quiet_hours_even_if_elapsed():
    long_ago = WEDNESDAY_EVENING - timedelta(hours=10)
    assert _daily_reminder(mode="interval", interval_hours=4, now=WEDNESDAY_EVENING.replace(hour=23), last_sent_at=long_ago) is False


def test_daily_reminder_disabled_never_fires_regardless_of_mode():
    assert _daily_reminder(enabled=False) is False
    assert _daily_reminder(enabled=False, mode="interval", last_sent_at=None) is False


def test_food_nudge_skips_if_already_logged():
    assert (
        should_send_food_nudge(
            enabled=True,
            now=WEDNESDAY_EVENING,
            quiet_start=time(22, 0),
            quiet_end=time(8, 0),
            already_sent_today=False,
            has_logged_food_today=True,
        )
        is False
    )


def test_food_nudge_fires_within_window_when_nothing_logged():
    assert (
        should_send_food_nudge(
            enabled=True,
            now=WEDNESDAY_EVENING,
            quiet_start=time(22, 0),
            quiet_end=time(8, 0),
            already_sent_today=False,
            has_logged_food_today=False,
        )
        is True
    )


def test_food_nudge_outside_window_never_fires():
    morning = WEDNESDAY_EVENING.replace(hour=9)
    assert (
        should_send_food_nudge(
            enabled=True, now=morning, quiet_start=time(22, 0), quiet_end=time(8, 0), already_sent_today=False, has_logged_food_today=False
        )
        is False
    )


def test_water_nudge_skips_once_target_reached():
    assert (
        should_send_water_nudge(
            enabled=True,
            now=WEDNESDAY_EVENING,
            quiet_start=time(22, 0),
            quiet_end=time(8, 0),
            already_sent_today=False,
            water_ml=3000,
            water_target_ml=3000,
        )
        is False
    )


def test_water_nudge_fires_when_behind_target():
    assert (
        should_send_water_nudge(
            enabled=True,
            now=WEDNESDAY_EVENING,
            quiet_start=time(22, 0),
            quiet_end=time(8, 0),
            already_sent_today=False,
            water_ml=500,
            water_target_ml=3000,
        )
        is True
    )


def _discover_pick(**overrides):
    args = dict(
        enabled=True,
        now=WEDNESDAY_EVENING,  # 20:00, inside [17, 22) and clear of quiet hours
        quiet_start=time(22, 0),
        quiet_end=time(8, 0),
        already_sent_today=False,
        calories_remaining=DISCOVER_PICK_MIN_REMAINING_CALORIES + 200,
    )
    args.update(overrides)
    return should_send_discover_pick(**args)


def test_discover_pick_fires_in_the_evening_window_with_budget_left():
    assert _discover_pick() is True


def test_discover_pick_skips_when_barely_any_calories_left():
    assert _discover_pick(calories_remaining=DISCOVER_PICK_MIN_REMAINING_CALORIES - 1) is False


def test_discover_pick_only_once_per_day():
    assert _discover_pick(already_sent_today=True) is False


def test_discover_pick_outside_evening_window_never_fires():
    assert _discover_pick(now=WEDNESDAY_EVENING.replace(hour=13)) is False  # before DISCOVER_PICK_HOUR
    assert _discover_pick(now=WEDNESDAY_EVENING.replace(hour=22, minute=30)) is False  # past the cutoff


def test_discover_pick_respects_quiet_hours_and_master_toggle():
    assert _discover_pick(now=WEDNESDAY_EVENING.replace(hour=21), quiet_start=time(20, 0), quiet_end=time(8, 0)) is False
    assert _discover_pick(enabled=False) is False


def test_weekly_recap_only_fires_sunday_evening():
    assert (
        should_send_weekly_recap(
            enabled=True, now=SUNDAY_EVENING, quiet_start=time(22, 0), quiet_end=time(8, 0), already_sent_today=False
        )
        is True
    )
    assert (
        should_send_weekly_recap(
            enabled=True, now=WEDNESDAY_EVENING, quiet_start=time(22, 0), quiet_end=time(8, 0), already_sent_today=False
        )
        is False
    )


def test_weekly_recap_respects_disabled_and_already_sent():
    assert (
        should_send_weekly_recap(
            enabled=False, now=SUNDAY_EVENING, quiet_start=time(22, 0), quiet_end=time(8, 0), already_sent_today=False
        )
        is False
    )
    assert (
        should_send_weekly_recap(
            enabled=True, now=SUNDAY_EVENING, quiet_start=time(22, 0), quiet_end=time(8, 0), already_sent_today=True
        )
        is False
    )


def test_compute_week_adherence_matches_tolerance():
    logs = [
        {"log_date": "2026-07-20", "calories": 2050},  # within ±10% of 2000
        {"log_date": "2026-07-21", "calories": 2050},
        {"log_date": "2026-07-22", "calories": 3000},  # way over
    ]
    adherent_days, logged_days = compute_week_adherence(logs, target_calories=2000)
    assert logged_days == 3
    assert adherent_days == 2


def test_compute_week_adherence_no_target_is_zero():
    assert compute_week_adherence([{"log_date": "2026-07-20", "calories": 500}], target_calories=0) == (0, 0)


def test_compute_week_adherence_sums_multiple_entries_same_day():
    logs = [
        {"log_date": "2026-07-20", "calories": 1000},
        {"log_date": "2026-07-20", "calories": 1000},  # same day, two logs -> 2000 total
    ]
    adherent_days, logged_days = compute_week_adherence(logs, target_calories=2000)
    assert logged_days == 1
    assert adherent_days == 1
