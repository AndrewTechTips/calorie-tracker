"""Phase 0.1 — POST /workouts/sessions/{id}/sets must not re-read what it just wrote.

Logging a set is the hottest write path in this app: one call per set, several
per rest period, dozens per session, from a phone on gym wifi. Every Supabase
query in it crosses the public internet on a 10s httpx timeout (database.py),
so the number of times the request *waits* is the whole user-visible cost.

It used to wait six times, sequentially:

    1. _fetch_session_or_404          (ownership check)
    2. _fetch_sets                    (to compute set_number)
    3. insert the set
    4. _fetch_sets AGAIN              <- inside _recompute_and_save
    5. _get_latest_weight_kg          <- inside _recompute_and_save
    6. update the session's calories  <- inside _recompute_and_save

Two of those are pure waste: (4) re-reads a table the request just wrote to,
when (2) plus the insert's own returned row already say exactly what is in it.
And (1)/(2)/(5) are mutually independent, so waiting for them one at a time
bought nothing either.

Now: one concurrent gather for the three reads, the insert, one update — three
waits, five queries. This file pins BOTH halves of that, because either one
could regress silently and neither shows up as a failing feature:

  * the query COUNT and ORDER (a reintroduced post-insert read of workout_sets
    is the specific regression to catch), and
  * that the answer is byte-identical to what the old sequential path computed,
    since a latency fix that changes a persisted calorie figure is not a
    latency fix. Every calorie assertion here is computed by calling
    workout_service directly rather than hardcoding a number, so the test
    tracks the real formula instead of pinning a snapshot of it.

Driven through the REAL route (a minimal app holding only this router) rather
than by calling the handler, because the thing under test is partly the
decorator stack's behaviour — `_503_if_not_migrated` and the rate limiter both
wrap it.
"""

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

import routers.workouts as workouts
from auth import get_current_user
from rate_limit import limiter
from services import workout_service

SESSION_ID = "11111111-1111-4111-8111-111111111111"
USER_ID = "22222222-2222-4222-8222-222222222222"
BODYWEIGHT_KG = 82.5


# ---------------------------------------------------------------------------
# A supabase stand-in that models the two things this router depends on and
# tests/fake_supabase.py deliberately does not: `.maybe_single()` answering a
# single dict rather than a list, and an insert/update handing back the row it
# wrote. Kept local to this file rather than bolted onto the shared fake — the
# three sweep-resilience suites depend on that one's exact shape, and widening
# it to serve this test would put their coverage at the mercy of this one.
# ---------------------------------------------------------------------------
class FakeQuery:
    def __init__(self, table, client):
        self._table = table
        self._client = client
        self._op = "select"
        self._payload = None
        self._single = False

    def insert(self, payload, *_a, **_k):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload, *_a, **_k):
        self._op, self._payload = "update", payload
        return self

    def delete(self, *_a, **_k):
        self._op = "delete"
        return self

    def maybe_single(self, *_a, **_k):
        self._single = True
        return self

    def __getattr__(self, _name):
        # select / eq / order / limit / in_ / gte / lte — filters this fake
        # ignores on purpose; it answers per-table, not per-predicate.
        def _chain(*_a, **_k):
            return self
        return _chain

    def execute(self):
        return self._client._execute(self._table, self._op, self._payload, self._single)


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    """Records one (table, op) entry per execute(), in call order."""

    def __init__(self, *, session, sets, weight_rows=None, insert_returns_row=True, fail=None):
        self.session = dict(session)
        self.sets = [dict(s) for s in sets]
        self.weight_rows = weight_rows if weight_rows is not None else [{"weight_kg": BODYWEIGHT_KG}]
        self.insert_returns_row = insert_returns_row
        self.fail = fail or {}
        self.calls = []          # [(table, op)] in order
        self.writes = []         # [(table, op, payload)]
        self._next_set_id = 900

    def table(self, name):
        return FakeQuery(name, self)

    def _execute(self, table, op, payload, single):
        self.calls.append((table, op))
        if table in self.fail:
            raise self.fail[table]

        if op in ("insert", "update", "delete"):
            self.writes.append((table, op, payload))

        if table == "workout_sessions":
            if op == "select":
                return FakeResult(self.session if single else [self.session])
            if op == "update":
                self.session.update(payload)
                return FakeResult([self.session])
            if op == "delete":
                return FakeResult([self.session])
        if table == "workout_sets":
            if op == "select":
                return FakeResult(list(self.sets))
            if op == "insert":
                self._next_set_id += 1
                row = {
                    **payload,
                    "id": f"set-{self._next_set_id}",
                    "logged_at": "2026-09-28T10:00:00+00:00",
                    "created_at": "2026-09-28T10:00:00+00:00",
                }
                self.sets.append(row)
                return FakeResult([row] if self.insert_returns_row else [])
        if table == "weight_logs":
            return FakeResult(list(self.weight_rows))
        return FakeResult([])

    # -- assertions helpers -------------------------------------------------
    def selects_of(self, table):
        return [c for c in self.calls if c == (table, "select")]


