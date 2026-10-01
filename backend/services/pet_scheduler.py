import logging
from datetime import date, datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from postgrest.exceptions import APIError

from config import get_settings
from data.discover_data import RECIPES
from database import get_supabase
from services import discover_challenge_service, pet_service
from services.daytime_service import local_today
from services.db_tolerance import (
    UNDEFINED_COLUMN_CODES,
    UNDEFINED_TABLE_CODES,
    describe_db_error,
    is_transient_db_error,
)

logger = logging.getLogger("pet_scheduler")

_RECIPES_BY_ID = {r["id"]: r for r in RECIPES}

# Coarser than notification_scheduler's 2-minute sweep on purpose — this only
# needs to catch "a user's local midnight has passed," not hit a precise
# reminder time, so 30 minutes is plenty responsive without adding load.
CHECK_INTERVAL_MINUTES = 30

# --- Keeping the sweep cheap (2026-10-01 log-ingestion audit) ---------------
#
# Every Supabase request leaves a log line that counts toward the project's
# Log Ingestion quota. This sweep used to read pet_state, discover_challenges
# and this week's cooked recipes for EVERY profile on EVERY 30-minute tick —
# 1 + 3 reads per account, 48 times a day, inactive accounts included — when
# hearts change at most once a day per user and a finished challenge never
# changes again. A tick now makes four batched reads whatever the number of
# users (profiles, pet_state, discover_challenges, cooked recipes — the last
# skipped when every challenge is already finished and rewarded), and only
# a user with a whole past day still to judge costs anything more.
#
# What is deliberately unchanged:
#   * every judgment and write, in the same order (hearts, then challenge,
#     per user) — the batched rows are exactly the rows the per-user reads
#     returned, just fetched together;
#   * the per-day reads inside the hearts catch-up loop stay per user, so the
#     "a failure mid-judgment banks nothing" guarantee is untouched;
#   * _award_challenge_heart still re-reads hearts fresh before healing, so a
#     heart judged earlier in the same tick is never overwritten.
#
# What changes on a failure: a transient error on one of the BATCHED reads
# skips that concern (hearts, or challenges) for every user this tick rather
# than for one user. Both are idempotent and re-derived from stored state, so
# the next tick 30 minutes later catches up in full — the same reasoning that
# already lets the whole sweep skip a tick when the profiles read fails.


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


def _process_user(supabase, profile: dict, pet_row: dict | None, retention_days: int) -> None:
    """`pet_row` is this user's pet_state row as read by the sweep's batched
    pet_state query, or None when they have none yet."""
    user_id = profile["id"]
    tz_name = profile.get("timezone") or "UTC"
    target_calories = profile.get("daily_calories") or 0
    target_water_ml = profile.get("daily_water_ml") or 3000
    today_local = local_today(tz_name)

    pet = pet_row or {}
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


def _award_challenge_heart(supabase, user_id: str, week_key: str) -> None:
    """Heal exactly one Ollie heart for a completed weekly challenge, then
    mark the row so a later sweep never double-heals. `heal_one` clamps at
    MAX_HEARTS, so a user already at full simply banks the badge with no
    visible heart change — `heart_awarded` is still set either way.

    Write order is deliberate, and matters now that a Supabase blip between
    the two writes is a named, handled case (see sweep()): heal first, latch
    `heart_awarded` second. A failure in that window re-heals on the next
    sweep — at worst one extra heart on a reward-only mechanic that clamps at
    MAX_HEARTS. Latching first would instead lose the heal entirely, which is
    the failure the user would actually notice."""
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


def _week_context(profile: dict) -> dict:
    """This user's current ISO week, its challenge and its date bounds, in
    their own timezone. Computed once per tick and shared by the batched
    reads and the per-user scoring, so both always agree on which week."""
    today_local = local_today(profile.get("timezone") or "UTC")
    monday, sunday = discover_challenge_service.week_bounds(today_local)
    return {
        "week_key": discover_challenge_service.iso_week_key(today_local),
        "challenge": discover_challenge_service.challenge_for_date(today_local),
        "monday": monday,
        "sunday": sunday,
    }


def _load_challenge_context(supabase, profiles: list[dict]) -> dict | None:
    """The challenge half of the tick's batched reads: every user's row for
    their current week, plus — only for users whose challenge is not already
    finished and rewarded — their Discover-cooked logs across the span of
    those weeks. None means "skip challenges this tick": the Phase 3 table
    does not exist on this project (silently, as before), or a read failed
    (logged)."""
    weeks = {profile["id"]: _week_context(profile) for profile in profiles}
    user_ids = list(weeks)

    try:
        challenge_rows = (
            supabase.table("discover_challenges")
            .select("*")
            .in_("user_id", user_ids)
            .in_("iso_week", sorted({week["week_key"] for week in weeks.values()}))
            .execute()
            .data
            or []
        )
    except APIError as exc:
        if exc.code in UNDEFINED_TABLE_CODES:
            return None  # Phase 3 migration not run on this project yet — nothing to do
        _log_skip(exc, "discover challenge sweep (loading challenges)", "*")
        return None
    except Exception as exc:
        _log_skip(exc, "discover challenge sweep (loading challenges)", "*")
        return None
    # A row is only ever for its user's CURRENT week here; a stray row for a
    # week some other user is in is filtered out by the key itself.
    rows = {(row["user_id"], row["iso_week"]): row for row in challenge_rows}

    def _settled(user_id: str) -> bool:
        row = rows.get((user_id, weeks[user_id]["week_key"]))
        return bool(row and row.get("completed_at") and row.get("heart_awarded"))

    pending = [user_id for user_id in user_ids if not _settled(user_id)]
    cooked: dict[str, list[dict]] = {}
    if pending:
        first_monday = min(weeks[user_id]["monday"] for user_id in pending)
        last_sunday = max(weeks[user_id]["sunday"] for user_id in pending)
        try:
            cooked_rows = (
                supabase.table("daily_logs")
                .select("user_id,log_date,discover_recipe_id")
                .in_("user_id", pending)
                .gte("log_date", first_monday.isoformat())
                .lte("log_date", last_sunday.isoformat())
                .not_.is_("discover_recipe_id", "null")
                .execute()
                .data
                or []
            )
        except APIError as exc:
            # Same tolerance as before: no Phase 2 column means "nothing
            # cooked from Discover", not an error.
            if exc.code not in UNDEFINED_COLUMN_CODES:
                _log_skip(exc, "discover challenge sweep (loading cooked recipes)", "*")
                return None
            cooked_rows = []
        except Exception as exc:
            _log_skip(exc, "discover challenge sweep (loading cooked recipes)", "*")
            return None
        for row in cooked_rows:
            cooked.setdefault(row["user_id"], []).append(row)

    return {"weeks": weeks, "rows": rows, "cooked": cooked}


