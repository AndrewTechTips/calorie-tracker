import threading
from datetime import date, datetime, time, timedelta, timezone

from config import get_settings

# One shared, in-memory, process-wide counter for actual Gemini API calls
# (vision scans + text-only re-estimates), reset at UTC midnight. This is a
# soft cap the backend enforces on top of Google's own quota, so ~15-20
# concurrent free-tier users get one clear, friendly "at capacity" message
# instead of each independently hitting a raw Gemini rate-limit error.
#
# In-memory is a deliberate choice, not a shortcut: this deploys as a single
# Render instance (see CLAUDE.md), so there's no second process to fall out
# of sync with. A restart merely resets the count early (under-counts for
# the rest of that day) — it can never falsely block a user, only fail to
# protect the quota for a few hours until the next UTC midnight. Moving this
# to a database table would cost a write on every scan for no real benefit
# at this scale.
_lock = threading.Lock()
_state = {"date": None, "count": 0}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _reset_if_new_day() -> None:
    today = _today()
    if _state["date"] != today:
        _state["date"] = today
        _state["count"] = 0


def record_gemini_call() -> None:
    """Call exactly once per actual Gemini API attempt — including ones that
    turn out to be invalid_input, since Google still counts those against
    quota. Never call this speculatively before knowing a call will happen."""
    with _lock:
        _reset_if_new_day()
        _state["count"] += 1


def get_usage() -> dict:
    settings = get_settings()
    with _lock:
        _reset_if_new_day()
        used = _state["count"]

    limit = settings.gemini_daily_quota
    tomorrow_midnight_utc = datetime.combine(_today() + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return {
        "used": used,
        "limit": limit,
        "remaining": max(limit - used, 0),
        "at_capacity": used >= limit,
        "resets_at": tomorrow_midnight_utc,
    }


def has_capacity() -> bool:
    return not get_usage()["at_capacity"]
