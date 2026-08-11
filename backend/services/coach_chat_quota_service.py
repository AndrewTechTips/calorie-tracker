import threading
from datetime import date, datetime, timezone

from config import get_settings

# Per-user, per-day cap on free-text Coach chat turns — see config.py's
# coach_chat_daily_limit docstring for why this exists as its own, separate
# limit from the shared Groq RPM guard quota_service.py tracks for every
# Task B/C AI feature. Same in-memory, single-Render-instance, day-bucket-
# reset shape as quota_service.py's own state (see that module's _get_state
# for the identical idiom), just keyed by user_id instead of (provider,
# model) — nothing else in this backend currently tracks anything
# per-user-per-day.
_lock = threading.Lock()
_counts: dict[str, dict] = {}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _get_state(user_id: str) -> dict:
    """Must be called while holding _lock."""
    today = _today()
    state = _counts.setdefault(user_id, {"date": today, "count": 0})
    if state["date"] != today:
        state["date"] = today
        state["count"] = 0
    return state


def remaining_today(user_id: str) -> int:
    """How many chat turns this user has left today — never negative, even
    if the configured limit was lowered after some usage already happened."""
    limit = get_settings().coach_chat_daily_limit
    with _lock:
        state = _get_state(user_id)
        return max(0, limit - state["count"])


def has_capacity(user_id: str) -> bool:
    return remaining_today(user_id) > 0


def record_turn(user_id: str) -> None:
    """Call exactly once per chat turn that actually reaches the AI provider
    — mirrors quota_service.record_call's "only count real attempts" rule.
    Never call this speculatively before knowing a call will happen."""
    with _lock:
        state = _get_state(user_id)
        state["count"] += 1
