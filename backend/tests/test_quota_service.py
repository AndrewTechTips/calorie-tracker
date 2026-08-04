from datetime import date

import pytest

from services import quota_service


class FakeSettings:
    gemini_models = "model-a,model-b"
    gemini_model_rpm = 2
    gemini_model_rpd = 3
    gemini_keys = ["k1"]


def _reset_state(monkeypatch, settings=None):
    quota_service._candidate_state.clear()
    monkeypatch.setattr(quota_service, "get_settings", lambda: settings or FakeSettings())


def test_starts_at_zero(monkeypatch):
    _reset_state(monkeypatch)
    usage = quota_service.get_usage()
    assert usage["used"] == 0
    assert usage["at_capacity"] is False
    assert usage["limit"] == 6  # two models x rpd 3, one key


def test_record_gemini_call_increments_per_candidate(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_gemini_call("key1", "model-a")
    quota_service.record_gemini_call("key1", "model-a")
    quota_service.record_gemini_call("key1", "model-b")
    assert quota_service.get_usage()["used"] == 3


def test_select_candidate_prefers_priority_order_while_it_has_headroom(monkeypatch):
    _reset_state(monkeypatch)
    assert quota_service.select_candidate() == ("key1", "model-a")


def test_select_candidate_skips_a_candidate_that_hit_its_rpd(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):  # gemini_model_rpd == 3
        quota_service.record_gemini_call("key1", "model-a")
    assert quota_service.select_candidate() == ("key1", "model-b")


def test_select_candidate_skips_a_candidate_that_hit_its_rpm(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(2):  # gemini_model_rpm == 2, well under rpd == 3
        quota_service.record_gemini_call("key1", "model-a")
    assert quota_service.select_candidate() == ("key1", "model-b")


def test_at_capacity_when_every_candidate_is_exhausted(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(3):
        quota_service.record_gemini_call("key1", "model-a")
        quota_service.record_gemini_call("key1", "model-b")

    usage = quota_service.get_usage()
    assert usage["used"] == 6
    assert usage["remaining"] == 0
    assert usage["at_capacity"] is True
    assert quota_service.select_candidate() is None
    assert quota_service.has_capacity() is False


def test_resets_on_new_utc_day(monkeypatch):
    _reset_state(monkeypatch)
    quota_service.record_gemini_call("key1", "model-a")
    quota_service.record_gemini_call("key1", "model-a")
    assert quota_service.get_usage()["used"] == 2

    # Simulate the UTC date having rolled over since the last call.
    monkeypatch.setattr(quota_service, "_today", lambda: date(2099, 1, 1))
    usage = quota_service.get_usage()
    assert usage["used"] == 0

    quota_service.record_gemini_call("key1", "model-a")
    assert quota_service.get_usage()["used"] == 1


def test_resets_minute_bucket_without_touching_day_count(monkeypatch):
    _reset_state(monkeypatch)
    for _ in range(2):  # exhaust model-a's RPM for this minute
        quota_service.record_gemini_call("key1", "model-a")
    assert quota_service.select_candidate() == ("key1", "model-b")

    # Simulate a new minute bucket — RPM headroom returns, RPD count persists.
    monkeypatch.setattr(quota_service, "_current_minute_bucket", lambda: 999999)
    assert quota_service.select_candidate() == ("key1", "model-a")
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
    gemini_keys = ["k1"]


def test_per_model_rpm_rpd_overrides_are_respected(monkeypatch):
    _reset_state(monkeypatch, PerModelLimitSettings())
    quota_service.record_gemini_call("key1", "small")
    quota_service.record_gemini_call("key1", "small")  # small's rpd == 2, now exhausted
    assert quota_service.select_candidate() == ("key1", "big")
    assert quota_service.get_usage()["limit"] == 102  # 100 + 2, not 999 + 999


def test_bare_entry_falls_back_to_global_default(monkeypatch):
    class MixedSettings:
        gemini_models = "explicit:1:5,bare"
        gemini_model_rpm = 7
        gemini_model_rpd = 40
        gemini_keys = ["k1"]

    _reset_state(monkeypatch, MixedSettings())
    usage = quota_service.get_usage()
    assert usage["limit"] == 45  # 5 (explicit) + 40 (bare, from the global default)


def test_malformed_gemini_models_entry_raises_clearly(monkeypatch):
    class BadSettings:
        gemini_models = "model-a:only-two-parts"
        gemini_model_rpm = 1
        gemini_model_rpd = 1
        gemini_keys = ["k1"]

    _reset_state(monkeypatch, BadSettings())
    with pytest.raises(ValueError, match="Malformed GEMINI_MODELS entry"):
        quota_service.select_candidate()


# ---------------------------------------------------------------------------
# Multi-key routing: model-major, key-minor priority order (see
# quota_service.py's module docstring for the exact algorithm this
# implements — every key tried on the best model before ANY key downgrades
# to a worse one).
# ---------------------------------------------------------------------------
class TwoKeySettings:
    gemini_models = "model-a,model-b"
    gemini_model_rpm = 2
    gemini_model_rpd = 2
    gemini_keys = ["k1", "k2"]


def test_candidate_pairs_are_model_major_key_minor(monkeypatch):
    _reset_state(monkeypatch, TwoKeySettings())
    assert quota_service.candidate_pairs() == [
        ("key1", "model-a"),
        ("key2", "model-a"),
        ("key1", "model-b"),
        ("key2", "model-b"),
    ]


def test_second_key_used_before_downgrading_model(monkeypatch):
    _reset_state(monkeypatch, TwoKeySettings())
    # Exhaust key1's quota on model-a entirely (both RPD slots).
    quota_service.record_gemini_call("key1", "model-a")
    quota_service.record_gemini_call("key1", "model-a")

    # Must switch to key2 on the SAME model, not downgrade to model-b.
    assert quota_service.select_candidate() == ("key2", "model-a")


def test_falls_back_to_worse_model_only_once_every_key_exhausts_the_best_one(monkeypatch):
    _reset_state(monkeypatch, TwoKeySettings())
    for alias in ("key1", "key2"):
        quota_service.record_gemini_call(alias, "model-a")
        quota_service.record_gemini_call(alias, "model-a")

    assert quota_service.select_candidate() == ("key1", "model-b")


def test_usage_scales_with_key_pool_size(monkeypatch):
    _reset_state(monkeypatch, TwoKeySettings())
    usage = quota_service.get_usage()
    # 2 models x rpd 2 x 2 keys
    assert usage["limit"] == 8


def test_key_alias_matches_pool_position(monkeypatch):
    _reset_state(monkeypatch, TwoKeySettings())
    assert quota_service.key_alias(0) == "key1"
    assert quota_service.key_alias(1) == "key2"


def test_single_key_pool_behaves_like_the_old_single_key_routing(monkeypatch):
    """Backward-compat check: a deployment that never sets GEMINI_API_KEYS
    (gemini_keys == [gemini_api_key]) gets exactly the old model-priority
    behavior, with no second key ever entering the candidate list."""
    _reset_state(monkeypatch)  # FakeSettings has a single-entry gemini_keys
    assert quota_service.candidate_pairs() == [("key1", "model-a"), ("key1", "model-b")]