def make_session(**over):
    row = {
        "id": SESSION_ID,
        "user_id": USER_ID,
        "session_date": "2026-09-28",
        "name": "Push Day",
        "started_at": "2026-09-28T09:00:00+00:00",
        "ended_at": None,
        "notes": None,
        "calories_burned": None,
        "created_at": "2026-09-28T09:00:00+00:00",
        "updated_at": "2026-09-28T09:00:00+00:00",
    }
    row.update(over)
    return row


def make_set(n, exercise="Barbell Bench Press", category="Chest", reps=8, weight=80.0, rpe=7):
    return {
        "id": f"existing-{n}",
        "user_id": USER_ID,
        "session_id": SESSION_ID,
        "exercise_name": exercise,
        "category": category,
        "set_number": n,
        "reps": reps,
        "weight_kg": weight,
        "rpe": rpe,
        "logged_at": "2026-09-28T09:30:00+00:00",
        "created_at": "2026-09-28T09:30:00+00:00",
    }


class FakeUser:
    id = USER_ID


@pytest.fixture
def client(monkeypatch):
    """A minimal app holding only the workouts router — main.py's own app warms
    the embedding model in its lifespan and wires every other router, none of
    which this test needs."""
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(workouts.router)
    app.dependency_overrides[get_current_user] = lambda: FakeUser()

    was_enabled = limiter.enabled
    limiter.enabled = False  # the ceiling itself is covered by tests/test_quota_service.py

    holder = {}

    def _install(fake):
        monkeypatch.setattr(workouts, "get_supabase", lambda: fake)
        holder["fake"] = fake
        return fake

    with TestClient(app) as c:
        c.install = _install
        c.holder = holder
        yield c

    limiter.enabled = was_enabled


ADD_SET_BODY = {"exercise_name": "Barbell Bench Press", "category": "Chest", "reps": 8, "weight_kg": 80.0, "rpe": 8}


def post_set(client, fake, body=None):
    client.install(fake)
    return client.post(f"/workouts/sessions/{SESSION_ID}/sets", json=body or ADD_SET_BODY)


# ---------------------------------------------------------------------------
# The count itself
# ---------------------------------------------------------------------------
def test_add_set_makes_exactly_five_queries(client):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1), make_set(2)])
    resp = post_set(client, fake)
    assert resp.status_code == 201, resp.text
    assert len(fake.calls) == 5, f"expected 5 queries, got {len(fake.calls)}: {fake.calls}"


