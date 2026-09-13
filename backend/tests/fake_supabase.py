"""A supabase-py stand-in for the background sweeps' tests.

Every query in a sweep is `table(...).<filters...>.execute()`, so one
chainable object that ignores the filters and answers per-table is enough to
drive the real code path — including its failure branches, which is the
point: `failures` is a per-table queue of exceptions consumed one call at a
time, so a test can fail the first user's query and let the second through.
"""

from pydantic import BaseModel, ValidationError

GATEWAY_TIMEOUT_BODY = {"message": "Gateway Timeout"}


def validation_error_like_postgrest() -> ValidationError:
    """The exact shape older postgrest-py leaks on a Supabase 504: a pydantic
    parse failure over the proxy's bodiless error JSON, not an APIError. Built
    by actually failing a validation rather than hand-rolling one, so it stays
    a real ValidationError with real error entries."""

    class APIErrorFromJSON(BaseModel):
        message: str | None
        code: str | None
        hint: str | None
        details: str | None

    try:
        APIErrorFromJSON(**GATEWAY_TIMEOUT_BODY)
    except ValidationError as exc:
        return exc
    raise AssertionError("expected the bodiless 504 payload to fail validation")


class Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, table, client):
        self._table = table
        self._client = client
        self._pending = None  # the write this chain will perform, if any

    def update(self, payload, *_args, **_kwargs):
        self._pending = ("update", payload)
        return self

    def insert(self, payload, *_args, **_kwargs):
        self._pending = ("insert", payload)
        return self

    def upsert(self, payload, *_args, **_kwargs):
        self._pending = ("upsert", payload)
        return self

    def __getattr__(self, _name):
        def _chain(*_args, **_kwargs):
            return self

        return _chain

    # `.not_.is_(...)` (pet_scheduler's discover_recipe_id filter) reads an
    # attribute rather than calling one, so plain __getattr__ chaining isn't
    # enough on its own — return self for that too.
    @property
    def not_(self):
        return self

    def execute(self):
        return self._client._execute(self._table, self._pending)


class FakeSupabase:
    def __init__(self, rows=None, failures=None):
        self.rows = rows or {}
        self.failures = {table: list(queue) for table, queue in (failures or {}).items()}
        self.calls = []
        self.writes = []  # (table, op, payload) per write that actually landed

    def table(self, name):
        return _Query(name, self)

    def _execute(self, table, pending=None):
        self.calls.append(table)
        queue = self.failures.get(table)
        if queue:
            failure = queue.pop(0)
            if failure is not None:
                raise failure
        if pending is not None:
            self.writes.append((table, pending[0], pending[1]))
        return Result(self.rows.get(table, []))

    def written(self, table, op=None):
        return [payload for t, o, payload in self.writes if t == table and (op is None or o == op)]
