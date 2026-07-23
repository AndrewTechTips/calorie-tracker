from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from config import get_settings
from services.cleanup_service import delete_old_logs


def test_retention_days_defaults_to_seven():
    assert get_settings().retention_days == 7


def test_delete_old_logs_uses_configured_retention_window(monkeypatch):
    fake_supabase = MagicMock()
    fake_result = MagicMock()
    fake_result.data = []
    # supabase.table(...).delete().lt(...).execute() — same chain for both tables.
    fake_supabase.table.return_value.delete.return_value.lt.return_value.execute.return_value = fake_result
    monkeypatch.setattr("services.cleanup_service.get_supabase", lambda: fake_supabase)

    before = datetime.now(timezone.utc)
    delete_old_logs()
    after = datetime.now(timezone.utc)

    # Two tables purged (daily_logs, water_logs) — weight_logs must never appear.
    purged_tables = [call.args[0] for call in fake_supabase.table.call_args_list]
    assert purged_tables == ["daily_logs", "water_logs"]
    assert "weight_logs" not in purged_tables

    # The cutoff passed to .lt() should land within [now - 7d - test-slack, now - 7d].
    retention_days = get_settings().retention_days
    for lt_call in fake_supabase.table.return_value.delete.return_value.lt.call_args_list:
        _column, cutoff_str = lt_call.args
        cutoff = datetime.fromisoformat(cutoff_str)
        assert (before - timedelta(days=retention_days)) <= cutoff <= (after - timedelta(days=retention_days))


def test_retention_days_is_configurable(monkeypatch):
    from config import Settings

    monkeypatch.setenv("RETENTION_DAYS", "14")
    get_settings.cache_clear()
    try:
        assert Settings().retention_days == 14
    finally:
        get_settings.cache_clear()
