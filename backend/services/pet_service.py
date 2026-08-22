from datetime import date

from fastapi.concurrency import run_in_threadpool

from services.trends_service import ADHERENCE_TOLERANCE

# Server-derived caption for the frontend HUD — kept here (not duplicated in
# JS) so there's exactly one place that maps hearts -> mood.
_MOOD_BY_HEARTS = {3: "happy", 2: "content", 1: "hungry", 0: "sick"}

MAX_HEARTS = 3


def mood_for_hearts(hearts: int) -> str:
    return _MOOD_BY_HEARTS.get(hearts, "sick" if hearts <= 0 else "happy")


def evaluate_day(
    *,
    has_food_logs: bool,
    calories: float,
    target_calories: float,
    water_ml: float,
    target_water_ml: float,
) -> bool:
    """Whether a single past LOCAL day counts as "good" for Ollie's health.
    Requires all three, mirroring the brief's own "misses their daily
    calorie/water targets or stops logging entirely" wording literally:
    - at least one food log that day (an unused day is never a free pass,
      same principle trends_service's own streak logic uses)
    - calories within ADHERENCE_TOLERANCE of target (±10% — the same
      tolerance trends_service/notification_service/coach.js already use for
      "on target", reused rather than redefined here)
    - water_ml at or above target_water_ml (a plain floor check, same rule
      notification_service.should_send_water_nudge already uses — water has
      no upper tolerance band, more is never "off target")
    """
    if not has_food_logs:
        return False
    if target_calories > 0 and abs(calories - target_calories) > target_calories * ADHERENCE_TOLERANCE:
        return False
    if water_ml < target_water_ml:
        return False
    return True


def apply_result(hearts: int, good_day: bool) -> int:
    """One judged day moves hearts by exactly 1, clamped to [0, MAX_HEARTS] —
    a bad day costs a heart, but a single good day also heals one back (a
    comeback mechanic, not a one-way punishment ladder), so recovering from a
    rough stretch is always just one good day away."""
    if good_day:
        return min(MAX_HEARTS, hearts + 1)
    return max(0, hearts - 1)


async def get_or_create_pet_state(supabase, user_id: str) -> dict:
    """Lazily creates a hearts=3 row on first read rather than relying on the
    signup trigger (sql/schema.sql's handle_new_user()) to have provisioned
    one — mirrors the lazy-creation shape already used elsewhere in this
    codebase over adding a new trigger for a table this rarely touched."""
    existing = await run_in_threadpool(
        lambda: supabase.table("pet_state").select("*").eq("user_id", user_id).maybe_single().execute()
    )
    if existing is not None and existing.data:
        return existing.data
    row = {"user_id": user_id, "hearts": MAX_HEARTS, "last_evaluated_date": None}
    result = await run_in_threadpool(
        lambda: supabase.table("pet_state").upsert(row, on_conflict="user_id").execute()
    )
    return result.data[0]


async def save_pet_state(supabase, user_id: str, hearts: int, last_evaluated_date: date) -> None:
    await run_in_threadpool(
        lambda: supabase.table("pet_state")
        .update({"hearts": hearts, "last_evaluated_date": last_evaluated_date.isoformat()})
        .eq("user_id", user_id)
        .execute()
    )
