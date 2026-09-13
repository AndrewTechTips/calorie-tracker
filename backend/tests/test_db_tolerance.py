import logging

import httpx
import pytest
from postgrest.exceptions import APIError

from services.db_tolerance import (
    describe_db_error,
    is_transient_db_error,
    read_tolerant,
    sweep_guard,
    write_tolerant,
)
from tests.fake_supabase import GATEWAY_TIMEOUT_BODY, validation_error_like_postgrest


class _Recorder:
    """Records every dict `execute` was actually called with, distinctly per
    call (not the same mutated object — see write_tolerant's own docstring
    on why that distinction matters)."""

    def __init__(self, side_effects):
        self.calls = []
        self._side_effects = iter(side_effects)

    def __call__(self, data):
        self.calls.append(dict(data))
        effect = next(self._side_effects)
        if isinstance(effect, Exception):
            raise effect
        return effect


async def test_write_tolerant_passes_through_on_success():
    recorder = _Recorder([{"ok": True}])
    result = await write_tolerant(recorder, {"a": 1, "b": 2})
    assert result == {"ok": True}
    assert recorder.calls == [{"a": 1, "b": 2}]


async def test_write_tolerant_drops_column_on_pgrst204_schema_cache_miss():
    """This is the error code/message a real Supabase insert/update actually
    returns for an unknown column (verified live against a real project) —
    NOT the raw Postgres 42703 code. A previous version of this helper only
    handled 42703 and would have silently failed to degrade gracefully here."""
    error = APIError({"code": "PGRST204", "message": "Could not find the 'fiber' column of 'daily_logs' in the schema cache"})
    recorder = _Recorder([error, {"ok": True}])
    result = await write_tolerant(recorder, {"food_name": "Rice", "fiber": 2})
    assert result == {"ok": True}
    assert recorder.calls == [{"food_name": "Rice", "fiber": 2}, {"food_name": "Rice"}]


async def test_write_tolerant_drops_column_on_raw_postgres_42703():
    error = APIError({"code": "42703", "message": "column profiles.display_name does not exist"})
    recorder = _Recorder([error, {"ok": True}])
    result = await write_tolerant(recorder, {"display_name": "Andrew", "daily_calories": 2200})
    assert result == {"ok": True}
    assert recorder.calls == [
        {"display_name": "Andrew", "daily_calories": 2200},
        {"daily_calories": 2200},
    ]


async def test_write_tolerant_reraises_unrelated_errors():
    error = APIError({"code": "23505", "message": "duplicate key value"})
    recorder = _Recorder([error])
    with pytest.raises(APIError):
        await write_tolerant(recorder, {"a": 1})


async def test_write_tolerant_reraises_if_offending_column_not_in_payload():
    """Defensive: if the reported column somehow isn't a key we sent (a
    mismatch between the error and the request), don't loop forever
    silently dropping unrelated keys — surface the real error instead."""
    error = APIError({"code": "PGRST204", "message": "Could not find the 'unrelated' column of 'x' in the schema cache"})
    recorder = _Recorder([error])
    with pytest.raises(APIError):
        await write_tolerant(recorder, {"a": 1})


async def test_read_tolerant_passes_through_on_success():
    def execute():
        return {"data": [{"id": 1}]}

    result = await read_tolerant(execute)
    assert result == {"data": [{"id": 1}]}


async def test_read_tolerant_returns_empty_data_on_pgrst205_missing_table():
    """The error a real Supabase select actually returns for a table this
    project's schema cache doesn't know about yet — e.g. workout_sessions on
    a project that hasn't pasted in the migration from sql/schema.sql."""
    error = APIError({"code": "PGRST205", "message": "Could not find the table 'public.workout_sessions' in the schema cache"})

    def execute():
        raise error

    result = await read_tolerant(execute)
    assert result.data == []


async def test_read_tolerant_returns_empty_data_on_raw_postgres_42p01():
    error = APIError({"code": "42P01", "message": 'relation "public.workout_sessions" does not exist'})

    def execute():
        raise error

    result = await read_tolerant(execute)
    assert result.data == []


async def test_read_tolerant_reraises_unrelated_errors():
    error = APIError({"code": "23505", "message": "duplicate key value"})

    def execute():
        raise error

    with pytest.raises(APIError):
        await read_tolerant(execute)


# --- Transient failures (the network, not the schema) ----------------------
# The classifier both background sweeps rely on to tell "Supabase blinked,
# retry yourself" from "a human needs to look at this". Its live origin story
# is in db_tolerance.py's own comment.


@pytest.mark.parametrize(
    "error",
    [
        validation_error_like_postgrest(),  # older postgrest leaking a raw parse failure
        APIError(GATEWAY_TIMEOUT_BODY),  # the same 504, converted by a newer one
        APIError({"message": "JSON could not be generated", "code": 504, "hint": "", "details": ""}),
        APIError({"message": "", "code": 502, "hint": "", "details": ""}),
        APIError({"message": "", "code": 429, "hint": "", "details": ""}),
        httpx.ConnectError("no route to host"),
        httpx.ReadTimeout("timed out"),
        httpx.PoolTimeout("pool exhausted"),
    ],
)
def test_transient_errors_are_recognized(error):
    assert is_transient_db_error(error) is True


@pytest.mark.parametrize(
    "error",
    [
        KeyError("user_id"),
        TypeError("unsupported operand"),
        ValueError("bad literal"),
        APIError({"code": "42703", "message": "column x does not exist", "hint": "", "details": ""}),
        APIError({"code": "42501", "message": "permission denied for table x", "hint": "", "details": ""}),
        APIError({"code": "PGRST205", "message": "Could not find the table in the schema cache", "hint": "", "details": ""}),
        APIError({"code": "23505", "message": "duplicate key value", "hint": "", "details": ""}),
    ],
)
def test_real_bugs_are_not_treated_as_transient(error):
    assert is_transient_db_error(error) is False


def test_describe_collapses_a_multiline_api_error_to_one_line():
    described = describe_db_error(APIError(GATEWAY_TIMEOUT_BODY))
    assert "\n" not in described
    assert "Gateway Timeout" in described
    assert "APIError" in described


def test_sweep_guard_warns_without_a_traceback_on_a_transient_error(caplog):
    logger = logging.getLogger("sweep_guard_test")
    with caplog.at_level("WARNING", logger="sweep_guard_test"):
        with sweep_guard(logger, "water nudge", "user-1"):
            raise validation_error_like_postgrest()

    assert [record.levelname for record in caplog.records] == ["WARNING"]
    assert caplog.records[0].exc_info is None


def test_sweep_guard_keeps_the_traceback_for_a_real_bug(caplog):
    logger = logging.getLogger("sweep_guard_test")
    with caplog.at_level("WARNING", logger="sweep_guard_test"):
        with sweep_guard(logger, "water nudge", "user-1"):
            raise KeyError("amount_ml")

    assert [record.levelname for record in caplog.records] == ["ERROR"]
    assert caplog.records[0].exc_info is not None


def test_sweep_guard_lets_success_through_untouched(caplog):
    logger = logging.getLogger("sweep_guard_test")
    ran = []
    with caplog.at_level("WARNING", logger="sweep_guard_test"):
        with sweep_guard(logger, "water nudge", "user-1"):
            ran.append(True)

    assert ran == [True]
    assert caplog.records == []
