import logging
from contextlib import contextmanager
from datetime import datetime, time, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from config import get_settings
from database import get_supabase
from services import notification_service as ns
from services.daytime_service import local_now
from services.db_tolerance import describe_db_error, is_transient_db_error, sweep_guard
from services.notification_copy import notification_text
from services.push_service import send_to_user

logger = logging.getLogger("notification_scheduler")

# How often the sweep runs, as minutes past the hour. MUST stay an exact
# divisor of 60: the sweep is scheduled on a WALL-CLOCK cron trigger
# (":00, :02, :04, …" — see register_job), so a non-divisor would leave an
# uneven gap straddling the top of the hour.
#
# Why cron and not APScheduler's "interval" trigger: "interval" anchors its
# very first fire to the moment the process started, then repeats from
# there — so every redeploy silently reshuffles the sweep's phase, and an
# "HH:MM" reminder ends up landing a different, arbitrary 0–N minutes past
# the hour after each deploy (the single biggest reason the timing "feels
# off" — it's not just late, it's inconsistently late). A cron trigger has
# no process-start anchor: worst-case lateness for a fixed-time reminder is
# a predictable, deploy-independent "< CHECK_INTERVAL_MINUTES".
#
# 2 minutes (down from 5) is still only a handful of small per-user queries
# per sweep at this app's real scale (15-20 users, see CLAUDE.md) and keeps
# both fixed-time and interval-mode reminders inside a 2-minute window of
# when the user asked for them.
CHECK_INTERVAL_MINUTES = 2

_DEFAULT_REMINDER_TIME = time(19, 0)
_DEFAULT_QUIET_START = time(22, 0)
_DEFAULT_QUIET_END = time(8, 0)
_DEFAULT_INTERVAL_HOURS = 4

# Deep-link target per notification kind — tapping the notification should
# land the user on the relevant screen, not a bare dashboard. Value is
# resolved against the PWA's own scope by frontend/sw.js's notificationclick
# handler (so it's correct for both a root and a project-subpath GH Pages
# deploy), and read as a `?view=` query param by app.js on boot. Any kind not
# listed falls through to "/" (the dashboard) — unchanged behaviour.
_DEEP_LINK_BY_KIND = {
    "weekly_recap_with_logs": "?view=weekly_recap",
    "weekly_recap_no_logs": "?view=weekly_recap",
}


# Transient-vs-real error classification is shared with pet_scheduler (and
# any future sweep) — see services/db_tolerance.py for the failure it was
# written against and why the two are logged differently.


def _guard(user_id: str, what: str):
    """One notification kind's queries + send, isolated.

    Per KIND rather than per user: the kinds are independent, so a 504 on the
    water_logs query is no reason to also withhold this user's food nudge or
    tonight's weekly recap. Skipping one kind costs at most
    CHECK_INTERVAL_MINUTES of lateness, since the next sweep re-evaluates it
    from scratch."""
    return sweep_guard(logger, what, user_id)


def _send(user_id: str, language: str, kind: str, **format_args) -> bool:
    """Sends notification_copy's localized (title, body) for `kind` once per
    device this user has subscribed on. Delegates the fan-out to
    push_service.send_to_user — the single path that de-duplicates a user's
    subscription rows to one target per device (guarding against a duplicate
    push when the table briefly holds a rotation orphan). `kind` doubles as
    the push payload's `tag` (see frontend/sw.js's showNotification call) —
    same-kind notifications replace each other in the OS notification tray
    instead of stacking, so a user who was offline for a few interval cycles
    gets one fresh reminder on reconnect, not a pile of identical ones."""
    title, body = notification_text(language, kind, **format_args)
    payload = {"title": title, "body": body, "url": _DEEP_LINK_BY_KIND.get(kind, "/"), "tag": kind}
    return send_to_user(user_id, payload) > 0


def _mark_sent(user_id: str, column: str, value: str) -> None:
    get_supabase().table("notification_preferences").update({column: value}).eq("user_id", user_id).execute()


