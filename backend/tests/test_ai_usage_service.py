from unittest.mock import MagicMock, patch

from services import ai_usage_service


class FakeSettings:
    ai_scan_daily_limit = 8
    ai_scan_describe_daily_limit = 12
    ai_log_correction_daily_limit = 15
    coach_chat_daily_limit = 6
    ai_weekly_recap_daily_limit = 2
    ai_weekly_recap_monthly_limit = 8
    ai_damage_control_daily_limit = 5
    ai_suggest_meals_daily_limit = 8


def _settings_patch():
    return patch("services.ai_usage_service.get_settings", lambda: FakeSettings())


def _rpc_result(data):
    result = MagicMock()
    result.data = data
    return result


def _supabase_with_rpc(execute_result):
    supabase = MagicMock()
    supabase.rpc.return_value.execute.return_value = execute_result
    return supabase


# ---------------------------------------------------------------------------
# try_consume() — the atomic check-and-spend gate that replaced the old
# has_capacity()-then-record_usage() two-step (see ai_usage_service.py's
# module docstring for why that two-step left a race window open). These
# tests cover the Python-side contract only: that it calls the RPC with the
# right limits and correctly interprets the {allowed, ...} row it returns.
# The atomicity itself lives in the SQL function (try_consume_ai_feature_usage
# in sql/schema.sql) and isn't something a mocked unit test can exercise.
# ---------------------------------------------------------------------------
async def test_try_consume_allowed_passes_daily_limit_and_no_monthly_limit():
    supabase = _supabase_with_rpc(_rpc_result([{"allowed": True, "daily_count": 1, "monthly_count": None}]))
    with _settings_patch(), patch("services.ai_usage_service.get_supabase", return_value=supabase):
        allowed = await ai_usage_service.try_consume("user-1", "scan")

    assert allowed is True
    supabase.rpc.assert_called_once_with(
        "try_consume_ai_feature_usage",
        {"p_user_id": "user-1", "p_feature": "scan", "p_daily_limit": 8, "p_monthly_limit": None},
    )


async def test_try_consume_passes_monthly_limit_for_monthly_gated_feature():
    supabase = _supabase_with_rpc(_rpc_result([{"allowed": True, "daily_count": 1, "monthly_count": 1}]))
    with _settings_patch(), patch("services.ai_usage_service.get_supabase", return_value=supabase):
        await ai_usage_service.try_consume("user-1", "weekly_recap")

    supabase.rpc.assert_called_once_with(
        "try_consume_ai_feature_usage",
        {"p_user_id": "user-1", "p_feature": "weekly_recap", "p_daily_limit": 2, "p_monthly_limit": 8},
    )


async def test_try_consume_returns_false_when_rpc_reports_not_allowed():
    """The RPC rolls back its own writes when either axis is over the limit
    (see try_consume_ai_feature_usage's EXCEPTION handler) — the Python side
    just needs to trust the {allowed: false} it reports and not spend
    anything further."""
    supabase = _supabase_with_rpc(_rpc_result([{"allowed": False, "daily_count": None, "monthly_count": None}]))
    with _settings_patch(), patch("services.ai_usage_service.get_supabase", return_value=supabase):
        allowed = await ai_usage_service.try_consume("user-1", "scan")

    assert allowed is False


async def test_try_consume_treats_empty_rpc_response_as_not_allowed():
    """Defensive: an empty/malformed RPC response must fail closed (treated
    as "not allowed"), never fail open and let a request through with no
    evidence it was actually gated."""
    supabase = _supabase_with_rpc(_rpc_result([]))
    with _settings_patch(), patch("services.ai_usage_service.get_supabase", return_value=supabase):
        allowed = await ai_usage_service.try_consume("user-1", "scan")

    assert allowed is False


# ---------------------------------------------------------------------------
# usage_today() / usage_this_month() — regression coverage for the None-guard
# fix (see the "guard against None returns from maybe_single().execute()"
# commit): postgrest-py's maybe_single().execute() returns None outright, not
# an object with .data = None, when zero rows match. This is the exact,
# everyday case for a brand-new user (or any user who hasn't touched a given
# feature yet today) — no prior test covered it directly.
# ---------------------------------------------------------------------------
def _usage_table(execute_return):
    table = MagicMock()
    chain = table.select.return_value.eq.return_value.eq.return_value.eq.return_value.maybe_single.return_value
    chain.execute.return_value = execute_return
    return table


async def test_usage_today_returns_zero_when_maybe_single_returns_none_outright():
    supabase = MagicMock()
    supabase.table.return_value = _usage_table(None)
    with patch("services.ai_usage_service.get_supabase", return_value=supabase):
        used = await ai_usage_service.usage_today("new-user", "scan")

    assert used == 0


async def test_usage_today_returns_call_count_when_row_exists():
    supabase = MagicMock()
    supabase.table.return_value = _usage_table(_rpc_result({"call_count": 3}))
    with patch("services.ai_usage_service.get_supabase", return_value=supabase):
        used = await ai_usage_service.usage_today("existing-user", "scan")

    assert used == 3


async def test_has_capacity_true_for_brand_new_user_with_no_usage_row():
    """A new signup has no ai_feature_usage row at all yet — has_capacity()
    must resolve this to "full quota available", never crash or 500."""
    supabase = MagicMock()
    supabase.table.return_value = _usage_table(None)
    with _settings_patch(), patch("services.ai_usage_service.get_supabase", return_value=supabase):
        assert await ai_usage_service.has_capacity("new-user", "scan") is True
