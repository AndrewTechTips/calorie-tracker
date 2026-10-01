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
# 2 minutes (down from 5) keeps both fixed-time and interval-mode reminders
# inside a 2-minute window of when the user asked for them. What makes that
# cadence affordable is that a tick normally costs only three batched reads,
# whatever the number of users — see "Keeping the sweep cheap" below.
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

# --- Keeping the sweep cheap (2026-10-01 log-ingestion audit) ---------------
#
# Every Supabase request leaves a log line that counts toward the project's
# Log Ingestion quota (1 GB/month on the free plan). Measured before this
# change: ~434 requests an hour, around the clock, ~82% of the project's
# entire traffic — with nobody using the app at all. It came from this sweep
# doing a fixed set of reads for every push-enabled user on every 2-minute
# tick: a profile, today's food, today's water, at 3am as much as at 3pm, and
# for users who had no device to send to (2 of the 3 push-enabled accounts at
# the time). The sweep now reads only what can still change a decision:
#
#   1. Users with no push_subscriptions row are skipped before anything else
#      is read. Nothing can reach them, so nothing about them matters.
#   2. Profiles are read in ONE query for every remaining user, not one each.
#   3. Each conditional nudge first asks its eligibility function the
#      most-permissive question — "could this fire even if the user had
#      logged nothing at all?" — and only queries daily_logs / water_logs
#      when the answer is yes. That is exact, not a heuristic: logging food
#      or water can only ever make a nudge LESS eligible, so if the
#      most-permissive answer is no, the real one is too. Outside the
#      afternoon/evening windows (and once a nudge is sent) this skips the
#      query entirely.
#   4. A query answer that settles a nudge for the rest of the day (food was
#      logged, the water target was met, too little budget left for dinner)
#      is remembered for that local day — see _SETTLED_TODAY.
#   5. A send that fails is retried after _SEND_RETRY_BACKOFF, not on the
#      very next tick — see _RETRY_AFTER.
#
# Both dicts below are in-memory, which is fine for the same reason the rest
# of this module is: one process (--workers 1). A restart just forgets them,
# costing at most one extra query or one earlier retry. They hold at most one
# entry per (user, notification kind), overwritten in place, so they cannot
# grow past users x kinds.

# (user_id, kind) -> the user's local date (ISO) on which that kind's
# condition was found settled. Settled means "cannot fire again today":
# deleting the only food log after it was counted would, in principle, make
# the food nudge eligible again — an accepted miss for a once-a-day nudge,
# in exchange for not re-reading the same rows every 2 minutes all evening.
_SETTLED_TODAY: dict[tuple[str, str], str] = {}

# (user_id, kind) -> UTC time before which a failed send is not retried.
# Without this a failure (all of a user's endpoints erroring, or the device
# row vanishing between the sweep's check and the send) was retried on every
# tick until the nudge window closed — one subscription read plus one call
# to the push service every 2 minutes, for hours.
_RETRY_AFTER: dict[tuple[str, str], datetime] = {}
_SEND_RETRY_BACKOFF = timedelta(minutes=30)


def _is_settled(user_id: str, kind: str, today_str: str) -> bool:
    return _SETTLED_TODAY.get((user_id, kind)) == today_str


def _settle(user_id: str, kind: str, today_str: str) -> None:
    _SETTLED_TODAY[(user_id, kind)] = today_str


def _backing_off(user_id: str, kind: str) -> bool:
    retry_after = _RETRY_AFTER.get((user_id, kind))
    return retry_after is not None and datetime.now(timezone.utc) < retry_after


def _send_and_track(user_id: str, language: str, kind: str, **format_args) -> bool:
    """_send, plus the retry bookkeeping: a failure arms the backoff for this
    (user, kind), a success clears it. Returns whether it was delivered."""
    if _send(user_id, language, kind, **format_args):
        _RETRY_AFTER.pop((user_id, kind), None)
        return True
    _RETRY_AFTER[(user_id, kind)] = datetime.now(timezone.utc) + _SEND_RETRY_BACKOFF
    logger.info("Push %s for user %s was not delivered; next attempt in %s", kind, user_id, _SEND_RETRY_BACKOFF)
    return False


def _reset_sweep_memory() -> None:
    """Tests only: forget settled nudges and retry backoffs."""
    _SETTLED_TODAY.clear()
    _RETRY_AFTER.clear()


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


