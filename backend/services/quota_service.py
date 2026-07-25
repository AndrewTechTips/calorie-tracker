import threading
from datetime import date, datetime, time, timedelta, timezone

from config import get_settings

# Tracks live per-model RPM/RPD usage for every Gemini call and picks which
# configured model (Settings.gemini_models) to route to next — proactively
# skipping one that's already at its ceiling instead of waiting for Google to
# 429 it. gemini_service.py layers a reactive retry-next-model on top too,
# for when our counters and Google's disagree (e.g. right after a restart).
#
# In-memory, not a DB table: this runs as a single Render instance, so
# there's no second process to fall out of sync with, and a restart only
# ever under-counts for the rest of that day/minute — never falsely blocks
# a legitimate user.
_lock = threading.Lock()
_model_state: dict[str, dict] = {}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _current_minute_bucket() -> int:
    # A fixed 60s window, not a true sliding one — fine for a soft guard
    # sitting under Google's real limit.
    return int(datetime.now(timezone.utc).timestamp() // 60)


def _configured_models() -> list[dict]:
    """Parses Settings.gemini_models into [{"name", "rpm", "rpd"}, ...].
    Each entry is a bare model name (falls back to gemini_model_rpm/rpd) or
    "name:rpm:rpd" for its own limit — different models get very different
    free-tier quotas (see `api_limits` in the repo root), so one shared limit
    for every candidate would waste a big model's quota or overshoot a
    small one's."""
    settings = get_settings()
    entries: list[dict] = []
    for raw in settings.gemini_models.split(","):
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split(":")
        if len(parts) == 1:
            entries.append({"name": parts[0], "rpm": settings.gemini_model_rpm, "rpd": settings.gemini_model_rpd})
        elif len(parts) == 3:
            name, rpm, rpd = parts
            entries.append({"name": name, "rpm": int(rpm), "rpd": int(rpd)})
        else:
            raise ValueError(
                f"Malformed GEMINI_MODELS entry {raw!r} — expected 'model-name' or 'model-name:rpm:rpd'"
            )
    return entries


def _get_state(model: str) -> dict:
    """Must be called while holding _lock."""
    today = _today()
    minute = _current_minute_bucket()
    state = _model_state.setdefault(
        model, {"date": today, "day_count": 0, "minute_bucket": minute, "minute_count": 0}
    )
    if state["date"] != today:
        state["date"] = today
        state["day_count"] = 0
    if state["minute_bucket"] != minute:
        state["minute_bucket"] = minute
        state["minute_count"] = 0
    return state


def record_gemini_call(model: str) -> None:
    """Call exactly once per actual Gemini API attempt against `model` —
    including ones that turn out invalid_input, since Google still counts
    those against quota. Never call this speculatively before knowing a call
    will happen."""
    with _lock:
        state = _get_state(model)
        state["day_count"] += 1
        state["minute_count"] += 1


def _model_capacity(entry: dict) -> dict:
    model = entry["name"]
    with _lock:
        state = _get_state(model)
        day_used = state["day_count"]
        minute_used = state["minute_count"]
    return {
        "model": model,
        "day_used": day_used,
        "day_limit": entry["rpd"],
        "minute_used": minute_used,
        "minute_limit": entry["rpm"],
        "available": day_used < entry["rpd"] and minute_used < entry["rpm"],
    }


def select_model() -> str | None:
    """Returns the highest-priority configured model that currently has both
    RPM and RPD headroom, or None if every candidate is at capacity. Call
    this right before a Gemini attempt so routing reacts to real recent
    usage instead of always preferring the same model."""
    for entry in _configured_models():
        if _model_capacity(entry)["available"]:
            return entry["name"]
    return None


def candidate_models() -> list[str]:
    """Full priority-ordered candidate list, for gemini_service.py's
    reactive failover loop (tried in order after select_model() picks the
    starting point, on a live error from the model actually called)."""
    return [entry["name"] for entry in _configured_models()]


def has_capacity() -> bool:
    return select_model() is not None


def get_usage() -> dict:
    """Aggregated across every configured model — this is the real ceiling
    on how many Gemini calls this app can serve today, not an arbitrary
    placeholder number. `at_capacity` reflects live RPM as well as RPD, so it
    can be briefly true during a burst and clear again a minute later — that
    is expected: it means multiple people scanned at once, not that the day
    is over."""
    per_model = [_model_capacity(e) for e in _configured_models()]

    used = sum(m["day_used"] for m in per_model)
    limit = sum(m["day_limit"] for m in per_model)
    tomorrow_midnight_utc = datetime.combine(_today() + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return {
        "used": used,
        "limit": limit,
        "remaining": max(limit - used, 0),
        "at_capacity": not any(m["available"] for m in per_model),
        "resets_at": tomorrow_midnight_utc,
    }
