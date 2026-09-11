from datetime import date

import pytest

from services import quota_service


class FakeSettings:
    gemini_models = "model-a,model-b"
    gemini_model_rpm = 2
    gemini_model_rpd = 3
    groq_models = "groq-model-a,groq-model-b"
    groq_model_rpm = 5
    groq_model_rpd = 10


def _reset_state(monkeypatch, settings=None):
    quota_service._state.clear()
    monkeypatch.setattr(quota_service, "get_settings", lambda: settings or FakeSettings())


def test_starts_at_zero(monkeypatch):
    _reset_state(monkeypatch)
    usage = quota_service.get_usage()
    assert usage["used"] == 0
    assert usage["at_capacity"] is False
    assert usage["limit"] == 6  # two Gemini models x rpd 3


def test_record_call_increments_per_candidate(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_call("gemini", "model-a")
    quota_service.record_call("gemini", "model-a")
    quota_service.record_call("gemini", "model-b")
    assert quota_service.get_usage()["used"] == 3


def test_select_candidate_prefers_priority_order_while_it_has_headroom(monkeypatch):
    _reset_state(monkeypatch)
    assert quota_service.select_candidate("gemini") == "model-a"


def test_select_candidate_skips_a_candidate_that_hit_its_rpd(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):  # gemini_model_rpd == 3
        quota_service.record_call("gemini", "model-a")
    assert quota_service.select_candidate("gemini") == "model-b"


def test_select_candidate_skips_a_candidate_that_hit_its_rpm(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(2):  # gemini_model_rpm == 2, well under rpd == 3
        quota_service.record_call("gemini", "model-a")
    assert quota_service.select_candidate("gemini") == "model-b"


def test_at_capacity_when_every_candidate_is_exhausted(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):
        quota_service.record_call("gemini", "model-a")
        quota_service.record_call("gemini", "model-b")

    usage = quota_service.get_usage()
    assert usage["used"] == 6
    assert usage["remaining"] == 0
    assert usage["at_capacity"] is True
    assert quota_service.select_candidate("gemini") is None
    assert quota_service.has_capacity("gemini") is False


def test_resets_on_new_utc_day(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_call("gemini", "model-a")
    quota_service.record_call("gemini", "model-a")
    assert quota_service.get_usage()["used"] == 2

    # Simulate the UTC date having rolled over since the last call.
    monkeypatch.setattr(quota_service, "_today", lambda: date(2099, 1, 1))
    usage = quota_service.get_usage()
    assert usage["used"] == 0

    quota_service.record_call("gemini", "model-a")
    assert quota_service.get_usage()["used"] == 1


def test_resets_minute_bucket_without_touching_day_count(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(2):  # exhaust model-a's RPM for this minute
        quota_service.record_call("gemini", "model-a")
    assert quota_service.select_candidate("gemini") == "model-b"

    # Simulate a new minute bucket — RPM headroom returns, RPD count persists.
    monkeypatch.setattr(quota_service, "_current_minute_bucket", lambda: 999999)
    assert quota_service.select_candidate("gemini") == "model-a"
    assert quota_service.get_usage()["used"] == 2


def test_a_restart_undercounts_but_never_falsely_blocks(monkeypatch):
    """Documents the deliberate in-memory tradeoff (see quota_service.py's
    module docstring): losing counter state can only ever make the app
    *more* permissive for the rest of the day, never block a legitimate
    user — i.e. a fresh/reset state always starts under capacity."""
    _reset_state(monkeypatch)
    assert quota_service.has_capacity("gemini") is True


class PerModelLimitSettings:
    """A high-quota primary paired with a much smaller-quota secondary —
    exercises the "name:rpm:rpd" override syntax that lets models with very
    different real free-tier limits (see api_limits) coexist in one list."""

    gemini_models = "big:10:100,small:1:2"
    gemini_model_rpm = 999  # would never trigger if the per-model override were ignored
    gemini_model_rpd = 999
    groq_models = "groq-model-a"
    groq_model_rpm = 5
    groq_model_rpd = 10


def test_per_model_rpm_rpd_overrides_are_respected(monkeypatch):
    _reset_state(monkeypatch, PerModelLimitSettings())
    quota_service.record_call("gemini", "small")
    quota_service.record_call("gemini", "small")  # small's rpd == 2, now exhausted
    assert quota_service.select_candidate("gemini") == "big"
    assert quota_service.get_usage()["limit"] == 102  # 100 + 2, not 999 + 999


def test_bare_entry_falls_back_to_global_default(monkeypatch):
    class MixedSettings:
        gemini_models = "explicit:1:5,bare"
        gemini_model_rpm = 7
        gemini_model_rpd = 40
        groq_models = "groq-model-a"
        groq_model_rpm = 5
        groq_model_rpd = 10

    _reset_state(monkeypatch, MixedSettings())
    usage = quota_service.get_usage()
    assert usage["limit"] == 45  # 5 (explicit) + 40 (bare, from the global default)


def test_malformed_gemini_models_entry_raises_clearly(monkeypatch):
    class BadSettings:
        gemini_models = "model-a:only-two-parts"
        gemini_model_rpm = 1
        gemini_model_rpd = 1
        groq_models = "groq-model-a"
        groq_model_rpm = 5
        groq_model_rpd = 10

    _reset_state(monkeypatch, BadSettings())
    with pytest.raises(ValueError, match="Malformed GEMINI_MODELS entry"):
        quota_service.select_candidate("gemini")


def test_single_gemini_key_pool_still_behaves_the_same(monkeypatch):
    """Basic single-provider model-chain behavior — Gemini's own routing
    only ever walks its own model list."""
    _reset_state(monkeypatch)
    assert quota_service.candidate_pairs("gemini") == ["model-a", "model-b"]


# ---------------------------------------------------------------------------
# Generic provider/model cycling — the same mechanism now also drives Groq
# (services/gemini_service.py's _groq_models), not just Gemini. These tests
# exercise it through the "groq" provider string to confirm the abstraction
# genuinely generalizes rather than being Gemini-specific in disguise.
# ---------------------------------------------------------------------------


def test_groq_cycles_through_its_own_model_list(monkeypatch):
    _reset_state(monkeypatch)
    assert quota_service.candidate_pairs("groq") == ["groq-model-a", "groq-model-b"]
    assert quota_service.select_candidate("groq") == "groq-model-a"


def test_groq_has_capacity_starts_true(monkeypatch):
    _reset_state(monkeypatch)
    assert quota_service.has_capacity("groq") is True


def test_groq_falls_to_next_model_once_first_is_rpd_exhausted(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(10):  # groq_model_rpd == 10
        quota_service.record_call("groq", "groq-model-a")
    assert quota_service.select_candidate("groq") == "groq-model-b"


def test_groq_at_capacity_only_once_every_model_is_exhausted(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(10):
        quota_service.record_call("groq", "groq-model-a")
        quota_service.record_call("groq", "groq-model-b")
    assert quota_service.has_capacity("groq") is False


def test_groq_recovers_on_new_minute_bucket(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(5):  # groq_model_rpm == 5
        quota_service.record_call("groq", "groq-model-a")
    assert quota_service.select_candidate("groq") == "groq-model-b"

    monkeypatch.setattr(quota_service, "_current_minute_bucket", lambda: 999999)
    assert quota_service.select_candidate("groq") == "groq-model-a"


def test_provider_with_no_configured_models_is_never_proactively_gated(monkeypatch):
    """The OpenAI-compatible providers (Groq, Mistral) deliberately have no
    {provider}_models setting — they are reached reactively, so there is no
    live counter to consult first (see config.py). quota_service must degrade
    to "no proactive gate" for them, not crash on a missing attribute.

    Also exercised with a name that is not a provider at all, which proves the
    mechanism is generic: nothing here is special-cased per provider. (This
    file's fixture defines a fake "groq" pool for the isolation test below, so
    "mistral" is the real un-gated provider to check here.)"""
    _reset_state(monkeypatch)
    assert quota_service.candidate_pairs("mistral") == []
    assert quota_service.select_candidate("mistral") is None
    assert quota_service.has_capacity("mistral") is False
    assert quota_service.candidate_pairs("not-a-provider") == []
    # record_call still works for usage visibility even though nothing gates on it.
    quota_service.record_call("mistral", "open-mistral-nemo")


def test_gemini_and_groq_pools_are_fully_independent(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):  # exhaust every Gemini model's rpd
        quota_service.record_call("gemini", "model-a")
        quota_service.record_call("gemini", "model-b")
    assert quota_service.has_capacity("gemini") is False
    assert quota_service.has_capacity("groq") is True


# ---------------------------------------------------------------------------
# Failure cooldown — a model that hard-fails (a 403 tier_not_allowed, a 404 on
# a retired id, repeated 5xx) is dropped from the PROACTIVE pick for
# _FAILURE_COOLDOWN_SECONDS instead of being re-selected every call and wasting
# a round-trip, and record_success/expiry both restore it. Exercised through
# the "groq" pool since FakeSettings already configures it.
#
# These first tests use `immediate=True` because they are about what a COOLED
# DOWN model does — selection, expiry, filtering — not about what it takes to
# arm one. The arming POLICY (a streak, a window, which errors skip the streak)
# changed on 2026-09-11 and has its own block further down; keeping the two
# separate is what stops a future policy change from silently making these
# vacuous, which is exactly what happened when the streak was introduced:
# `record_failure` stopped arming anything and several of these kept "passing".
# ---------------------------------------------------------------------------


def test_record_failure_drops_model_from_proactive_selection(monkeypatch):
    _reset_state(monkeypatch)
    assert quota_service.select_candidate("groq") == "groq-model-a"
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    assert quota_service.select_candidate("groq") == "groq-model-b"
    # select_from (caller-supplied order) honours the cooldown too.
    assert quota_service.select_from("groq", ["groq-model-a", "groq-model-b"]) == "groq-model-b"


def test_record_success_clears_the_cooldown(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    assert quota_service.select_candidate("groq") == "groq-model-b"
    quota_service.record_success("groq", "groq-model-a")
    assert quota_service.select_candidate("groq") == "groq-model-a"


def test_cooldown_expires_after_its_window(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    assert quota_service.select_candidate("groq") == "groq-model-b"

    # Jump wall-clock past the cooldown window (same monkeypatch-the-clock
    # pattern the _today / _current_minute_bucket tests above use).
    future = quota_service._now_ts() + quota_service._FAILURE_COOLDOWN_SECONDS + 60
    monkeypatch.setattr(quota_service, "_now_ts", lambda: future)
    assert quota_service.select_candidate("groq") == "groq-model-a"


def test_record_failure_does_not_touch_rpm_rpd_counters(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    # Only a cooldown stamp — day/minute usage is untouched, so the model has
    # its full quota back the instant the cooldown lapses.
    assert quota_service.get_usage()["used"] == 0


def test_filter_cooled_down_removes_a_failed_model(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    assert quota_service.filter_cooled_down(
        "groq", ["groq-model-a", "groq-model-b"]
    ) == ["groq-model-b"]


def test_filter_cooled_down_never_returns_an_empty_list(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    quota_service.record_failure("groq", "groq-model-b", immediate=True)
    # Every candidate cooled down -> list returned unchanged (a wasted
    # round-trip on a probably-dead model still beats nothing left to try).
    assert quota_service.filter_cooled_down(
        "groq", ["groq-model-a", "groq-model-b"]
    ) == ["groq-model-a", "groq-model-b"]


def test_has_capacity_reflects_the_cooldown(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a", immediate=True)
    quota_service.record_failure("groq", "groq-model-b", immediate=True)
    assert quota_service.has_capacity("groq") is False
    quota_service.record_success("groq", "groq-model-a")
    assert quota_service.has_capacity("groq") is True


# ---------------------------------------------------------------------------
# Failure cooldown, ARMING POLICY (2026-09-11).
#
# The bug these were written for: `Settings.gemini_models` configures ONE
# model, so cooling it down empties the "gemini" pool entirely and POST /scan's
# proactive has_capacity() check refuses every user's scan for the duration.
# One real 504 from Google did exactly that during this repo's own diagnostic
# testing — a single transient blip taking scanning down account-wide.
# ---------------------------------------------------------------------------


def test_one_isolated_failure_does_not_arm_the_cooldown(monkeypatch):
    """The headline fix. A single failure is a blip, not a verdict — and in a
    single-model pool a cooldown is a full outage, so a blip must not buy one."""
    _reset_state(monkeypatch)
    armed = quota_service.record_failure("groq", "groq-model-a")
    assert armed is False
    assert quota_service.consecutive_failures("groq", "groq-model-a") == 1
    assert quota_service.select_candidate("groq") == "groq-model-a", (
        "one failure must leave the model selectable"
    )


def test_a_streak_of_failures_still_arms_the_cooldown(monkeypatch):
    """The mechanism has to keep working for what it was built for — a model
    that is genuinely down should stop being the proactive pick."""
    _reset_state(monkeypatch)
    for _ in range(quota_service._FAILURE_STREAK_TO_COOLDOWN - 1):
        assert quota_service.record_failure("groq", "groq-model-a") is False
    assert quota_service.record_failure("groq", "groq-model-a") is True
    assert quota_service.select_candidate("groq") == "groq-model-b"


def test_an_immediately_disqualifying_error_cools_down_without_a_streak(monkeypatch):
    """A 401/403/404 is a fact about the credential or the model name, not
    about this request, so a second opinion tells you nothing. Waiting for a
    streak would burn three round-trips to re-learn what the first proved."""
    _reset_state(monkeypatch)
    assert quota_service.record_failure("groq", "groq-model-a", immediate=True) is True
    assert quota_service.select_candidate("groq") == "groq-model-b"


def test_record_success_resets_the_streak(monkeypatch):
    """"Consecutive" has to mean consecutive. Without this, a model that fails,
    works, fails, works would eventually cool down while serving half its
    traffic perfectly well."""
    _reset_state(monkeypatch)
    quota_service.record_failure("groq", "groq-model-a")
    quota_service.record_failure("groq", "groq-model-a")
    assert quota_service.consecutive_failures("groq", "groq-model-a") == 2

    quota_service.record_success("groq", "groq-model-a")
    assert quota_service.consecutive_failures("groq", "groq-model-a") == 0

    # ...and the next failure starts counting from one, so it takes a full
    # fresh streak to arm rather than the single one left over from before.
    assert quota_service.record_failure("groq", "groq-model-a") is False
    assert quota_service.select_candidate("groq") == "groq-model-a"


def test_the_streak_decays_so_scattered_failures_never_accumulate(monkeypatch):
    """Three failures six hours apart are not a streak. This app serves 15-20
    users, so requests are sparse and "consecutive" is weak evidence without a
    window to bound it."""
    _reset_state(monkeypatch)
    base = quota_service._now_ts()
    for i in range(quota_service._FAILURE_STREAK_TO_COOLDOWN + 2):
        moment = base + i * (quota_service._FAILURE_STREAK_WINDOW_SECONDS + 30)
        monkeypatch.setattr(quota_service, "_now_ts", lambda m=moment: m)
        assert quota_service.record_failure("groq", "groq-model-a") is False
        assert quota_service.consecutive_failures("groq", "groq-model-a") == 1
    assert quota_service.select_candidate("groq") == "groq-model-a"


def test_cooldown_is_short_enough_to_survive_a_single_model_pool(monkeypatch):
    """A number, pinned deliberately. With one model configured, the cooldown's
    duration IS the outage length for every user — it is not "how long until we
    prefer this model again", which is what 600s was sized for."""
    assert quota_service._FAILURE_COOLDOWN_SECONDS <= 180
    assert quota_service._FAILURE_STREAK_TO_COOLDOWN >= 2
    assert quota_service._FAILURE_STREAK_WINDOW_SECONDS > 0
