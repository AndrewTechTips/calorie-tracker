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

    # Six tables purged (daily_logs, water_logs, ai_feature_usage,
    # ai_feature_usage_monthly, push_subscriptions, daily_calorie_summary) —
    # weight_logs must never appear.
    purged_tables = [call.args[0] for call in fake_supabase.table.call_args_list]
    assert purged_tables == [
        "daily_logs",
        "water_logs",
        "ai_feature_usage",
        "ai_feature_usage_monthly",
        "push_subscriptions",
        "daily_calorie_summary",
    ]
    assert "weight_logs" not in purged_tables

    # The cutoff passed to .lt() for daily_logs/water_logs should land within
    # [now - 7d - test-slack, now - 7d]. ai_feature_usage's own cutoff uses a
    # different (2-day, date-only) window, and ai_feature_usage_monthly a
    # different (month-bucket) window still — each checked separately below.
    retention_days = get_settings().retention_days
    lt_calls = fake_supabase.table.return_value.delete.return_value.lt.call_args_list
    for lt_call in lt_calls[:2]:
        _column, cutoff_str = lt_call.args
        cutoff = datetime.fromisoformat(cutoff_str)
        assert (before - timedelta(days=retention_days)) <= cutoff <= (after - timedelta(days=retention_days))

    usage_column, usage_cutoff_str = lt_calls[2].args
    assert usage_column == "usage_date"
    usage_cutoff = datetime.fromisoformat(usage_cutoff_str).date()
    assert (before.date() - timedelta(days=2)) <= usage_cutoff <= (after.date() - timedelta(days=2))

    # ai_feature_usage_monthly's cutoff is "first of last month" — i.e.
    # anything before that (two-or-more months old) gets purged, current and
    # previous month are kept.
    monthly_column, monthly_cutoff_str = lt_calls[3].args
    assert monthly_column == "usage_month"
    monthly_cutoff = datetime.fromisoformat(monthly_cutoff_str).date()
    assert monthly_cutoff.day == 1
    this_month_start = before.date().replace(day=1)
    expected_last_month_start = (this_month_start - timedelta(days=1)).replace(day=1)
    assert monthly_cutoff == expected_last_month_start

    # push_subscriptions: rows not seen (successful send OR app-open
    # resubscribe) in 90 days are pruned so a dead endpoint can't fire a
    # duplicate alongside the same device's live row.
    subs_column, subs_cutoff_str = lt_calls[4].args
    assert subs_column == "last_seen_at"
    subs_cutoff = datetime.fromisoformat(subs_cutoff_str)
    assert (before - timedelta(days=90)) <= subs_cutoff <= (after - timedelta(days=90))

    # daily_calorie_summary: a date-only column, pruned at
    # summary_retention_days (90) — kept far longer than the 7-day raw window
    # since the Damage Control sparkline / Phase 2 recap baselines need the
    # longitudinal history.
    summary_column, summary_cutoff_str = lt_calls[5].args
    assert summary_column == "date"
    summary_cutoff = datetime.fromisoformat(summary_cutoff_str).date()
    summary_days = get_settings().summary_retention_days
    assert (before.date() - timedelta(days=summary_days)) <= summary_cutoff <= (after.date() - timedelta(days=summary_days))


def test_retention_days_is_configurable(monkeypatch):
    from config import Settings

    monkeypatch.setenv("RETENTION_DAYS", "14")
    get_settings.cache_clear()
    try:
        assert Settings().retention_days == 14
    finally:
        get_settings.cache_clear()