def _parse_sent_at(value: str | None, local_tz) -> datetime | None:
    """Parses notification_preferences.last_daily_reminder_sent_at (a
    Supabase timestamptz, back as an ISO string) into a datetime in the
    SAME tzinfo as `now` — should_send_daily_reminder requires its `now`/
    `last_sent_at` pair to already share awareness (see that function's own
    docstring), so the conversion happens here, once, rather than inside
    the pure function itself."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(local_tz)
    except ValueError:
        return None


def _process_user(supabase, prefs: dict, retention_days: int) -> None:
    """Runs every notification kind's eligibility check for one user.

    Each kind is wrapped in its own `_guard` (see above) rather than sharing
    one try/except for the whole user: the kinds are independent, so a
    Supabase hiccup on one kind's query must not withhold the others. The
    profile read below is the one exception — timezone drives every check
    under it, so there is nothing sensible to do without it and the failure
    is left to the caller's per-user handler.
    """
    user_id = prefs["user_id"]
    profile_result = (
        supabase.table("profiles")
        .select("timezone,daily_calories,daily_water_ml")
        .eq("id", user_id)
        .maybe_single()
        .execute()
    )
    profile = (profile_result.data if profile_result else None) or {}
    tz_name = profile.get("timezone") or "UTC"
    now = local_now(tz_name)
    today_str = now.date().isoformat()
    language = prefs.get("language") or "en"

    quiet_start = ns.parse_hhmm(prefs.get("quiet_hours_start"), _DEFAULT_QUIET_START)
    quiet_end = ns.parse_hhmm(prefs.get("quiet_hours_end"), _DEFAULT_QUIET_END)

    # --- Daily reminder (fixed time OR repeating interval — see
    # notification_service.should_send_daily_reminder's own docstring) ------
    with _guard(user_id, "daily reminder"):
        if ns.should_send_daily_reminder(
            enabled=prefs.get("daily_reminder_enabled", True),
            mode=prefs.get("reminder_mode") or "fixed",
            reminder_time=ns.parse_hhmm(prefs.get("daily_reminder_time"), _DEFAULT_REMINDER_TIME),
            interval_hours=prefs.get("reminder_interval_hours") or _DEFAULT_INTERVAL_HOURS,
            now=now,
            quiet_start=quiet_start,
            quiet_end=quiet_end,
            last_sent_at=_parse_sent_at(prefs.get("last_daily_reminder_sent_at"), now.tzinfo),
        ):
            if _send(user_id, language, "daily_reminder"):
                _mark_sent(user_id, "last_daily_reminder_sent_at", datetime.now(timezone.utc).isoformat())

    # --- Smart nudges (food / water) — only queried for if the master smart-
    # nudge toggle is on, so a user with it off costs this sweep zero extra
    # daily_logs/water_logs queries. -----------------------------------------
    if prefs.get("smart_nudges_enabled", True):
        with _guard(user_id, "food nudge"):
            has_logged_food_today = bool(
                supabase.table("daily_logs").select("id").eq("user_id", user_id).eq("log_date", today_str).limit(1).execute().data
            )
            if ns.should_send_food_nudge(
                enabled=True,
                now=now,
                quiet_start=quiet_start,
                quiet_end=quiet_end,
                already_sent_today=prefs.get("last_food_nudge_sent") == today_str,
                has_logged_food_today=has_logged_food_today,
            ):
                if _send(user_id, language, "food_nudge"):
                    _mark_sent(user_id, "last_food_nudge_sent", today_str)

        with _guard(user_id, "water nudge"):
            water_rows = (
                supabase.table("water_logs").select("amount_ml").eq("user_id", user_id).eq("log_date", today_str).execute().data
                or []
            )
            water_ml = sum(row["amount_ml"] for row in water_rows)
            water_target_ml = profile.get("daily_water_ml") or 3000
            if ns.should_send_water_nudge(
                enabled=True,
                now=now,
                quiet_start=quiet_start,
                quiet_end=quiet_end,
                already_sent_today=prefs.get("last_water_nudge_sent") == today_str,
                water_ml=water_ml,
                water_target_ml=water_target_ml,
            ):
                if _send(user_id, language, "water_nudge"):
                    _mark_sent(user_id, "last_water_nudge_sent", today_str)

        # --- Discover "cook what fits tonight" nudge (Phase 2) --------------
        # Gated on the marker column existing: select("*") above simply omits
        # last_discover_pick_sent on a project that hasn't run the
        # sql/schema.sql migration yet, so `in prefs` is a zero-cost feature
        # flag that flips on by itself once it has — and never sends a kind
        # it can't record having sent. The hour pre-check keeps the extra
        # today's-calories query off every other sweep.
        if "last_discover_pick_sent" in prefs and ns.DISCOVER_PICK_HOUR <= now.hour < ns.NUDGE_WINDOW_END_HOUR:
            with _guard(user_id, "discover pick"):
                target_calories = profile.get("daily_calories") or 0
                calorie_rows = (
                    supabase.table("daily_logs")
                    .select("calories")
                    .eq("user_id", user_id)
                    .eq("log_date", today_str)
                    .execute()
                    .data
                    or []
                )
                calories_today = sum(row["calories"] for row in calorie_rows)
                if ns.should_send_discover_pick(
                    enabled=True,
                    now=now,
                    quiet_start=quiet_start,
                    quiet_end=quiet_end,
                    already_sent_today=prefs.get("last_discover_pick_sent") == today_str,
                    calories_remaining=target_calories - calories_today,
                ):
                    if _send(user_id, language, "discover_pick"):
                        _mark_sent(user_id, "last_discover_pick_sent", today_str)

    # --- Weekly recap ---------------------------------------------------------
    with _guard(user_id, "weekly recap"):
        if ns.should_send_weekly_recap(
            enabled=prefs.get("weekly_recap_enabled", True),
            now=now,
            quiet_start=quiet_start,
            quiet_end=quiet_end,
            already_sent_today=prefs.get("last_weekly_recap_sent") == today_str,
        ):
            target_calories = profile.get("daily_calories") or 0
            first_day = (now.date() - timedelta(days=retention_days - 1)).isoformat()
            log_rows = (
                supabase.table("daily_logs")
                .select("calories,log_date")
                .eq("user_id", user_id)
                .gte("log_date", first_day)
                .execute()
                .data
                or []
            )
            adherent_days, logged_days = ns.compute_week_adherence(log_rows, target_calories)
            kind = "weekly_recap_with_logs" if logged_days > 0 else "weekly_recap_no_logs"
            sent = _send(user_id, language, kind, adherent=adherent_days, logged=logged_days)
            if sent:
                _mark_sent(user_id, "last_weekly_recap_sent", today_str)


def check_and_send_notifications() -> None:
    """The single sweep the APScheduler job below calls every
    CHECK_INTERVAL_MINUTES. Plain sync function (not async) — same shape as
    cleanup_service.delete_old_logs, which AsyncIOScheduler already runs on
    its default thread-pool executor, so this doesn't block the event loop
    despite using the sync supabase-py client throughout.

    One iteration per user with push_enabled=true; a failure for one user
    (bad timezone data, a transient Supabase hiccup) is caught and logged,
    never allowed to abort the sweep for everyone else — the whole point of
    a background job like this is that nobody is watching it fail in real
    time, so one user's bad row must not silently stop reminders for
    everyone. Nothing raised out of this function: APScheduler would only
    log it and the next tick would run anyway, so an escaping exception buys
    nothing and costs a stack trace that reads like a dead scheduler.
    """
    settings = get_settings()
    if not settings.vapid_configured:
        return  # push not configured on this deploy — nothing to do

    supabase = get_supabase()
    try:
        prefs_rows = supabase.table("notification_preferences").select("*").eq("push_enabled", True).execute().data or []
    except Exception as exc:
        # The one query with no per-user fallback, and the one place a
        # Supabase blip genuinely did take reminders down for EVERYONE: a
        # 504 here used to propagate straight out of the sweep (as an
        # APIError, or as the raw pydantic ValidationError described above),
        # so nobody got notified for that tick. There is nothing to iterate
        # without these rows, so skip this sweep entirely; the next cron
        # tick retries CHECK_INTERVAL_MINUTES later, which for a reminder
        # window measured in hours is not a miss.
        if is_transient_db_error(exc):
            logger.warning("Notification sweep skipped — could not load preferences: %s", describe_db_error(exc))
        else:
            logger.exception("Notification sweep skipped — could not load preferences")
        return

    for prefs in prefs_rows:
        try:
            _process_user(supabase, prefs, settings.retention_days)
        except Exception as exc:
            if is_transient_db_error(exc):
                logger.warning("Skipping user %s this sweep: %s", prefs.get("user_id"), describe_db_error(exc))
            else:
                logger.exception("Notification sweep failed for user %s", prefs.get("user_id"))
            continue


def register_job(scheduler: AsyncIOScheduler) -> None:
    """Adds this sweep to the app's single shared APScheduler instance (see
    main.py's lifespan) — deliberately NOT a second scheduler: this backend
    runs with --workers 1 specifically so in-memory/single-process
    assumptions like this one hold (see backend/Dockerfile's own comment),
    and one AsyncIOScheduler per process is that same assumption applied to
    scheduled jobs.

    Cron (wall-clock aligned to ":00, :02, :04, …") rather than "interval" —
    see CHECK_INTERVAL_MINUTES's comment for why the process-start anchor
    that "interval" carries is what made reminder timing feel arbitrary.
    The scheduler itself runs in UTC; the eligibility checks all convert to
    each user's own local time, so the sweep cadence's zone is irrelevant.

    max_instances=1 — a sweep still running when the next tick fires must
    never stack a second concurrent pass over the same users. coalesce=True
    + misfire_grace_time (a full interval, vs. APScheduler's 1-second
    default) means: a tick the busy event loop delivers a few seconds late
    still runs instead of being dropped, and after real downtime the backend
    runs exactly ONE catch-up sweep on restart — enough for an interval-mode
    reminder that came due while it was down to fire promptly — rather than
    replaying every tick it missed.
    """
    scheduler.add_job(
        check_and_send_notifications,
        CronTrigger(minute=f"*/{CHECK_INTERVAL_MINUTES}", timezone="UTC"),
        id="notification_sweep",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=CHECK_INTERVAL_MINUTES * 60,
    )
    logger.info("Started push-notification sweep (cron, every %d minutes)", CHECK_INTERVAL_MINUTES)
