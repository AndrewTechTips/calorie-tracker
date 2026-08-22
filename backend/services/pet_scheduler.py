import logging
from datetime import date, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from config import get_settings
from database import get_supabase
from services import pet_service
from services.daytime_service import local_today

logger = logging.getLogger("pet_scheduler")

# Coarser than notification_scheduler's 5-minute sweep on purpose — this only
# needs to catch "a user's local midnight has passed," not hit a precise
# reminder time, so 30 minutes is plenty responsive without adding load.
CHECK_INTERVAL_MINUTES = 30


def _day_totals(supabase, user_id: str, day: date) -> tuple[bool, float, float]:
    day_str = day.isoformat()
    logs = (
        supabase.table("daily_logs")
        .select("calories")
        .eq("user_id", user_id)
        .eq("log_date", day_str)
        .execute()
        .data
        or []
    )
    water_rows = (
        supabase.table("water_logs")
        .select("amount_ml")
        .eq("user_id", user_id)
        .eq("log_date", day_str)
        .execute()
        .data
        or []
    )
    calories = sum(row["calories"] for row in logs)
    water_ml = sum(row["amount_ml"] for row in water_rows)
    return bool(logs), calories, water_ml


def _process_user(supabase, profile: dict, retention_days: int) -> None:
    user_id = profile["id"]
    tz_name = profile.get("timezone") or "UTC"
    target_calories = profile.get("daily_calories") or 0
    target_water_ml = profile.get("daily_water_ml") or 3000
    today_local = local_today(tz_name)

    pet_result = supabase.table("pet_state").select("*").eq("user_id", user_id).maybe_single().execute()
    pet = (pet_result.data if pet_result else None) or {}
    if not pet:
        pet = {"hearts": pet_service.MAX_HEARTS, "last_evaluated_date": None}
        supabase.table("pet_state").upsert(
            {"user_id": user_id, "hearts": pet["hearts"], "last_evaluated_date": None}, on_conflict="user_id"
        ).execute()

    last_evaluated = pet.get("last_evaluated_date")
    if not last_evaluated:
        # First time this user's pet has been seen by the sweep — nothing to
        # retroactively judge, so just mark yesterday as the starting point.
        supabase.table("pet_state").update(
            {"last_evaluated_date": (today_local - timedelta(days=1)).isoformat()}
        ).eq("user_id", user_id).execute()
        return

    last_evaluated_date = date.fromisoformat(last_evaluated)
    hearts = pet["hearts"]
    # Bounded to retention_days: judging further back than the retained
    # window is meaningless (the logs no longer exist), and this keeps a
    # long-offline server from looping unboundedly on first catch-up.
    iterations = 0
    while last_evaluated_date < today_local - timedelta(days=1) and iterations < retention_days:
        next_day = last_evaluated_date + timedelta(days=1)
        has_food_logs, calories, water_ml = _day_totals(supabase, user_id, next_day)
        good_day = pet_service.evaluate_day(
            has_food_logs=has_food_logs,
            calories=calories,
            target_calories=target_calories,
            water_ml=water_ml,
            target_water_ml=target_water_ml,
        )
        hearts = pet_service.apply_result(hearts, good_day)
        last_evaluated_date = next_day
        iterations += 1

    if iterations > 0:
        supabase.table("pet_state").update(
            {"hearts": hearts, "last_evaluated_date": last_evaluated_date.isoformat()}
        ).eq("user_id", user_id).execute()


def sweep() -> None:
    """The single sweep the APScheduler job below calls every
    CHECK_INTERVAL_MINUTES. Plain sync function, same shape as
    notification_scheduler.check_and_send_notifications — AsyncIOScheduler
    already runs this on its default thread-pool executor, so the sync
    supabase-py client throughout doesn't block the event loop.

    A failure for one user is caught and logged, never allowed to abort the
    sweep for everyone else — same discipline as every other per-user sweep
    in this codebase."""
    settings = get_settings()
    supabase = get_supabase()
    profiles = (
        supabase.table("profiles").select("id,timezone,daily_calories,daily_water_ml").execute().data or []
    )
    for profile in profiles:
        try:
            _process_user(supabase, profile, settings.retention_days)
        except Exception:
            logger.exception("Pet health sweep failed for user %s", profile.get("id"))


def register_job(scheduler: AsyncIOScheduler) -> None:
    """Adds this sweep to the app's single shared APScheduler instance (see
    main.py's lifespan) — deliberately not a second scheduler, same
    --workers 1 / single-process assumption as cleanup_service and
    notification_scheduler."""
    scheduler.add_job(
        sweep,
        "interval",
        minutes=CHECK_INTERVAL_MINUTES,
        id="pet_health_sweep",
        max_instances=1,
        coalesce=True,
    )
    logger.info("Started pet health sweep (every %d minutes)", CHECK_INTERVAL_MINUTES)
