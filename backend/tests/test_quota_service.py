from datetime import date

from services import quota_service


def _reset_state():
    quota_service._state["date"] = None
    quota_service._state["count"] = 0


def test_starts_at_zero():
    _reset_state()
    usage = quota_service.get_usage()
    assert usage["used"] == 0
    assert usage["at_capacity"] is False


def test_record_gemini_call_increments():
    _reset_state()
    quota_service.record_gemini_call()
    quota_service.record_gemini_call()
    quota_service.record_gemini_call()
    assert quota_service.get_usage()["used"] == 3


def test_at_capacity_when_used_reaches_limit(monkeypatch):
    _reset_state()

    class FakeSettings:
        gemini_daily_quota = 2

    monkeypatch.setattr(quota_service, "get_settings", lambda: FakeSettings())

    quota_service.record_gemini_call()
    assert quota_service.get_usage()["at_capacity"] is False
    assert quota_service.has_capacity() is True

    quota_service.record_gemini_call()
    usage = quota_service.get_usage()
    assert usage["used"] == 2
    assert usage["remaining"] == 0
    assert usage["at_capacity"] is True
    assert quota_service.has_capacity() is False


def test_resets_on_new_utc_day(monkeypatch):
    _reset_state()
    quota_service.record_gemini_call()
    quota_service.record_gemini_call()
    assert quota_service.get_usage()["used"] == 2

    # Simulate the UTC date having rolled over since the last call.
    monkeypatch.setattr(quota_service, "_today", lambda: date(2099, 1, 1))
    usage = quota_service.get_usage()
    assert usage["used"] == 0

    quota_service.record_gemini_call()
    assert quota_service.get_usage()["used"] == 1


def test_a_restart_undercounts_but_never_falsely_blocks(monkeypatch):
    """Documents the deliberate in-memory tradeoff (see quota_service.py's
    module docstring): losing counter state can only ever make the app
    *more* permissive for the rest of the day, never block a legitimate
    user — i.e. a fresh/reset state always starts under capacity."""
    _reset_state()

    class FakeSettings:
        gemini_daily_quota = 1000

    monkeypatch.setattr(quota_service, "get_settings", lambda: FakeSettings())
    assert quota_service.has_capacity() is True
