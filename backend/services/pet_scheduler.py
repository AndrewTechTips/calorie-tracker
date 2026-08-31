import logging
from datetime import date, datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from postgrest.exceptions import APIError

from config import get_settings
from data.discover_data import RECIPES
from database import get_supabase
from services import discover_challenge_service, pet_service
from services.daytime_service import local_today
from services.db_tolerance import UNDEFINED_COLUMN_CODES, UNDEFINED_TABLE_CODES

logger = logging.getLogger("pet_scheduler")

_RECIPES_BY_ID = {r["id"]: r for r in RECIPES}

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


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cooked_recipe_rows(supabase, user_id: str, monday: date, sunday: date) -> list[dict]:
    """Every Discover-cooked daily_logs row (discover_recipe_id set) whose
    local log_date falls in this ISO week. Tolerates a project that hasn't
    run the Phase 2 discover_recipe_id migration yet — treated as "nothing
    cooked from Discover", same posture as routers/discover.py's activity
    rollup."""
    try:
        return (
            supabase.table("daily_logs")
            .select("discover_recipe_id")
            .eq("user_id", user_id)
            .gte("log_date", monday.isoformat())
            .lte("log_date", sunday.isoformat())
            .not_.is_("discover_recipe_id", "null")
            .execute()
            .data
            or []
        )
    except APIError as exc:
        if exc.code in UNDEFINED_COLUMN_CODES:
            return []
        raise


def _award_challenge_heart(supabase, user_id: str, week_key: str) -> None:
    """Heal exactly one Ollie heart for a completed weekly challenge, then
    mark the row so a later sweep never double-heals. `heal_one` clamps at
    MAX_HEARTS, so a user already at full simply banks the badge with no
    visible heart change — `heart_awarded` is still set either way."""
    pet_result = supabase.table("pet_state").select("hearts").eq("user_id", user_id).maybe_single().execute()
    pet = (pet_result.data if pet_result else None) or {}
    hearts = pet.get("hearts")
    if hearts is None:
        # No pet row yet — create one at full; a heal couldn't raise it further anyway.
        supabase.table("pet_state").upsert(
            {"user_id": user_id, "hearts": pet_service.MAX_HEARTS, "last_evaluated_date": None},
            on_conflict="user_id",
        ).execute()
    else:
        healed = pet_service.heal_one(hearts)
        if healed != hearts:
            supabase.table("pet_state").update({"hearts": healed}).eq("user_id", user_id).execute()
    supabase.table("discover_challenges").update(
        {"heart_awarded": True, "updated_at": _utc_now_iso()}
    ).eq("user_id", user_id).eq("iso_week", week_key).execute()


def _process_challenge(supabase, profile: dict) -> None:
    """Phase 3 — score this user's current weekly Discover challenge and, the
    first sweep it's complete, heal one heart + bank the badge. Reward-only:
    this never removes a heart and is entirely independent of the adherence
    streak / daily heart judgment in _process_user above. Fault-isolated from
    that judgment by its own try/except in sweep(), so a bug here can never
    cost a user the hearts update.

    Idempotent against the 30-minute cadence: once `heart_awarded` is set for
    a week's row nothing re-fires, and each new ISO week gets a fresh row."""
    user_id = profile["id"]
    tz_name = profile.get("timezone") or "UTC"
    today_local = local_today(tz_name)
    week_key = discover_challenge_service.iso_week_key(today_local)
    challenge = discover_challenge_service.challenge_for_date(today_local)
    monday, sunday = discover_challenge_service.week_bounds(today_local)
    target = challenge["target"]

    try:
        existing_result = (
            supabase.table("discover_challenges")
            .select("*")
            .eq("user_id", user_id)
            .eq("iso_week", week_key)
            .maybe_single()
            .execute()
        )
    except APIError as exc:
        if exc.code in UNDEFINED_TABLE_CODES:
            return  # Phase 3 migration not run on this project yet — nothing to do
        raise
    row = (existing_result.data if existing_result else None) or None

    # Heal already banked for this week — nothing left to compute or write.
    if row and row.get("completed_at") and row.get("heart_awarded"):
        return

    progress = discover_challenge_service.count_progress(
        challenge["rule"], _cooked_recipe_rows(supabase, user_id, monday, sunday), _RECIPES_BY_ID
    )
    completed_now = discover_challenge_service.is_complete(progress, target) and not (row and row.get("completed_at"))

    if not row:
        insert = {
            "user_id": user_id,
            "iso_week": week_key,
            "challenge_key": challenge["key"],
            "target": target,
            "progress": progress,
            "updated_at": _utc_now_iso(),
        }
        if completed_now:
            insert["completed_at"] = _utc_now_iso()
        supabase.table("discover_challenges").insert(insert).execute()
    elif progress != row.get("progress") or completed_now:
        update = {"progress": progress, "updated_at": _utc_now_iso()}
        if completed_now:
            update["completed_at"] = _utc_now_iso()
        supabase.table("discover_challenges").update(update).eq("user_id", user_id).eq("iso_week", week_key).execute()

    # Complete (now, or already-complete-but-heal-pending from a prior partial write) → heal once.
    if completed_now or (row and row.get("completed_at") and not row.get("heart_awarded")):
        _award_challenge_heart(supabase, user_id, week_key)


def sweep() -> None:
    """The single sweep the APScheduler job below calls every
    CHECK_INTERVAL_MINUTES. Plain sync function, same shape as
    notification_scheduler.check_and_send_notifications — AsyncIOScheduler
    already runs this on its default thread-pool executor, so the sync
    supabase-py client throughout doesn't block the event loop.

    A failure for one user is caught and logged, never allowed to abort the
    sweep for everyone else — same discipline as every other per-user sweep
    in this codebase. The daily heart judgment and the Phase 3 weekly-
    challenge check are wrapped separately per user so a fault in one never
    stops the other from running."""
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
        try:
            _process_challenge(supabase, profile)
        except Exception:
            logger.exception("Discover challenge sweep failed for user %s", profile.get("id"))


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
