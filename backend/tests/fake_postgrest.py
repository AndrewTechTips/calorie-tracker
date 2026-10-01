"""An in-memory stand-in for supabase-py that, unlike tests/fake_supabase.py,
actually APPLIES the filters a query builds (eq / in_ / gte / lte /
not_.is_ null / limit / maybe_single) and the writes it performs
(insert / update / upsert).

fake_supabase.FakeSupabase returns every row of a table for any query, which
is exactly right for its job — injecting failures into a sweep — but cannot
tell a correct batched read from a wrong one. This one can, so a test can
run two implementations over the same data and compare what each wrote.
Every executed query is recorded in `reads` / `writes` per table.
"""

import copy
from collections import Counter


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db: "FakePostgrest", table: str):
        self._db = db
        self._table = table
        self._filters = []
        self._negate_next = False
        self._limit = None
        self._single = False
        self._op = "select"
        self._payload = None
        self._on_conflict = None

    # --- reads -------------------------------------------------------------
    def select(self, *_args, **_kwargs):
        return self

    def eq(self, column, value):
        self._filters.append(lambda row: row.get(column) == value)
        return self

    def in_(self, column, values):
        allowed = set(values)
        self._filters.append(lambda row: row.get(column) in allowed)
        return self

    def gte(self, column, value):
        self._filters.append(lambda row: row.get(column) is not None and row.get(column) >= value)
        return self

    def lte(self, column, value):
        self._filters.append(lambda row: row.get(column) is not None and row.get(column) <= value)
        return self

    @property
    def not_(self):
        self._negate_next = True
        return self

    def is_(self, column, value):
        assert value == "null", "only IS [NOT] NULL is supported"
        negate = self._negate_next
        self._negate_next = False
        self._filters.append(lambda row: (row.get(column) is None) != negate)
        return self

    def limit(self, count):
        self._limit = count
        return self

    def maybe_single(self):
        self._single = True
        return self

    # --- writes ------------------------------------------------------------
    def insert(self, payload, *_args, **_kwargs):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload, *_args, **_kwargs):
        self._op, self._payload = "update", payload
        return self

    def upsert(self, payload, *_args, on_conflict=None, **_kwargs):
        self._op, self._payload, self._on_conflict = "upsert", payload, on_conflict
        return self

    def execute(self):
        rows = self._db.tables.setdefault(self._table, [])
        matching = [row for row in rows if all(f(row) for f in self._filters)]
        if self._op == "select":
            self._db.reads[self._table] += 1
            if self._limit is not None:
                matching = matching[: self._limit]
            if self._single:
                return _Result(copy.deepcopy(matching[0])) if matching else None
            return _Result(copy.deepcopy(matching))

        self._db.writes[self._table] += 1
        if self._op == "insert":
            rows.append(copy.deepcopy(self._payload))
            return _Result([copy.deepcopy(self._payload)])
        if self._op == "update":
            for row in matching:
                row.update(copy.deepcopy(self._payload))
            return _Result(copy.deepcopy(matching))
        # upsert
        key = self._on_conflict
        existing = next((row for row in rows if row.get(key) == self._payload.get(key)), None)
        if existing is None:
            rows.append(copy.deepcopy(self._payload))
            return _Result([copy.deepcopy(self._payload)])
        existing.update(copy.deepcopy(self._payload))
        return _Result([copy.deepcopy(existing)])


class FakePostgrest:
    def __init__(self, tables: dict[str, list[dict]] | None = None):
        self.tables = copy.deepcopy(tables or {})
        self.reads: Counter = Counter()
        self.writes: Counter = Counter()

    def table(self, name: str) -> _Query:
        return _Query(self, name)
