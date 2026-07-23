import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from config import get_settings
from database import get_supabase

logger = logging.getLogger("cleanup_service")


def delete_old_logs() -> None:
    """Deletes daily_logs / water_logs rows older than settings.retention_days.

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


def start_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    # Runs once a day at 03:00 UTC — low-traffic window.
    scheduler.add_job(delete_old_logs, "cron", hour=3, minute=0, id="daily_log_cleanup")
    scheduler.start()
    logger.info("Started daily retention-cleanup scheduler (03:00 UTC)")
    return scheduler