def _process_challenge(supabase, profile: dict, context: dict) -> None:
    """Phase 3 — score this user's current weekly Discover challenge and, the
    first sweep it's complete, heal one heart + bank the badge. Reward-only:
    this never removes a heart and is entirely independent of the adherence
    streak / daily heart judgment in _process_user above. Fault-isolated from
    that judgment by its own try/except in sweep(), so a bug here can never
    cost a user the hearts update.

    Idempotent against the 30-minute cadence: once `heart_awarded` is set for
    a week's row nothing re-fires, and each new ISO week gets a fresh row.

    `context` is _load_challenge_context's batched result; this function
    makes no reads of its own except the fresh hearts read inside
    _award_challenge_heart."""
    user_id = profile["id"]
    week = context["weeks"][user_id]
    week_key = week["week_key"]
    challenge = week["challenge"]
    monday_str, sunday_str = week["monday"].isoformat(), week["sunday"].isoformat()
    target = challenge["target"]

    row = context["rows"].get((user_id, week_key))

    if row and row.get("completed_at") and row.get("heart_awarded"):
        return

    # The batched read spans every pending user's week; keep only this
    # user's own Monday..Sunday (ISO date strings compare correctly).
    cooked_rows = [
        cooked
        for cooked in context["cooked"].get(user_id, [])
        if monday_str <= (cooked.get("log_date") or "") <= sunday_str
    ]
    progress = discover_challenge_service.count_progress(challenge["rule"], cooked_rows, _RECIPES_BY_ID)
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

    if completed_now or (row and row.get("completed_at") and not row.get("heart_awarded")):
        _award_challenge_heart(supabase, user_id, week_key)


def _log_skip(exc: Exception, what: str, user_id) -> None:
    """A transient Supabase error gets one clean warning line and is simply
    retried by the next sweep; anything else keeps its traceback, because it
    needs a human. See services/db_tolerance.py for the distinction."""
    if is_transient_db_error(exc):
        logger.warning("Skipping %s for user %s this sweep: %s", what, user_id, describe_db_error(exc))
    else:
        logger.exception("%s failed for user %s", what.capitalize(), user_id)


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
    stops the other from running.

    Deliberately NOT wrapped any finer than per-user-per-concern:
    _process_user walks a catch-up loop and writes hearts +
    last_evaluated_date ONCE at the end, so aborting it partway leaves
    nothing written and the next sweep re-judges those days from scratch.
    Swallowing an error inside that loop would instead bank a half-judged
    result — a heart deducted for a day whose logs were never actually read.
    Idempotent re-runs are the correct response to a blip here; partial
    writes are not.
    """
    settings = get_settings()
    supabase = get_supabase()
    try:
        profiles = (
            supabase.table("profiles").select("id,timezone,daily_calories,daily_water_ml").execute().data or []
        )
    except Exception as exc:
        # The one query with no per-user fallback: without the profile rows
        # there is nobody to iterate, so a blip here used to propagate out of
        # the sweep and cost EVERY user that tick's heart judgment and
        # challenge check. Skip the tick instead — the next one is
        # CHECK_INTERVAL_MINUTES away and both jobs are idempotent (hearts
        # judge whole PAST days off last_evaluated_date; a challenge heal is
        # latched by heart_awarded), so a missed sweep is caught up in full
        # by the next, not lost.
        if is_transient_db_error(exc):
            logger.warning("Pet sweep skipped — could not load profiles: %s", describe_db_error(exc))
        else:
            logger.exception("Pet sweep skipped — could not load profiles")
        return

    if not profiles:
        return

    # The batched reads (see "Keeping the sweep cheap" above). Each concern
    # loads independently, so a failure loading one never withholds the other.
    try:
        pets = {
            row["user_id"]: row
            for row in (
                supabase.table("pet_state").select("*").in_("user_id", [p["id"] for p in profiles]).execute().data or []
            )
        }
    except Exception as exc:
        _log_skip(exc, "pet health sweep (loading pet states)", "*")
        pets = None
    challenge_context = _load_challenge_context(supabase, profiles)

    for profile in profiles:
        user_id = profile.get("id")
        if pets is not None:
            try:
                _process_user(supabase, profile, pets.get(user_id), settings.retention_days)
            except Exception as exc:
                _log_skip(exc, "pet health sweep", user_id)
        if challenge_context is not None:
            try:
                _process_challenge(supabase, profile, challenge_context)
            except Exception as exc:
                _log_skip(exc, "discover challenge sweep", user_id)


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
