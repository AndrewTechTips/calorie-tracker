import threading
from datetime import date, datetime, time, timedelta, timezone

from config import get_settings

# Tracks live per-(provider, model) RPM/RPD usage for every AI call and picks
# which model to route to next within a given provider — proactively
# skipping one that's already at its ceiling instead of waiting for a 429.
# gemini_service.py layers a reactive retry-next-candidate on top too, for
# when our counters and the provider's disagree (e.g. right after a
# restart).
#
# --- Provider/model cycling, fully generic --------------------------------
# This was originally Gemini-only (a single provider's ordered model list),
# but the same mechanism now also drives Groq and Gemini's native-SDK
# text fallback — every "how many quota-gated models does this provider
# serve" question is really the same question with a different provider
# string, so there's exactly one implementation. A provider gets a real
# proactive gate here by having a `Settings.{provider}_models` list (+
# `{provider}_model_rpm`/`_rpd` fallback defaults for bare entries):
# currently "gemini" (Task A vision), "gemini_text" (Task B/C's native-
# Gemini last resort — a deliberately separate quota pool from "gemini",
# see config.py's gemini_text_models comment), and "groq" — the providers
# with officially published/empirically-confirmed per-model hard limits.
# NVIDIA also cycles multiple models (see gemini_service.py's
# _static_models), but purely reactively, in configured (quality) order —
# no `_configured_models()` entry here for it, since it doesn't publish a
# reliable number worth proactively gating on (see config.py's own
# comments).
#
# In-memory, not a DB table: this runs as a single Render instance, so
# there's no second process to fall out of sync with, and a restart only
# ever under-counts for the rest of that day/minute — never falsely blocks
# a legitimate user.
_lock = threading.Lock()
_state: dict[tuple[str, str], dict] = {}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _current_minute_bucket() -> int:
    # A fixed 60s window, not a true sliding one — fine for a soft guard
    # sitting under the provider's real limit.
    return int(datetime.now(timezone.utc).timestamp() // 60)


def _configured_models(provider: str) -> list[dict]:
    """Parses Settings.{provider}_models into [{"name", "rpm", "rpd"}, ...].
    Each entry is a bare model name (falls back to
    Settings.{provider}_model_rpm/rpd) or "name:rpm:rpd" for its own limit —
    different models (and different providers) get very different quotas,
    so one shared limit for every candidate would waste a big model's quota
    or overshoot a small one's. Returns [] for a provider with no
    `{provider}_models` setting at all (i.e. one that isn't proactively
    quota-gated — see module docstring)."""
    settings = get_settings()
    raw_list = getattr(settings, f"{provider}_models", "")
    default_rpm = getattr(settings, f"{provider}_model_rpm", None)
    default_rpd = getattr(settings, f"{provider}_model_rpd", None)

    entries: list[dict] = []
    for raw in raw_list.split(","):
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split(":")
        if len(parts) == 1:
            entries.append({"name": parts[0], "rpm": default_rpm, "rpd": default_rpd})
        elif len(parts) == 3:
            name, rpm, rpd = parts
            entries.append({"name": name, "rpm": int(rpm), "rpd": int(rpd)})
        else:
            raise ValueError(
                f"Malformed {provider.upper()}_MODELS entry {raw!r} — expected "
                "'model-name' or 'model-name:rpm:rpd'"
            )
    return entries


def _get_state(provider: str, model: str) -> dict:
    """Must be called while holding _lock."""
    today = _today()
    minute = _current_minute_bucket()
    state = _state.setdefault(
        (provider, model), {"date": today, "day_count": 0, "minute_bucket": minute, "minute_count": 0}
    )
    if state["date"] != today:
        state["date"] = today
        state["day_count"] = 0
    if state["minute_bucket"] != minute:
        state["minute_bucket"] = minute
        state["minute_count"] = 0
    return state


def record_call(provider: str, model: str) -> None:
    """Call exactly once per actual AI API attempt against `model` from
    `provider` — including ones that turn out invalid_input, since the
    provider still counts those against quota. Never call this speculatively
    before knowing a call will happen. Safe to call for a provider/model
    that isn't proactively gated (NVIDIA) too — the counter is still kept
    for usage visibility, it just never blocks anything."""
    with _lock:
        state = _get_state(provider, model)
        state["day_count"] += 1
        state["minute_count"] += 1


def _candidate_capacity(provider: str, model: str, *, rpm: int, rpd: int | None) -> dict:
    with _lock:
        state = _get_state(provider, model)
        day_used = state["day_count"]
        minute_used = state["minute_count"]
    day_ok = rpd is None or day_used < rpd
    return {
        "provider": provider,
        "model": model,
        "day_used": day_used,
        "day_limit": rpd,
        "minute_used": minute_used,
        "minute_limit": rpm,
        "available": day_ok and minute_used < rpm,
    }


def candidate_pairs(provider: str) -> list[str]:
    """Priority-ordered model names for `provider` — used both by
    select_candidate() below and by the caller's own reactive failover loop
    (tried in order after select_candidate() picks the starting point, on a
    live error from the candidate actually called). Empty for a provider
    with no configured model list."""
    return [entry["name"] for entry in _configured_models(provider)]


def select_candidate(provider: str) -> str | None:
    """Returns the highest-priority model for `provider` that currently has
    both RPM and RPD headroom, or None if every configured model is at
    capacity (or the provider has no configured model list at all). Call
    this right before an attempt so routing reacts to real recent usage
    instead of always preferring the same candidate."""
    for entry in _configured_models(provider):
        capacity = _candidate_capacity(provider, entry["name"], rpm=entry["rpm"], rpd=entry["rpd"])
        if capacity["available"]:
            return entry["name"]
    return None


def has_capacity(provider: str) -> bool:
    return select_candidate(provider) is not None


def get_usage() -> dict:
    """Aggregated Gemini (vision, Task A) usage across every configured
    model — this is the real ceiling on how many vision scans this app can
    serve today, not an arbitrary placeholder number. Used by GET
    /scan/usage for the frontend's quota bar; deliberately Gemini-only (not
    a generic per-provider function) since that's the one number the
    frontend contract means by "usage". `at_capacity` reflects live RPM as
    well as RPD, so it can be briefly true during a burst and clear again a
    minute later — that is expected: it means multiple people scanned at
    once, not that the day is over."""
    entries = _configured_models("gemini")
    per_candidate = [_candidate_capacity("gemini", e["name"], rpm=e["rpm"], rpd=e["rpd"]) for e in entries]

    used = sum(c["day_used"] for c in per_candidate)
    limit = sum(c["day_limit"] for c in per_candidate)
    tomorrow_midnight_utc = datetime.combine(_today() + timedelta(days=1), time.min, tzinfo=timezone.utc)
    return {
        "used": used,
        "limit": limit,
        "remaining": max(limit - used, 0),
        "at_capacity": not any(c["available"] for c in per_candidate) if per_candidate else True,
        "resets_at": tomorrow_midnight_utc,
    }
