import logging
from datetime import datetime, time, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from config import get_settings
from database import get_supabase
from services import notification_service as ns
from services.daytime_service import local_now
from services.notification_copy import notification_text
from services.push_service import send_to_subscription

logger = logging.getLogger("notification_scheduler")

# How often the sweep runs. 5 minutes keeps both "HH:MM reminder time" and
# interval-mode precision tight (worst case ~5 min late, vs. the previous
# 10-minute sweep's ~10 min worst case — noticeably looser against a 1-hour
# interval setting) without hammering Supabase — at this app's real scale
# (15-20 users, see CLAUDE.md) a full sweep is a handful of small queries
# per user, negligible load either way.
CHECK_INTERVAL_MINUTES = 5

_DEFAULT_REMINDER_TIME = time(19, 0)
_DEFAULT_QUIET_START = time(22, 0)
_DEFAULT_QUIET_END = time(8, 0)
_DEFAULT_INTERVAL_HOURS = 4


def _send(user_id: str, language: str, kind: str, **format_args) -> bool:
    """Sends notification_copy's localized (title, body) for `kind` to every
    device this user has subscribed on. `kind` doubles as the push payload's
    `tag` (see frontend/sw.js's showNotification call) — same-kind
    notifications replace each other in the OS notification tray instead of
    stacking, so a user who was offline for a few interval cycles gets one
    fresh reminder on reconnect, not a pile of identical ones."""
    supabase = get_supabase()
    subscriptions = supabase.table("push_subscriptions").select("*").eq("user_id", user_id).execute().data or []
    if not subscriptions:
        return False
    title, body = notification_text(language, kind, **format_args)
    payload = {"title": title, "body": body, "url": "/", "tag": kind}
    return any(send_to_subscription(sub, payload) for sub in subscriptions)


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

    # --- Weekly recap ---------------------------------------------------------
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
    everyone.
    """
    settings = get_settings()
    if not settings.vapid_configured:
        return  # push not configured on this deploy — nothing to do

    supabase = get_supabase()
    prefs_rows = supabase.table("notification_preferences").select("*").eq("push_enabled", True).execute().data or []

    for prefs in prefs_rows:
        try:
            _process_user(supabase, prefs, settings.retention_days)
        except Exception:
            logger.exception("Notification sweep failed for user %s", prefs.get("user_id"))


def register_job(scheduler: AsyncIOScheduler) -> None:
    """Adds this sweep to the app's single shared APScheduler instance (see
    main.py's lifespan) — deliberately NOT a second scheduler: this backend
    runs with --workers 1 specifically so in-memory/single-process
    assumptions like this one hold (see backend/Dockerfile's own comment),
    and one AsyncIOScheduler per process is that same assumption applied to
    scheduled jobs."""
    scheduler.add_job(
        check_and_send_notifications,
        "interval",
        minutes=CHECK_INTERVAL_MINUTES,
        id="notification_sweep",
        # A sweep that's still running (or stuck) when the next tick fires
        # should never stack a second concurrent pass over the same users —
        # coalesce collapses any missed ticks into one, and max_instances=1
        # is the hard guarantee behind that.
        max_instances=1,
        coalesce=True,
    )
    logger.info("Started push-notification sweep (every %d minutes)", CHECK_INTERVAL_MINUTES)