def _process_user(supabase, prefs: dict, profile: dict, retention_days: int) -> None:
    """Runs every notification kind's eligibility check for one user.

    `profile` (timezone + targets) is read for every user at once by the
    caller. Each kind is wrapped in its own `_guard` (see above) rather than
    sharing one try/except for the whole user: the kinds are independent, so
    a Supabase hiccup on one kind's query must not withhold the others.

    Every conditional kind asks its eligibility function first with the
    most-permissive stand-in for the data it would otherwise query (see the
    module comment above "Keeping the sweep cheap"), and reads the database
    only if that could still fire.
    """
    user_id = prefs["user_id"]
    tz_name = profile.get("timezone") or "UTC"
    now = local_now(tz_name)
    today_str = now.date().isoformat()
    language = prefs.get("language") or "en"

    quiet_start = ns.parse_hhmm(prefs.get("quiet_hours_start"), _DEFAULT_QUIET_START)
    quiet_end = ns.parse_hhmm(prefs.get("quiet_hours_end"), _DEFAULT_QUIET_END)

    # --- Daily reminder (fixed time OR repeating interval — see
    # notification_service.should_send_daily_reminder's own docstring). No
    # query: everything it needs is already in `prefs`. ----------------------
    with _guard(user_id, "daily reminder"):
        if not _backing_off(user_id, "daily_reminder") and ns.should_send_daily_reminder(
            enabled=prefs.get("daily_reminder_enabled", True),
            mode=prefs.get("reminder_mode") or "fixed",
            reminder_time=ns.parse_hhmm(prefs.get("daily_reminder_time"), _DEFAULT_REMINDER_TIME),
            interval_hours=prefs.get("reminder_interval_hours") or _DEFAULT_INTERVAL_HOURS,
            now=now,
            quiet_start=quiet_start,
            quiet_end=quiet_end,
            last_sent_at=_parse_sent_at(prefs.get("last_daily_reminder_sent_at"), now.tzinfo),
        ):
            if _send_and_track(user_id, language, "daily_reminder"):
                _mark_sent(user_id, "last_daily_reminder_sent_at", datetime.now(timezone.utc).isoformat())

    # --- Smart nudges (food / water / Discover) — only considered if the
    # master smart-nudge toggle is on. ---------------------------------------
    if prefs.get("smart_nudges_enabled", True):
        with _guard(user_id, "food nudge"):
            food_args = dict(
                enabled=True,
                now=now,
                quiet_start=quiet_start,
                quiet_end=quiet_end,
                already_sent_today=prefs.get("last_food_nudge_sent") == today_str,
            )
            # Most permissive: "nothing logged yet". Only then is it worth
            # asking whether something has been.
            if (
                not _is_settled(user_id, "food_nudge", today_str)
                and not _backing_off(user_id, "food_nudge")
                and ns.should_send_food_nudge(**food_args, has_logged_food_today=False)
            ):
                has_logged_food_today = bool(
                    supabase.table("daily_logs").select("id").eq("user_id", user_id).eq("log_date", today_str).limit(1).execute().data
                )
                if has_logged_food_today:
                    _settle(user_id, "food_nudge", today_str)
                elif _send_and_track(user_id, language, "food_nudge"):
                    _mark_sent(user_id, "last_food_nudge_sent", today_str)

        with _guard(user_id, "water nudge"):
            water_target_ml = profile.get("daily_water_ml") or 3000
            water_args = dict(
                enabled=True,
                now=now,
                quiet_start=quiet_start,
                quiet_end=quiet_end,
                already_sent_today=prefs.get("last_water_nudge_sent") == today_str,
                water_target_ml=water_target_ml,
            )
            # Most permissive: no water logged yet (amounts are never negative).
            if (
                not _is_settled(user_id, "water_nudge", today_str)
                and not _backing_off(user_id, "water_nudge")
                and ns.should_send_water_nudge(**water_args, water_ml=0.0)
            ):
                water_rows = (
                    supabase.table("water_logs").select("amount_ml").eq("user_id", user_id).eq("log_date", today_str).execute().data
                    or []
                )
                water_ml = sum(row["amount_ml"] for row in water_rows)
                if ns.should_send_water_nudge(**water_args, water_ml=water_ml):
                    if _send_and_track(user_id, language, "water_nudge"):
                        _mark_sent(user_id, "last_water_nudge_sent", today_str)
                elif water_ml >= water_target_ml:
                    _settle(user_id, "water_nudge", today_str)

        # --- Discover "cook what fits tonight" nudge (Phase 2) --------------
        # Gated on the marker column existing: select("*") simply omits
        # last_discover_pick_sent on a project that hasn't run the
        # sql/schema.sql migration yet, so `in prefs` is a zero-cost feature
        # flag that flips on by itself once it has — and never sends a kind
        # it can't record having sent.
        if "last_discover_pick_sent" in prefs:
            with _guard(user_id, "discover pick"):
                target_calories = profile.get("daily_calories") or 0
                pick_args = dict(
                    enabled=True,
                    now=now,
                    quiet_start=quiet_start,
                    quiet_end=quiet_end,
                    already_sent_today=prefs.get("last_discover_pick_sent") == today_str,
                )
                # Most permissive: nothing eaten yet, so the whole target is
                # still "remaining".
                if (
                    not _is_settled(user_id, "discover_pick", today_str)
                    and not _backing_off(user_id, "discover_pick")
                    and ns.should_send_discover_pick(**pick_args, calories_remaining=target_calories)
                ):
                    calorie_rows = (
                        supabase.table("daily_logs")
                        .select("calories")
                        .eq("user_id", user_id)
                        .eq("log_date", today_str)
                        .execute()
                        .data
                        or []
                    )
                    calories_remaining = target_calories - sum(row["calories"] for row in calorie_rows)
                    if ns.should_send_discover_pick(**pick_args, calories_remaining=calories_remaining):
                        if _send_and_track(user_id, language, "discover_pick"):
                            _mark_sent(user_id, "last_discover_pick_sent", today_str)
                    elif calories_remaining < ns.DISCOVER_PICK_MIN_REMAINING_CALORIES:
                        _settle(user_id, "discover_pick", today_str)

    # --- Weekly recap — its eligibility needs no data, so the week's logs are
    # only read once it is actually going out. ---------------------------------
    with _guard(user_id, "weekly recap"):
        if not _backing_off(user_id, "weekly_recap") and ns.should_send_weekly_recap(
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
            # Backoff is keyed "weekly_recap" whichever variant was chosen,
            # since it is one notification as far as the user is concerned.
            if _send(user_id, language, kind, adherent=adherent_days, logged=logged_days):
                _RETRY_AFTER.pop((user_id, "weekly_recap"), None)
                _mark_sent(user_id, "last_weekly_recap_sent", today_str)
            else:
                _RETRY_AFTER[(user_id, "weekly_recap")] = datetime.now(timezone.utc) + _SEND_RETRY_BACKOFF


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

    if not prefs_rows:
        return

    # Two batched reads instead of one profile read per user per tick (see
    # "Keeping the sweep cheap" above). A failure here skips this tick for
    # everyone, exactly like the preferences read: the sweep is idempotent and
    # the next tick is 2 minutes away.
    try:
        user_ids = [prefs["user_id"] for prefs in prefs_rows]
        reachable = {
            row["user_id"]
            for row in (
                supabase.table("push_subscriptions").select("user_id").in_("user_id", user_ids).execute().data or []
            )
        }
        # Push is on in settings but no device is registered (the browser
        # dropped the subscription, or every endpoint was pruned as dead):
        # nothing can reach these users, so nothing about them is read.
        prefs_rows = [prefs for prefs in prefs_rows if prefs["user_id"] in reachable]
        if not prefs_rows:
            return
        profiles_by_id = {
            row["id"]: row
            for row in (
                supabase.table("profiles")
                .select("id,timezone,daily_calories,daily_water_ml")
                .in_("id", [prefs["user_id"] for prefs in prefs_rows])
                .execute()
                .data
                or []
            )
        }
    except Exception as exc:
        if is_transient_db_error(exc):
            logger.warning("Notification sweep skipped — could not load devices/profiles: %s", describe_db_error(exc))
        else:
            logger.exception("Notification sweep skipped — could not load devices/profiles")
        return

    for prefs in prefs_rows:
        try:
            _process_user(supabase, prefs, profiles_by_id.get(prefs["user_id"], {}), settings.retention_days)
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
