from unittest.mock import MagicMock, patch

import pytest
from postgrest.exceptions import APIError

from routers.targets import update_targets
from models import TargetsUpdate


class FakeUser:
    id = "test-user"


def _result(data):
    result = MagicMock()
    result.data = data
    return result


def _chain(execute_side_effect):
    """A fake supabase.table("profiles").update(...).eq(...) chain whose
    final .execute() call uses the given side effect."""
    table = MagicMock()
    table.update.return_value.eq.return_value.execute.side_effect = execute_side_effect
    return table


def _payload(name="Andrew"):
    return TargetsUpdate(daily_calories=2200, daily_protein=150, daily_carbs=250, daily_fats=70, daily_water_ml=3000, display_name=name)


async def test_update_targets_happy_path():
    table = _chain([_result([{"id": "test-user", "display_name": "Andrew"}])])
    supabase = MagicMock()
    supabase.table.return_value = table

    with patch("routers.targets.get_supabase", return_value=supabase):
        result = await update_targets(_payload(), FakeUser())

    assert result["display_name"] == "Andrew"
    table.update.assert_called_once()
    assert table.update.call_args[0][0]["display_name"] == "Andrew"


async def test_update_targets_falls_back_when_display_name_column_missing():
    """Documents the deliberate safety net in routers/targets.py: if the
    display_name migration (sql/schema.sql) hasn't been applied yet, saving
    settings must still succeed for every *other* field instead of hard
    failing the whole request over one optional, not-yet-existing column."""
    missing_column_error = APIError({"code": "42703", "message": "column profiles.display_name does not exist"})
    table = _chain([missing_column_error, _result([{"id": "test-user"}])])
    supabase = MagicMock()
    supabase.table.return_value = table

    with patch("routers.targets.get_supabase", return_value=supabase):
        result = await update_targets(_payload(), FakeUser())

    assert result["id"] == "test-user"
    assert table.update.call_count == 2
    assert "display_name" in table.update.call_args_list[0][0][0]
    assert "display_name" not in table.update.call_args_list[1][0][0]


async def test_update_targets_reraises_unrelated_api_errors():
    other_error = APIError({"code": "23505", "message": "duplicate key value"})
    table = _chain([other_error])
    supabase = MagicMock()
    supabase.table.return_value = table

    with patch("routers.targets.get_supabase", return_value=supabase):
        with pytest.raises(APIError):
            await update_targets(_payload(), FakeUser())
