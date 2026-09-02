import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from config import get_settings
from database import get_supabase

logger = logging.getLogger("cleanup_service")


def delete_old_logs() -> None:
    """Deletes daily_logs / water_logs rows older than settings.retention_days,
    plus stale ai_feature_usage / ai_feature_usage_monthly rows (see below).

    This mirrors the SQL `cleanup_old_logs()` function in sql/schema.sql.
    You only need ONE of the two running (either Supabase's pg_cron job, or
    this APScheduler job) — both are provided so the app works out of the box
    even if pg_cron isn't enabled on your Supabase plan.

    weight_logs is deliberately never touched here — see its table comment
    in sql/schema.sql for why it's kept indefinitely instead of purged.
    """
    retention_days = get_settings().retention_days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    supabase = get_supabase()

    logs_result = supabase.table("daily_logs").delete().lt("logged_at", cutoff).execute()
    water_result = supabase.table("water_logs").delete().lt("logged_at", cutoff).execute()

    logger.info(
        "Retention cleanup complete: removed %d daily_logs, %d water_logs older than %s",
        len(logs_result.data or []),
        len(water_result.data or []),
        cutoff,
    )

    # ai_feature_usage rows are only ever read for "today" (see
    # services/ai_usage_service.py) — a couple of days of slack, not just
    # "today", so this job can never race a still-in-use row even if it runs
    # right at a UTC-day boundary.
    usage_cutoff = (datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat()
    usage_result = supabase.table("ai_feature_usage").delete().lt("usage_date", usage_cutoff).execute()
    logger.info(
        "AI usage cleanup complete: removed %d ai_feature_usage rows older than %s",
        len(usage_result.data or []),
        usage_cutoff,
    )

    # ai_feature_usage_monthly rows are only ever read for "this calendar
    # month" — keeping current AND previous month (not just current), same
    # "don't race a still-in-use row right at the boundary" reasoning as the
    # 2-day slack above, just scaled to a month-sized bucket.
    today = datetime.now(timezone.utc).date()
    first_of_this_month = today.replace(day=1)
    first_of_last_month = (first_of_this_month - timedelta(days=1)).replace(day=1)
    monthly_result = (
        supabase.table("ai_feature_usage_monthly").delete().lt("usage_month", first_of_last_month.isoformat()).execute()
    )
    logger.info(
        "AI monthly usage cleanup complete: removed %d ai_feature_usage_monthly rows older than %s",
        len(monthly_result.data or []),
        first_of_last_month.isoformat(),
    )

    # Push subscriptions the push service has silently stopped accepting
    # without ever returning the 404/410 that triggers the inline self-clean
    # in push_service.py (some services just blackhole a dead endpoint).
    # last_seen_at is refreshed on every successful send AND every app-open
    # resubscribe, so a 90-day-cold row is a device that's genuinely gone —
    # pruning it stops that stale endpoint ever firing a duplicate alongside
    # the same device's current row. Mirrors sql/schema.sql's
    # cleanup_old_logs() (kept in sync by hand — nothing ties them together).
    subs_cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
    subs_result = supabase.table("push_subscriptions").delete().lt("last_seen_at", subs_cutoff).execute()
    logger.info(
        "Push subscription cleanup complete: removed %d rows not seen since %s",
        len(subs_result.data or []),
        subs_cutoff,
    )

    # daily_calorie_summary is a longitudinal aggregate (Damage Control
    # sparkline + Phase 2 recap baselines), kept far longer than the 7-day raw
    # window above — pruned at settings.summary_retention_days (90). Mirrors
    # the identical delete in sql/schema.sql's cleanup_old_logs() (kept in
    # sync by hand). Runs last and is guarded: a project that hasn't applied
    # the latest schema yet has no such table, and that must not abort the
    # rest of the sweep.
    summary_cutoff = (
        datetime.now(timezone.utc).date() - timedelta(days=get_settings().summary_retention_days)
    ).isoformat()
    try:
        summary_result = supabase.table("daily_calorie_summary").delete().lt("date", summary_cutoff).execute()
        logger.info(
            "Calorie-summary cleanup complete: removed %d daily_calorie_summary rows older than %s",
            len(summary_result.data or []),
            summary_cutoff,
        )
    except Exception:  # noqa: BLE001 — best-effort prune, never abort the rest of the sweep
        logger.warning("Skipped daily_calorie_summary prune (table not present yet?)", exc_info=True)


def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    # Runs once a day at 03:00 UTC — low-traffic window.
    scheduler.add_job(delete_old_logs, "cron", hour=3, minute=0, id="daily_log_cleanup")
    scheduler.start()
    logger.info("Started daily retention-cleanup scheduler (03:00 UTC)")
    return scheduler