def test_add_set_does_not_re_read_workout_sets_after_inserting(client):
    """THE regression this file exists for. `_recompute_and_save` used to call
    `_fetch_sets` a second time, after the insert — so workout_sets was SELECTed
    twice per logged set, the second time to learn something the insert had just
    returned. Exactly one select of that table is correct; two means the
    duplicate is back."""
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)])
    assert post_set(client, fake).status_code == 201
    assert len(fake.selects_of("workout_sets")) == 1, (
        f"workout_sets was selected more than once: {fake.calls}"
    )
    # And specifically: nothing is read at all after the write begins.
    insert_at = fake.calls.index(("workout_sets", "insert"))
    reads_after_insert = [c for c in fake.calls[insert_at:] if c[1] == "select"]
    assert reads_after_insert == [], f"reads after the insert: {reads_after_insert}"


def test_add_set_query_order_is_reads_then_insert_then_one_update(client):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)])
    assert post_set(client, fake).status_code == 201
    ops = fake.calls
    assert [c[1] for c in ops] == ["select", "select", "select", "insert", "update"], ops
    assert ops[-1] == ("workout_sessions", "update")
    assert sorted(c[0] for c in ops[:3]) == ["weight_logs", "workout_sessions", "workout_sets"]


def test_bodyweight_is_read_once_not_per_set(client):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)])
    assert post_set(client, fake).status_code == 201
    assert len(fake.selects_of("weight_logs")) == 1, fake.calls


# ---------------------------------------------------------------------------
# Behaviour neutrality — the fix must not move a single number
# ---------------------------------------------------------------------------
def test_response_contains_the_newly_inserted_set(client):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1), make_set(2)])
    body = post_set(client, fake).json()
    assert len(body["sets"]) == 3
    assert [s["set_number"] for s in body["sets"]] == [1, 2, 3]


def test_set_number_continues_per_exercise_not_per_session(client):
    """Unchanged semantics: numbering is scoped to the exercise name, so a new
    movement starts at 1 even in a session that already has sets."""
    fake = FakeSupabase(session=make_session(), sets=[make_set(1), make_set(2)])
    body = post_set(client, fake, {**ADD_SET_BODY, "exercise_name": "Overhead Press", "category": "Shoulders"}).json()
    new = [s for s in body["sets"] if s["exercise_name"] == "Overhead Press"]
    assert len(new) == 1 and new[0]["set_number"] == 1


def test_set_number_is_case_insensitive_on_exercise_name(client):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1, exercise="Barbell Bench Press")])
    body = post_set(client, fake, {**ADD_SET_BODY, "exercise_name": "barbell BENCH press"}).json()
    numbers = sorted(s["set_number"] for s in body["sets"])
    assert numbers == [1, 2]


def test_persisted_calories_match_the_real_formula_over_all_sets(client):
    """The number written to workout_sessions.calories_burned must be what
    workout_service produces from the FULL set list including the new one —
    computed here by calling that module, not by pinning a literal, so this
    keeps tracking the formula if the MET table or RPE scale is ever retuned."""
    existing = [make_set(1, rpe=7), make_set(2, rpe=9)]
    fake = FakeSupabase(session=make_session(), sets=existing)
    resp = post_set(client, fake)
    assert resp.status_code == 201

    all_sets = existing + [{"category": "Chest", "rpe": 8}]
    expected = workout_service.estimate_session_calories(
        all_sets,
        BODYWEIGHT_KG,
        workout_service.estimate_session_duration_hours(
            started_at="2026-09-28T09:00:00+00:00", ended_at=None, set_count=len(all_sets)
        ),
    )
    written = [p for t, o, p in fake.writes if t == "workout_sessions" and o == "update"]
    assert written and written[-1]["calories_burned"] == pytest.approx(expected)
    assert resp.json()["calories_burned"] == pytest.approx(expected)


def test_missing_weight_log_falls_back_to_the_default_bodyweight(client):
    """Unchanged: a user who has never logged a weight still gets an estimate
    rather than a zero (workout_service.DEFAULT_BODYWEIGHT_KG)."""
    fake = FakeSupabase(session=make_session(), sets=[], weight_rows=[])
    resp = post_set(client, fake)
    assert resp.status_code == 201
    expected = workout_service.estimate_session_calories(
        [{"category": "Chest", "rpe": 8}],
        workout_service.DEFAULT_BODYWEIGHT_KG,
        workout_service.estimate_session_duration_hours(
            started_at="2026-09-28T09:00:00+00:00", ended_at=None, set_count=1
        ),
    )
    assert resp.json()["calories_burned"] == pytest.approx(expected)
    assert expected > 0


