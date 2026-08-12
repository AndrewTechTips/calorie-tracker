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


def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    # Runs once a day at 03:00 UTC — low-traffic window.
    scheduler.add_job(delete_old_logs, "cron", hour=3, minute=0, id="daily_log_cleanup")
    scheduler.start()
    logger.info("Started daily retention-cleanup scheduler (03:00 UTC)")
    return scheduler
