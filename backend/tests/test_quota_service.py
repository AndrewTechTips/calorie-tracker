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
    """NVIDIA deliberately has no {provider}_models setting (see config.py)
    — quota_service must degrade to "no proactive gate" for it, not crash
    on a missing attribute. Also proves the mechanism is generic: "nvidia"
    isn't special-cased anywhere in quota_service.py itself."""
    _reset_state(monkeypatch)
    assert quota_service.candidate_pairs("nvidia") == []
    assert quota_service.select_candidate("nvidia") is None
    assert quota_service.has_capacity("nvidia") is False
    # record_call still works for usage visibility even though nothing gates on it.
    quota_service.record_call("nvidia", "z-ai/glm-5.2")


def test_gemini_and_groq_pools_are_fully_independent(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):  # exhaust every Gemini model's rpd
        quota_service.record_call("gemini", "model-a")
        quota_service.record_call("gemini", "model-b")
    assert quota_service.has_capacity("gemini") is False
    assert quota_service.has_capacity("groq") is True
