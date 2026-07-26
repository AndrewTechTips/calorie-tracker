import pytest
from postgrest.exceptions import APIError

from services.db_tolerance import write_tolerant


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
