from datetime import date

import pytest

from services import quota_service


class FakeSettings:
    gemini_models = "model-a,model-b"
    gemini_model_rpm = 2
    gemini_model_rpd = 3


def _reset_state(monkeypatch, settings=None):
    quota_service._model_state.clear()
    monkeypatch.setattr(quota_service, "get_settings", lambda: settings or FakeSettings())


def test_starts_at_zero(monkeypatch):
    _reset_state(monkeypatch)
    usage = quota_service.get_usage()
    assert usage["used"] == 0
    assert usage["at_capacity"] is False
    assert usage["limit"] == 6  # two models x rpd 3


def test_record_gemini_call_increments_per_model(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_gemini_call("model-a")
    quota_service.record_gemini_call("model-a")
    quota_service.record_gemini_call("model-b")
    assert quota_service.get_usage()["used"] == 3


def test_select_model_prefers_priority_order_while_it_has_headroom(monkeypatch):
    _reset_state(monkeypatch)
    assert quota_service.select_model() == "model-a"


def test_select_model_skips_a_model_that_hit_its_rpd(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):  # gemini_model_rpd == 3
        quota_service.record_gemini_call("model-a")
    assert quota_service.select_model() == "model-b"


def test_select_model_skips_a_model_that_hit_its_rpm(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(2):  # gemini_model_rpm == 2, well under rpd == 3
        quota_service.record_gemini_call("model-a")
    assert quota_service.select_model() == "model-b"


def test_at_capacity_when_every_model_is_exhausted(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):
        quota_service.record_gemini_call("model-a")
        quota_service.record_gemini_call("model-b")

    usage = quota_service.get_usage()
    assert usage["used"] == 6
    assert usage["remaining"] == 0
    assert usage["at_capacity"] is True
    assert quota_service.select_model() is None
    assert quota_service.has_capacity() is False


def test_resets_on_new_utc_day(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_gemini_call("model-a")
    quota_service.record_gemini_call("model-a")
    assert quota_service.get_usage()["used"] == 2

    # Simulate the UTC date having rolled over since the last call.
    monkeypatch.setattr(quota_service, "_today", lambda: date(2099, 1, 1))
    usage = quota_service.get_usage()
    assert usage["used"] == 0

    quota_service.record_gemini_call("model-a")
    assert quota_service.get_usage()["used"] == 1


def test_resets_minute_bucket_without_touching_day_count(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(2):  # exhaust model-a's RPM for this minute
        quota_service.record_gemini_call("model-a")
    assert quota_service.select_model() == "model-b"

    # Simulate a new minute bucket — RPM headroom returns, RPD count persists.
    monkeypatch.setattr(quota_service, "_current_minute_bucket", lambda: 999999)
    assert quota_service.select_model() == "model-a"
    assert quota_service.get_usage()["used"] == 2


def test_a_restart_undercounts_but_never_falsely_blocks(monkeypatch):
    """Documents the deliberate in-memory tradeoff (see quota_service.py's
    module docstring): losing counter state can only ever make the app
    *more* permissive for the rest of the day, never block a legitimate
    user — i.e. a fresh/reset state always starts under capacity."""
    _reset_state(monkeypatch)
    assert quota_service.has_capacity() is True


class PerModelLimitSettings:
    """A high-quota primary paired with a much smaller-quota secondary —
    exercises the "name:rpm:rpd" override syntax that lets models with very
    different real free-tier limits (see api_limits) coexist in one list."""

    gemini_models = "big:10:100,small:1:2"
    gemini_model_rpm = 999  # would never trigger if the per-model override were ignored
    gemini_model_rpd = 999


def test_per_model_rpm_rpd_overrides_are_respected(monkeypatch):
    _reset_state(monkeypatch, PerModelLimitSettings())
    quota_service.record_gemini_call("small")
    quota_service.record_gemini_call("small")  # small's rpd == 2, now exhausted
    assert quota_service.select_model() == "big"
    assert quota_service.get_usage()["limit"] == 102  # 100 + 2, not 999 + 999


def test_bare_entry_falls_back_to_global_default(monkeypatch):
    class MixedSettings:
        gemini_models = "explicit:1:5,bare"
        gemini_model_rpm = 7
        gemini_model_rpd = 40

    _reset_state(monkeypatch, MixedSettings())
    usage = quota_service.get_usage()
    assert usage["limit"] == 45  # 5 (explicit) + 40 (bare, from the global default)


def test_malformed_gemini_models_entry_raises_clearly(monkeypatch):
    class BadSettings:
        gemini_models = "model-a:only-two-parts"
        gemini_model_rpm = 1
        gemini_model_rpd = 1

    _reset_state(monkeypatch, BadSettings())
    with pytest.raises(ValueError, match="Malformed GEMINI_MODELS entry"):
        quota_service.select_model()
