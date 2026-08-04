import threading
from datetime import date, datetime, time, timedelta, timezone

from config import get_settings

# Tracks live per-(key, model) RPM/RPD usage for every Gemini call and picks
# which configured (key, model) pair to route to next — proactively skipping
# one that's already at its ceiling instead of waiting for Google to 429 it.
# gemini_service.py layers a reactive retry-next-candidate on top too, for
# when our counters and Google's disagree (e.g. right after a restart).
#
# --- Multi-key routing algorithm ---------------------------------------
# Settings.gemini_keys (config.py) is an ordered pool of API keys — always
# gemini_api_key first ("key1"), then whatever gemini_api_keys lists. Each
# *key* has its own independent RPM/RPD quota pool per model on Google's
# side (the same way each distinct *model* already has its own pool — see
# Settings.gemini_models' docs) — a second key isn't a backup for when the
# first is down, it's genuinely additional capacity at the SAME model
# quality.
#
# That's why the priority order here is MODEL-major, KEY-minor, not the
# other way around: for a given model, try every key before moving on to a
# lower-tier model. Concretely, with keys [K1, K2] and models [A, B]:
#   K1-A, K2-A, K1-B, K2-B
# i.e. exhaust every key's quota on the best model (A) before EVER falling
# back to a worse one (B) on any key. This maximizes how much traffic runs
# on the best-available model instead of downgrading quality the moment the
# *first* key alone runs out — the whole point of adding more keys.
#
# In-memory, not a DB table: this runs as a single Render instance, so
# there's no second process to fall out of sync with, and a restart only
# ever under-counts for the rest of that day/minute — never falsely blocks
# a legitimate user.
_lock = threading.Lock()
_candidate_state: dict[tuple[str, str], dict] = {}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _current_minute_bucket() -> int:
    # A fixed 60s window, not a true sliding one — fine for a soft guard
    # sitting under Google's real limit.
    return int(datetime.now(timezone.utc).timestamp() // 60)


def _configured_keys() -> list[str]:
    return get_settings().gemini_keys


def key_alias(index: int) -> str:
    """Human-readable, secret-safe label for a key's position in the pool —
    "key1" is always Settings.gemini_api_key, "key2"/"key3"/... come from
    gemini_api_keys in order. Used everywhere a key needs to be named (log
    messages, internal state dict keys) so the raw secret is never the thing
    passed around, logged, or compared."""
    return f"key{index + 1}"


def _configured_models() -> list[dict]:
    """Parses Settings.gemini_models into [{"name", "rpm", "rpd"}, ...].
    Each entry is a bare model name (falls back to gemini_model_rpm/rpd) or
    "name:rpm:rpd" for its own limit — different models get very different
    free-tier quotas (see `api_limits` in the repo root), so one shared limit
    for every candidate would waste a big model's quota or overshoot a
    small one's. This same per-model limit applies independently to each
    configured key (see module docstring)."""
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


def _get_state(alias: str, model: str) -> dict:
    """Must be called while holding _lock."""
    today = _today()
    minute = _current_minute_bucket()
    state = _candidate_state.setdefault(
        (alias, model), {"date": today, "day_count": 0, "minute_bucket": minute, "minute_count": 0}
    )
    if state["date"] != today:
        state["date"] = today
        state["day_count"] = 0
    if state["minute_bucket"] != minute:
        state["minute_bucket"] = minute
        state["minute_count"] = 0
    return state


def record_gemini_call(alias: str, model: str) -> None:
    """Call exactly once per actual Gemini API attempt against `model` using
    the key identified by `alias` (see key_alias()) — including ones that
    turn out invalid_input, since Google still counts those against quota.
    Never call this speculatively before knowing a call will happen."""
    with _lock:
        state = _get_state(alias, model)
        state["day_count"] += 1
        state["minute_count"] += 1


def _candidate_capacity(alias: str, entry: dict) -> dict:
    model = entry["name"]
    with _lock:
        state = _get_state(alias, model)
        day_used = state["day_count"]
        minute_used = state["minute_count"]
    return {
        "key": alias,
        "model": model,
        "day_used": day_used,
        "day_limit": entry["rpd"],
        "minute_used": minute_used,
        "minute_limit": entry["rpm"],
        "available": day_used < entry["rpd"] and minute_used < entry["rpm"],
    }


def candidate_pairs() -> list[tuple[str, str]]:
    """Full priority-ordered (key_alias, model_name) candidate list —
    MODEL-major, KEY-minor (see module docstring for why): every key is
    tried against the current best model before any key moves on to the
    next model down. Used both by select_candidate() below and by
    gemini_service.py's reactive failover loop (tried in order after
    select_candidate() picks the starting point, on a live error from the
    candidate actually called)."""
    aliases = [key_alias(i) for i in range(len(_configured_keys()))]
    return [(alias, entry["name"]) for entry in _configured_models() for alias in aliases]


def select_candidate() -> tuple[str, str] | None:
    """Returns the highest-priority (key_alias, model_name) pair that
    currently has both RPM and RPD headroom, or None if every candidate
    across every key is at capacity. Call this right before a Gemini attempt
    so routing reacts to real recent usage instead of always preferring the
    same candidate."""
    aliases = [key_alias(i) for i in range(len(_configured_keys()))]
    for entry in _configured_models():
        for alias in aliases:
            if _candidate_capacity(alias, entry)["available"]:
                return alias, entry["name"]
    return None


def has_capacity() -> bool:
    return select_candidate() is not None


def get_usage() -> dict:
    """Aggregated across every configured (key, model) pair — this is the
    real ceiling on how many Gemini calls this app can serve today, not an
    arbitrary placeholder number, and it scales with both the model list
    AND the key pool. `at_capacity` reflects live RPM as well as RPD, so it
    can be briefly true during a burst and clear again a minute later — that
    is expected: it means multiple people scanned at once, not that the day
    is over."""
    aliases = [key_alias(i) for i in range(len(_configured_keys()))]
    per_candidate = [_candidate_capacity(alias, e) for e in _configured_models() for alias in aliases]

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
