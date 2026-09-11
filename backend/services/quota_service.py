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
# currently "gemini" (vision + text extraction + macro lookup),
# "gemini_chat" (the cheap flash-lite tier, now only reachable when
#            free_text_allow_paid_fallback is on — chat and meal
# suggestions) and "gemini_composite" (the high-thinking composite "chef").
# Three separate pools over what is now the same paid Google account, so a
# chatty afternoon can never eat the scan budget — see config.py.
# The OpenAI-compatible providers (Groq/Mistral) are recorded here too but
# never proactively gated — they are reached reactively, in configured order —
# no `_configured_models()` entry here for it, since it doesn't publish a
# reliable number worth proactively gating on (see config.py's own
# comments).
#
# In-memory, not a DB table: this runs as a single container with
# --workers 1 (see backend/Dockerfile), so
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


def _now_ts() -> float:
    # Wall-clock seconds — factored out (like _today/_current_minute_bucket
    # above) so the failure-cooldown tests can monkeypatch time without
    # touching datetime.now globally.
    return datetime.now(timezone.utc).timestamp()


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
    that isn't proactively gated (Groq/Mistral) too — the counter is still kept
    for usage visibility, it just never blocks anything."""
    with _lock:
        state = _get_state(provider, model)
        state["day_count"] += 1
        state["minute_count"] += 1


# --- Failure cooldown ----------------------------------------------------------
# record_call() above counts a COMPLETED attempt against RPM/RPD. This is the
# orthogonal signal: an attempt that came back with an error making the model a
# bad *proactive* pick for the near future — a 403 entitlement refusal (Mistral's
# `tier_not_allowed` / code 1910 on `mistral-large-*`, confirmed on this account
# 2026-08), a 404 on a retired id, a run of 5xx. Without this, a model that
# hard-fails keeps getting re-promoted to the front of its chain by
# select_candidate()/select_from() on every subsequent call (it still has RPM/RPD
# headroom — it's erroring, not throttled), costing one wasted round-trip per
# call until the reactive walker in gemini_service.py falls past it.
#
# Deliberately short: this state is in-memory and resets on every deploy, and a
# transient provider blip shouldn't sideline a model for long. A genuinely
# persistent 403 just re-trips the cooldown on the first attempt after it lapses
# (cheap to re-learn), and record_success() clears it the instant the model
# answers again — so this self-heals with no operator action the moment billing
# is added / the entitlement is restored.
#
# ---------------------------------------------------------------------------
# 2026-09-11: THE SINGLE-MODEL-POOL PROBLEM, and what changed because of it.
#
# Everything above is written for a MULTI-model pool, where cooling one model
# down routes traffic to a sibling and the only cost is not using your first
# choice for a while. `Settings.gemini_models` currently configures exactly ONE
# model ("gemini-3.8-flash:1000:2000"), so that premise is false for the pool
# that matters most: cooling it down leaves the "gemini" pool with no members
# at all, `has_capacity("gemini")` returns False, and `POST /scan`'s proactive
# check refuses EVERY user's scan with a 503 for the whole duration.
#
# That is not theoretical. It happened by accident during this repo's own
# diagnostic testing: one real `504 DEADLINE_EXCEEDED` from Google — a single
# transient blip, on one request — armed a 600-second cooldown and took
# scanning down account-wide. The mechanism worked exactly as designed; the
# design just assumed a sibling model that does not exist here.
#
# Three changes, each addressing a different part of it:
#
#   1. TRANSIENT ERRORS GET A RETRY BEFORE THEY EVER REACH HERE. See
#      gemini_service._call_model: 500/502/503/504 and httpx timeout/connect
#      errors now retry once with a short backoff, so a genuine one-off blip
#      self-heals and never records a failure at all. A 429 records nothing
#      either way — ordinary throttling is the RPM bucket's job, and this
#      function's docstring always said so while _call_model armed a cooldown
#      on one anyway.
#
#   2. ONE FAILURE IS NO LONGER ENOUGH (_FAILURE_STREAK_TO_COOLDOWN). A
#      consecutive-failure counter per (provider, model) has to reach a streak
#      before `cooldown_until` is armed. Deliberately NOT redundant with (1):
#      (1) asks "did this same request work on a second try, seconds apart?"
#      and (2) asks "are SEPARATE requests, over a longer window, all failing?"
#      — a blip fails the first question, an outage fails both.
#
#   3. THE COOLDOWN IS SHORTER. See _FAILURE_COOLDOWN_SECONDS below.
#
# `immediate=True` is the escape hatch for errors where the first one is
# already conclusive — see record_failure's own docstring.
# ---------------------------------------------------------------------------
# 600 -> 180. The original figure was sized for the multi-model case, where the
# wait costs a preference and a sibling serves traffic meanwhile. In a
# single-model pool a cooldown IS an outage, so its duration is a direct
# availability cost and the only thing it buys is not wasting a round-trip
# against a provider that is probably still down. Three minutes keeps that
# benefit (a real Google incident lasting minutes is not re-probed on every
# request) while capping the self-inflicted damage from a false positive at
# something a user would experience as "try again shortly" rather than as the
# feature being gone. record_success() still clears it instantly, so a provider
# that recovers early costs at most one refused window.
_FAILURE_COOLDOWN_SECONDS = 180

# How many CONSECUTIVE failures arm the full cooldown. 3, not 2, and the reason
# is the traffic shape: this app serves 15-20 users, so requests are sparse and
# "consecutive" is weak evidence on its own — two unrelated blips minutes apart
# would trip a threshold of 2. Three consecutive failures, each of which has
# ALREADY survived _call_model's own retry for the transient classes, means at
# least six failed attempts against the provider. That is an outage, not noise.
_FAILURE_STREAK_TO_COOLDOWN = 3

# ...and the streak only counts while failures keep arriving. Without this, three
# failures spread across six hours would arm a cooldown as surely as three in ten
# seconds, which is precisely the false positive this whole block exists to stop.
# A failure older than this window starts the count again from one.
_FAILURE_STREAK_WINDOW_SECONDS = 120


def record_failure(provider: str, model: str, *, immediate: bool = False) -> bool:
    """Call when a real attempt against (provider, model) failed with an error
    that makes it a poor proactive pick for the near future. NOT for a plain
    429 — ordinary throttling is what the RPM bucket already handles. Safe for
    an un-gated provider (Groq/Mistral); the stamp is simply never read for one.

    Returns True if this call armed the cooldown, so the caller can log the
    transition rather than every failure along the way.

    By default this only COUNTS the failure, and arms `cooldown_until` once
    `_FAILURE_STREAK_TO_COOLDOWN` consecutive failures have landed inside
    `_FAILURE_STREAK_WINDOW_SECONDS` of each other. See the block comment above
    for why one failure stopped being enough.

    `immediate=True` arms on the first failure, for errors where a second
    opinion tells you nothing because the answer cannot depend on the request:
    a 401/403 entitlement refusal (Mistral's `tier_not_allowed` / code 1910 on
    `mistral-large-*`, confirmed on this account 2026-08) or a 404 on a retired
    model id. Those are facts about the credential or the model name, identical
    for every caller, so waiting for a streak just burns three round-trips to
    re-learn what the first one already proved."""
    now = _now_ts()
    with _lock:
        state = _get_state(provider, model)
        last = state.get("last_failure_at")
        if last is None or now - last > _FAILURE_STREAK_WINDOW_SECONDS:
            state["failure_streak"] = 1
        else:
            state["failure_streak"] = state.get("failure_streak", 0) + 1
        state["last_failure_at"] = now

        if immediate or state["failure_streak"] >= _FAILURE_STREAK_TO_COOLDOWN:
            already = state.get("cooldown_until")
            state["cooldown_until"] = now + _FAILURE_COOLDOWN_SECONDS
            return already is None or already <= now
        return False


def consecutive_failures(provider: str, model: str) -> int:
    """Current unbroken failure streak for (provider, model) — 0 when the last
    outcome was a success or the streak window has lapsed. Exposed for
    logging/diagnostics and for the tests that pin the streak behaviour."""
    with _lock:
        state = _state.get((provider, model), {})
        last = state.get("last_failure_at")
        if last is None or _now_ts() - last > _FAILURE_STREAK_WINDOW_SECONDS:
            return 0
        return state.get("failure_streak", 0)


def record_success(provider: str, model: str) -> None:
    """Clear any active failure cooldown for (provider, model) after a real 2xx —
    a model that just answered is healthy regardless of what it did ten minutes
    ago. Also resets the consecutive-failure streak: "consecutive" has to mean
    consecutive, or a model that fails, works, fails, works would eventually
    cool down despite serving half its traffic fine."""
    with _lock:
        state = _get_state(provider, model)
        state.pop("cooldown_until", None)
        state.pop("failure_streak", None)
        state.pop("last_failure_at", None)


def _in_cooldown(provider: str, model: str) -> bool:
    """True if (provider, model) is inside an unexpired failure cooldown. Must be
    called while holding _lock (same contract as _get_state)."""
    until = _state.get((provider, model), {}).get("cooldown_until")
    return until is not None and _now_ts() < until


def filter_cooled_down(provider: str, models: list[str]) -> list[str]:
    """Drop cooled-down models from a REACTIVE-fallover list — UNLESS that would
    empty it, in which case return it unchanged (a wasted round-trip on a
    probably-dead model still beats having nothing left to try).
    select_candidate()/select_from() already skip cooled-down models for the
    PROACTIVE pick via _candidate_capacity below; this is the reactive-list
    equivalent, so a dead model also isn't retried mid-walk on every call — only
    as the genuine last resort."""
    with _lock:
        live = [m for m in models if not _in_cooldown(provider, m)]
    return live or models


def _candidate_capacity(provider: str, model: str, *, rpm: int, rpd: int | None) -> dict:
    with _lock:
        state = _get_state(provider, model)
        day_used = state["day_count"]
        minute_used = state["minute_count"]
        cooled_down = _in_cooldown(provider, model)
    day_ok = rpd is None or day_used < rpd
    return {
        "provider": provider,
        "model": model,
        "day_used": day_used,
        "day_limit": rpd,
        "minute_used": minute_used,
        "minute_limit": rpm,
        "cooled_down": cooled_down,
        "available": day_ok and minute_used < rpm and not cooled_down,
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


def select_from(provider: str, priority: list[str]) -> str | None:
    """Like select_candidate(provider) above, but walks a CALLER-SUPPLIED
    priority order instead of Settings.{provider}_models' own declared
    order. Exists so two different tasks can proactively prefer different
    models from the exact same provider's real quota pool — e.g.
    gemini_service.py's Task B (accuracy-first) and Task C (throughput-first)
    orderings over the shared "mistral" catalog — without duplicating that
    catalog into two separate Settings fields, which would make this
    module's own (provider, model) counters double-count a model shared by
    both orderings and silently permit up to 2x the provider's real rate
    limit before a live 429 ever caught it. RPM/RPD ceilings for each name in
    `priority` still come from Settings.{provider}_models via
    _configured_models — this only changes iteration ORDER, never the limits
    themselves. Silently skips any name in `priority` not present in the
    provider's configured list (e.g. the config was trimmed after this was
    called) rather than raising, so a stale caller-side priority list can't
    break the whole call — same tolerant-of-drift spirit as
    _configured_models' own bare-name fallback."""
    configured = {entry["name"]: entry for entry in _configured_models(provider)}
    for name in priority:
        entry = configured.get(name)
        if entry is None:
            continue
        capacity = _candidate_capacity(provider, name, rpm=entry["rpm"], rpd=entry["rpd"])
        if capacity["available"]:
            return name
    return None


def has_capacity(provider: str) -> bool:
    return select_candidate(provider) is not None


def get_usage() -> dict:
    """Aggregated Gemini (vision, Task A) usage across every configured
    model — this is the real ceiling on how many vision scans this app can
    serve today, not an arbitrary placeholder number. Internal diagnostic
    aggregate now (no HTTP route exposes this shared, not-per-user number
    to the frontend anymore — see services/ai_usage_service.py for the
    per-user quota system that replaced it); still useful for reasoning
    about/logging the shared pool's real state, and covered directly by
    tests/test_quota_service.py. Deliberately Gemini-only (not a generic
    per-provider function) since Task A vision is the one pool this
    ever meant "usage" for. `at_capacity` reflects live RPM as well as RPD,
    so it can be briefly true during a burst and clear again a minute
    later — that is expected: it means multiple people scanned at once, not
    that the day is over."""
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