def test_a_finished_session_still_prices_on_real_elapsed_time(client):
    """The in-progress estimate uses set_count x 90s; a session with ended_at
    uses real elapsed time. Handing the set list in must not change which
    branch runs."""
    fake = FakeSupabase(
        session=make_session(started_at="2026-09-28T09:00:00+00:00", ended_at="2026-09-28T10:00:00+00:00"),
        sets=[make_set(1)],
    )
    resp = post_set(client, fake)
    all_sets = [make_set(1), {"category": "Chest", "rpe": 8}]
    expected = workout_service.estimate_session_calories(all_sets, BODYWEIGHT_KG, 1.0)
    assert resp.json()["calories_burned"] == pytest.approx(expected)


# ---------------------------------------------------------------------------
# Degradation — the optimisation must never be the thing that breaks a write
# ---------------------------------------------------------------------------
def test_falls_back_to_a_fetch_if_the_insert_returns_no_row(client):
    """The fast path reads the inserted row out of the insert's own response.
    If a client/PostgREST configuration ever stops returning it, the session
    must still come back correctly priced — one extra read, not a 500 and not a
    silently-empty set list."""
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)], insert_returns_row=False)
    resp = post_set(client, fake)
    assert resp.status_code == 201, resp.text
    assert len(fake.selects_of("workout_sets")) == 2, "expected the fallback re-read"
    # The set still landed and is still counted.
    assert len(resp.json()["sets"]) == 2
    assert resp.json()["calories_burned"] > 0


def test_a_session_belonging_to_someone_else_is_still_404(client):
    """The ownership check moved into a gather; it must still be the thing that
    decides the status code, and no set may be written."""
    fake = FakeSupabase(session=make_session(), sets=[])
    fake.session = None  # maybe_single finds nothing
    client.install(fake)
    resp = client.post(f"/workouts/sessions/{SESSION_ID}/sets", json=ADD_SET_BODY)
    assert resp.status_code == 404
    assert [w for w in fake.writes if w[0] == "workout_sets"] == []


def test_an_unmigrated_project_still_answers_503_not_500(client):
    """_503_if_not_migrated sits under the rate limiter and over the handler;
    a gather raising from inside must still reach it."""
    err = APIError({"code": "42P01", "message": 'relation "workout_sets" does not exist'})
    fake = FakeSupabase(session=make_session(), sets=[], fail={"workout_sets": err})
    resp = post_set(client, fake)
    assert resp.status_code == 503
    assert "database update" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# _recompute_and_save's own contract, independent of the route
# ---------------------------------------------------------------------------
def test_recompute_uses_handed_in_values_without_reading_anything(monkeypatch):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)])
    session = make_session()
    sets = [make_set(1), make_set(2)]
    out = asyncio.run(
        workouts._recompute_and_save(fake, session, USER_ID, sets=sets, weight_kg=90.0)
    )
    assert fake.selects_of("workout_sets") == []
    assert fake.selects_of("weight_logs") == []
    assert [c[1] for c in fake.calls] == ["update"]
    expected = workout_service.estimate_session_calories(
        sets, 90.0, workout_service.estimate_session_duration_hours(
            started_at=session["started_at"], ended_at=None, set_count=2
        )
    )
    assert out["calories_burned"] == pytest.approx(expected)


def test_recompute_still_fetches_both_when_handed_neither(monkeypatch):
    """update_set / delete_set / finish have nothing to hand in and must keep
    working exactly as before."""
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)])
    out = asyncio.run(workouts._recompute_and_save(fake, make_session(), USER_ID))
    assert len(fake.selects_of("workout_sets")) == 1
    assert len(fake.selects_of("weight_logs")) == 1
    assert out["calories_burned"] > 0
