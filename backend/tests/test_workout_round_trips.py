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
from services import analytics_service, cardio_service, workout_service

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

    def __init__(self, *, session, sets, weight_rows=None, insert_returns_row=True, fail=None, cardio=None, profile=None):
        self.session = dict(session)
        self.sets = [dict(s) for s in sets]
        self.cardio = [dict(c) for c in (cardio or [])]
        # Phase 5.2: the resting subtraction reads the user's biometrics.
        # `None` models a user who has never opened the target calculator,
        # which is calculate_bmr's weight-only branch.
        self.profile = dict(profile) if profile else None
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
            if op == "insert":
                # create_session's own path (the "Move it" shortcut) — the row
                # comes back with the ids the database would have assigned.
                self.session = {**make_session(), **payload, "id": SESSION_ID}
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
        if table == "cardio_sessions":
            if op == "select":
                return FakeResult(self.cardio[0] if (single and self.cardio) else (None if single else list(self.cardio)))
            if op == "insert":
                added = payload if isinstance(payload, list) else [payload]
                for i, row in enumerate(added):
                    self.cardio.append({**row, "id": f"cardio-{len(self.cardio) + i}",
                                        "created_at": "2026-09-28T10:00:00+00:00"})
                return FakeResult(list(self.cardio))
            if op == "update":
                for row in self.cardio:
                    row.update(payload)
                return FakeResult(list(self.cardio))
            if op == "delete":
                removed = self.cardio[:1]
                self.cardio = self.cardio[1:]
                return FakeResult(removed)
        if table == "weight_logs":
            return FakeResult(list(self.weight_rows))
        if table == "profiles":
            return FakeResult(self.profile if single else ([self.profile] if self.profile else []))
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


def expected_session_kcal(sets, weight_kg, *, started_at, ended_at=None, cardio=(), profile=None):
    """What routers/workouts.py must persist, re-derived here from
    workout_service/analytics_service's own public functions rather than from a
    literal — the discipline this file has always used, now covering Phase 5's
    three corrections as well as the MET table it already tracked.

    It is deliberately a RE-DERIVATION, not a copy of the router: what it pins
    is the COMPOSITION (density applied, resting subtracted once, cardio folded
    in net), which is the part a refactor can silently drop. The magnitudes
    themselves are pinned against hand arithmetic in tests/test_workout_service.py,
    where they can be checked without a fake database in the way.
    """
    measured = bool(started_at and ended_at)
    duration_hours = workout_service.estimate_session_duration_hours(
        started_at=started_at, ended_at=ended_at, set_count=len(sets)
    )
    cardio_minutes = sum(float(c.get("duration_minutes") or 0) for c in cardio)
    strength_hours = workout_service.strength_duration_hours(
        duration_hours, cardio_minutes, measured_duration=measured
    )
    bmr = analytics_service.calculate_bmr(
        weight_kg,
        age=(profile or {}).get("age"),
        height_cm=(profile or {}).get("height_cm"),
        sex=(profile or {}).get("biological_sex"),
    )
    energy = workout_service.session_energy(
        sets, weight_kg, strength_hours, measured_duration=measured, bmr_kcal_per_day=bmr
    )
    cardio_kcal = sum(float(c.get("calories_burned") or 0) for c in cardio)
    return round(energy.net + cardio_kcal, 1)


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
def test_add_set_waits_three_times(client):
    """Phase 3 added a fourth read — the cardio already logged against this
    session, without which a set change would erase it from the cached total.
    Query count went 5 -> 6; the number of times the request WAITS, which is the
    only part a user feels, stayed at three:

        wait 1: session + sets + bodyweight + cardio, concurrently
        wait 2: insert the set
        wait 3: update the session's calories

    This asserts the waits, not the count, because the count is an
    implementation detail and the waits are the thing Phase 0.1 bought."""
    fake = FakeSupabase(session=make_session(), sets=[make_set(1), make_set(2)])
    resp = post_set(client, fake)
    assert resp.status_code == 201, resp.text

    ops = [op for _table, op in fake.calls]
    first_write = next(i for i, op in enumerate(ops) if op != "select")
    reads_up_front, rest = ops[:first_write], ops[first_write:]
    assert set(reads_up_front) == {"select"}, fake.calls
    # Five since Phase 5: the profile the resting subtraction needs joined the
    # gather. The number that matters is unchanged — they are still CONCURRENT,
    # so the request still waits three times, which is the only thing a user
    # can feel. A sixth read appearing here is fine; a read appearing AFTER the
    # first write is not, and that is what the next assertion catches.
    assert len(reads_up_front) == 5, f"expected 5 concurrent reads, got {reads_up_front}: {fake.calls}"
    # Nothing is read again once writing starts — that is what makes the rest a
    # straight line of two waits rather than a read/write interleave.
    assert "select" not in rest, f"a read happened after the first write: {fake.calls}"
    assert rest == ["insert", "update"], fake.calls
    assert len(fake.calls) == 7


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
    assert [c[1] for c in ops] == ["select"] * 5 + ["insert", "update"], ops
    assert ops[-1] == ("workout_sessions", "update")
    assert sorted(c[0] for c in ops[:5]) == [
        "cardio_sessions",
        "profiles",
        "weight_logs",
        "workout_sessions",
        "workout_sets",
    ]


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
    expected = expected_session_kcal(all_sets, BODYWEIGHT_KG, started_at="2026-09-28T09:00:00+00:00")
    written = [p for t, o, p in fake.writes if t == "workout_sessions" and o == "update"]
    assert written and written[-1]["calories_burned"] == pytest.approx(expected)
    assert resp.json()["calories_burned"] == pytest.approx(expected)


def test_missing_weight_log_falls_back_to_the_default_bodyweight(client):
    """Unchanged: a user who has never logged a weight still gets an estimate
    rather than a zero (workout_service.DEFAULT_BODYWEIGHT_KG)."""
    fake = FakeSupabase(session=make_session(), sets=[], weight_rows=[])
    resp = post_set(client, fake)
    assert resp.status_code == 201
    expected = expected_session_kcal(
        [{"category": "Chest", "rpe": 8}],
        workout_service.DEFAULT_BODYWEIGHT_KG,
        started_at="2026-09-28T09:00:00+00:00",
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
    expected = expected_session_kcal(
        all_sets,
        BODYWEIGHT_KG,
        started_at="2026-09-28T09:00:00+00:00",
        ended_at="2026-09-28T10:00:00+00:00",
    )
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
        workouts._recompute_and_save(fake, session, USER_ID, sets=sets, weight_kg=90.0, cardio=[], profile={})
    )
    assert fake.selects_of("workout_sets") == []
    assert fake.selects_of("weight_logs") == []
    assert fake.selects_of("cardio_sessions") == []
    assert fake.selects_of("profiles") == []
    assert [c[1] for c in fake.calls] == ["update"]
    expected = expected_session_kcal(sets, 90.0, started_at=session["started_at"])
    assert out["calories_burned"] == pytest.approx(expected)


def test_recompute_still_fetches_both_when_handed_neither(monkeypatch):
    """update_set / delete_set / finish have nothing to hand in and must keep
    working exactly as before."""
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)])
    out = asyncio.run(workouts._recompute_and_save(fake, make_session(), USER_ID))
    assert len(fake.selects_of("workout_sets")) == 1
    assert len(fake.selects_of("weight_logs")) == 1
    assert len(fake.selects_of("cardio_sessions")) == 1
    assert len(fake.selects_of("profiles")) == 1
    assert out["calories_burned"] > 0


# ---------------------------------------------------------------------------
# Phase 3.3 — the cardio routes
# ---------------------------------------------------------------------------
CARDIO_BODY = {
    "segments": [{"machine": "treadmill", "params": {"speed_kmh": 6.0, "incline_percent": 8.0}, "duration_minutes": 32}],
    "net": True,
}


def post_cardio(client, fake, body=None):
    client.install(fake)
    return client.post(f"/workouts/sessions/{SESSION_ID}/cardio", json=body or CARDIO_BODY)


def test_cardio_is_priced_by_the_equation_not_a_flat_met(client):
    """The figure written must be cardio_service's, and it must carry the
    equation that produced it — that provenance is the whole point of the
    column existing."""
    from services import cardio_service

    fake = FakeSupabase(session=make_session(), sets=[])
    resp = post_cardio(client, fake)
    assert resp.status_code == 201, resp.text

    expected = cardio_service.estimate_cardio(
        "treadmill", {"speed_kmh": 6.0, "incline_percent": 8.0}, BODYWEIGHT_KG, 32, net=True
    )
    written = [p for tbl, op, p in fake.writes if tbl == "cardio_sessions" and op == "insert"][0][0]
    assert written["calories_burned"] == pytest.approx(expected.kcal)
    assert written["equation_id"] == "acsm_walking"
    assert written["is_estimate"] is False


def test_cardio_lands_in_the_sessions_cached_total(client):
    fake = FakeSupabase(session=make_session(), sets=[])
    body = post_cardio(client, fake).json()
    assert body["calories_burned"] > 0
    assert len(body["cardio"]) == 1
    assert body["cardio"][0]["machine"] == "treadmill"


def test_a_session_with_both_sums_strength_and_cardio(client):
    """A lift plus a finisher on the bike is one session, and its burn is both.
    Logging a set must not erase the cardio already on it."""
    from services import cardio_service

    existing_cardio = [{
        "id": "c1", "session_id": SESSION_ID, "user_id": USER_ID, "machine": "bike",
        "params": {"watts": 120}, "duration_minutes": 20, "calories_burned": 180.0,
        "equation_id": "acsm_leg_ergometry", "is_estimate": False,
        "logged_at": "2026-09-28T09:40:00+00:00", "created_at": "2026-09-28T09:40:00+00:00",
    }]
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)], cardio=existing_cardio)
    resp = post_set(client, fake)
    assert resp.status_code == 201

    all_sets = [make_set(1), {"category": "Chest", "rpe": 8}]
    expected = expected_session_kcal(
        all_sets, BODYWEIGHT_KG, started_at="2026-09-28T09:00:00+00:00", cardio=existing_cardio
    )
    assert resp.json()["calories_burned"] == pytest.approx(expected)
    # The cardio is still counted in full: it was stored net (Phase 5), so it
    # folds into a net session total unchanged.
    assert expected > 180.0
    # ...and the cardio is still attached, not dropped by the set write.
    assert len(resp.json()["cardio"]) == 1


def test_segments_are_priced_independently_and_summed(client):
    """Averaging a warm-up with the work would understate the session — which
    is the entire reason segments exist rather than one duration and one pace."""
    from services import cardio_service

    body = {
        "segments": [
            {"machine": "treadmill", "params": {"speed_kmh": 5.0, "incline_percent": 0.0}, "duration_minutes": 5},
            {"machine": "treadmill", "params": {"speed_kmh": 6.0, "incline_percent": 10.0}, "duration_minutes": 20},
            {"machine": "treadmill", "params": {"speed_kmh": 4.0, "incline_percent": 0.0}, "duration_minutes": 5},
        ],
        "net": True,
    }
    fake = FakeSupabase(session=make_session(), sets=[])
    resp = post_cardio(client, fake, body)
    assert resp.status_code == 201

    rows = [p for tbl, op, p in fake.writes if tbl == "cardio_sessions" and op == "insert"][0]
    assert len(rows) == 3
    expected_total = sum(
        cardio_service.estimate_cardio(s["machine"], s["params"], BODYWEIGHT_KG, s["duration_minutes"], net=True).kcal
        for s in body["segments"]
    )
    assert sum(r["calories_burned"] for r in rows) == pytest.approx(expected_total)

    # The averaged-instead-of-summed version is materially different, which is
    # what makes summing worth asserting rather than assuming.
    averaged = cardio_service.estimate_cardio(
        "treadmill", {"speed_kmh": 5.0, "incline_percent": 3.33}, BODYWEIGHT_KG, 30, net=True
    ).kcal
    assert abs(expected_total - averaged) > 20


def test_each_segment_keeps_its_own_provenance(client):
    """A treadmill interval priced by a validated equation and an elliptical
    stretch priced from a MET band must not be presented as equally certain."""
    body = {
        "segments": [
            {"machine": "treadmill", "params": {"speed_kmh": 6.0, "incline_percent": 5.0}, "duration_minutes": 20},
            {"machine": "elliptical", "params": {"resistance": 10}, "duration_minutes": 10},
        ],
        "net": True,
    }
    fake = FakeSupabase(session=make_session(), sets=[])
    assert post_cardio(client, fake, body).status_code == 201
    rows = [p for tbl, op, p in fake.writes if tbl == "cardio_sessions" and op == "insert"][0]
    assert rows[0]["equation_id"] == "acsm_walking" and rows[0]["is_estimate"] is False
    assert rows[1]["equation_id"] == "met_band_elliptical" and rows[1]["is_estimate"] is True


def test_net_is_the_default_and_gross_is_opt_in(client):
    fake_net = FakeSupabase(session=make_session(), sets=[])
    post_cardio(client, fake_net, {"segments": CARDIO_BODY["segments"]})  # `net` omitted
    net_kcal = [p for tbl, op, p in fake_net.writes if tbl == "cardio_sessions"][0][0]["calories_burned"]

    fake_gross = FakeSupabase(session=make_session(), sets=[])
    post_cardio(client, fake_gross, {**CARDIO_BODY, "net": False})
    gross_kcal = [p for tbl, op, p in fake_gross.writes if tbl == "cardio_sessions"][0][0]["calories_burned"]

    assert net_kcal < gross_kcal, "net must be the smaller, honest figure"


def test_bodyweight_is_read_once_for_the_whole_request(client):
    """Not once per segment — it cannot change between a warm-up and a
    cool-down, and per-segment reads would be one round trip per interval."""
    body = {"segments": [dict(CARDIO_BODY["segments"][0]) for _ in range(5)], "net": True}
    fake = FakeSupabase(session=make_session(), sets=[])
    assert post_cardio(client, fake, body).status_code == 201
    assert len(fake.selects_of("weight_logs")) == 1, fake.calls


def test_cardio_against_someone_elses_session_is_404(client):
    fake = FakeSupabase(session=make_session(), sets=[])
    fake.session = None
    client.install(fake)
    resp = client.post(f"/workouts/sessions/{SESSION_ID}/cardio", json=CARDIO_BODY)
    assert resp.status_code == 404
    assert [w for w in fake.writes if w[0] == "cardio_sessions"] == []


def test_an_unmigrated_project_gets_503_from_the_cardio_route(client):
    err = APIError({"code": "42P01", "message": 'relation "cardio_sessions" does not exist'})
    fake = FakeSupabase(session=make_session(), sets=[], fail={"cardio_sessions": err})
    resp = post_cardio(client, fake)
    assert resp.status_code == 503
    assert "database update" in resp.json()["detail"]


def test_an_unmigrated_project_can_still_read_sessions(client):
    """The READ path is tolerant where the WRITE path is loud: a project that
    has not run the migration must still be able to open its diary, or the
    newest optional feature would take the whole feature down with it."""
    err = APIError({"code": "42P01", "message": 'relation "cardio_sessions" does not exist'})
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)], fail={"cardio_sessions": err})
    client.install(fake)
    resp = client.get(f"/workouts/sessions/{SESSION_ID}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["cardio"] == []
    assert len(resp.json()["sets"]) == 1


def test_deleting_cardio_returns_the_recomputed_session(client):
    existing = [{
        "id": "c1", "session_id": SESSION_ID, "user_id": USER_ID, "machine": "rower",
        "params": {"split_seconds": 120}, "duration_minutes": 20, "calories_burned": 250.0,
        "equation_id": "concept2_split_to_watts", "is_estimate": True,
        "logged_at": "2026-09-28T09:40:00+00:00", "created_at": "2026-09-28T09:40:00+00:00",
    }]
    fake = FakeSupabase(session=make_session(), sets=[], cardio=existing)
    client.install(fake)
    resp = client.delete("/workouts/cardio/c1")
    assert resp.status_code == 200, resp.text
    assert resp.json()["cardio"] == []
    assert resp.json()["calories_burned"] == pytest.approx(0.0)


def test_deleting_a_cardio_entry_that_is_not_yours_is_404(client):
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[])
    client.install(fake)
    assert client.delete("/workouts/cardio/nope").status_code == 404


# ---------------------------------------------------------------------------
# Phase 3.6 — Damage Control's "Move it" must keep working, unchanged
# ---------------------------------------------------------------------------
def test_move_it_still_creates_a_priced_session_from_free_text(client):
    """js/damageControl.js posts an activity NAME and a duration, with no
    machine and no console readings — there is nothing to apply an equation to.
    That path is deliberately untouched by Phase 3: it still goes through
    workout_service's flat MET table, which is the right tool when the only
    information available is the word."""
    fake = FakeSupabase(session=make_session(), sets=[], weight_rows=[{"weight_kg": 70.0}])
    client.install(fake)
    resp = client.post("/workouts/sessions", json={"activity": "brisk walk", "duration_minutes": 25})
    assert resp.status_code == 201, resp.text

    gross = workout_service.estimate_cardio_calories("brisk walk", 25, 70.0)
    # Phase 5.2: stored NET, like every other burn figure — still priced from
    # workout_service's flat MET table, which is Phase 3.6's own guarantee.
    expected = round(
        gross - workout_service.resting_kcal(analytics_service.calculate_bmr(70.0), 25 / 60.0), 1
    )
    written = [p for tbl, op, p in fake.writes if tbl == "workout_sessions" and op == "insert"][0]
    assert written["calories_burned"] == pytest.approx(expected)
    assert 0 < expected < gross
    assert written["name"] == "brisk walk"
    # It arrives complete: started_at..ended_at span the real activity, so it
    # needs no "Finish workout" step and shows on the dashboard immediately.
    assert written["started_at"] and written["ended_at"]


# ---------------------------------------------------------------------------
# Phase 5 — the honest-numbers corrections, at the route level
# ---------------------------------------------------------------------------
def _cardio_row(**over):
    row = {
        "id": "c1", "session_id": SESSION_ID, "user_id": USER_ID, "machine": "bike",
        "params": {"watts": 120}, "duration_minutes": 20, "calories_burned": 180.0,
        "equation_id": "acsm_leg_ergometry", "is_estimate": False, "basis": "net",
        "logged_at": "2026-09-28T09:40:00+00:00", "created_at": "2026-09-28T09:40:00+00:00",
    }
    row.update(over)
    return row


def test_the_stored_figure_is_net_and_is_smaller_than_the_old_gross_one(client):
    """Phase 5.2's user-visible consequence, asserted rather than implied: the
    number this app stores today is strictly below the number it stored
    yesterday for the identical session. Anyone reading this test after a user
    asks why their burn dropped is in the right place — the magnitude is in
    CLAUDE.md."""
    fake = FakeSupabase(
        session=make_session(started_at="2026-09-28T09:00:00+00:00", ended_at="2026-09-28T10:00:00+00:00"),
        sets=[make_set(n) for n in range(1, 22)],
    )
    resp = post_set(client, fake)
    assert resp.status_code == 201
    all_sets = [make_set(n) for n in range(1, 22)] + [{"category": "Chest", "rpe": 8}]
    old_formula = workout_service.estimate_session_calories(all_sets, BODYWEIGHT_KG, 1.0)
    new_figure = resp.json()["calories_burned"]
    assert 0 < new_figure < old_formula
    # ~20% for an ordinary hour: density barely moves a normal session, the
    # resting subtraction is what does the work.
    assert 0.70 < new_figure / old_formula < 0.90, (new_figure, old_formula)


def test_two_90_minute_sessions_no_longer_price_identically(client):
    """Bottleneck F1 end to end. Same elapsed hour and a half, same bodyweight,
    same exercise — one with 30 sets logged, one with 4."""
    def burn(set_count):
        fake = FakeSupabase(
            session=make_session(started_at="2026-09-28T09:00:00+00:00", ended_at="2026-09-28T10:30:00+00:00"),
            sets=[make_set(n) for n in range(1, set_count)],
        )
        return post_set(client, fake).json()["calories_burned"]

    dense, sparse = burn(30), burn(4)
    assert dense > sparse
    assert dense / sparse > 1.6, (dense, sparse)


def test_a_cardio_finisher_does_not_bill_its_minutes_twice(client):
    """An hour-long session with twenty minutes of it on a bike used to price
    sixty minutes of lifting AND twenty minutes of riding — eighty minutes of
    work for sixty minutes of real time."""
    finished = make_session(started_at="2026-09-28T09:00:00+00:00", ended_at="2026-09-28T10:00:00+00:00")
    with_cardio = FakeSupabase(session=dict(finished), sets=[make_set(n) for n in range(1, 12)],
                               cardio=[_cardio_row()])
    without = FakeSupabase(session=dict(finished), sets=[make_set(n) for n in range(1, 12)], cardio=[])
    both = post_set(client, with_cardio).json()["calories_burned"]
    strength_only = post_set(client, without).json()["calories_burned"]
    # The cardio is counted in full...
    assert both > strength_only
    # ...but the strength half shrank, because twenty of its sixty minutes were
    # spent on the bike. A naive sum would have been strength_only + 180.
    assert both < strength_only + 180.0


def test_a_gross_cardio_row_is_converted_before_it_joins_a_net_total(client):
    """The session total has exactly one basis. A row stored gross carries its
    own resting, and folding it in unconverted would quietly re-inflate the
    figure Phase 5.2 just corrected."""
    net_row = FakeSupabase(session=make_session(), sets=[make_set(1)], cardio=[_cardio_row(basis="net")])
    gross_row = FakeSupabase(session=make_session(), sets=[make_set(1)], cardio=[_cardio_row(basis="gross")])
    as_net = post_set(client, net_row).json()["calories_burned"]
    as_gross = post_set(client, gross_row).json()["calories_burned"]
    assert as_gross < as_net
    # The gap is exactly one BMR over the row's own twenty minutes.
    bmr = analytics_service.calculate_bmr(BODYWEIGHT_KG)
    assert as_net - as_gross == pytest.approx(workout_service.resting_kcal(bmr, 20 / 60), abs=0.2)


def test_a_cardio_row_with_no_basis_at_all_is_read_as_net(client):
    """Every row written before the Phase 5 column existed, and every row on a
    project that has not applied it yet. js/workouts/cardio.js has always
    hardcoded net, so this is not a guess."""
    legacy = _cardio_row()
    legacy.pop("basis")
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)], cardio=[legacy])
    same = FakeSupabase(session=make_session(), sets=[make_set(1)], cardio=[_cardio_row(basis="net")])
    assert post_set(client, fake).json()["calories_burned"] == pytest.approx(
        post_set(client, same).json()["calories_burned"]
    )


def test_add_cardio_records_which_basis_it_stored(client):
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[])
    client.install(fake)
    resp = client.post(
        f"/workouts/sessions/{SESSION_ID}/cardio",
        json={"segments": [{"machine": "treadmill", "params": {"speed_kmh": 6, "incline_percent": 8},
                            "duration_minutes": 32}], "net": True},
    )
    assert resp.status_code == 201, resp.text
    written = [p for t, o, p in fake.writes if t == "cardio_sessions" and o == "insert"][0]
    assert written[0]["basis"] == "net"


# --- 5.3 — the edit path ---------------------------------------------------
def test_editing_a_cardio_entry_re_prices_it_rather_than_trusting_the_old_figure(client):
    """The "computed once, never again" gap. A row's kcal was written once, at
    POST time, and there was no way to change it — a user who logged 20 minutes
    when they meant 40 had to delete the entry or live with the wrong number in
    their session total, their dashboard and their 7-day average."""
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[_cardio_row()])
    client.install(fake)
    resp = client.patch("/workouts/cardio/c1", json={"duration_minutes": 40})
    assert resp.status_code == 200, resp.text

    written = [p for t, o, p in fake.writes if t == "cardio_sessions" and o == "update"][0]
    expected = cardio_service.estimate_cardio("bike", {"watts": 120}, BODYWEIGHT_KG, 40, net=True)
    assert written["calories_burned"] == pytest.approx(expected.kcal)
    # NOT the stored figure scaled, and not the stored figure at all.
    assert written["calories_burned"] != pytest.approx(180.0)
    assert written["duration_minutes"] == 40


def test_editing_a_cardio_entry_recomputes_its_provenance_too(client):
    """A correction that moves a treadmill from 6 km/h to 16 km/h moves it from
    the walking equation to the running one. A row that kept its old
    `equation_id` would be lying about how its own number was reached."""
    walking = _cardio_row(machine="treadmill", params={"speed_kmh": 6, "incline_percent": 0},
                          equation_id="acsm_walking")
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[walking])
    client.install(fake)
    resp = client.patch("/workouts/cardio/c1", json={"params": {"speed_kmh": 16, "incline_percent": 0}})
    assert resp.status_code == 200, resp.text
    written = [p for t, o, p in fake.writes if t == "cardio_sessions" and o == "update"][0]
    assert written["equation_id"] == "acsm_running"
    assert written["basis"] == "net"


def test_editing_only_what_was_sent_keeps_the_rest_of_the_row(client):
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[_cardio_row()])
    client.install(fake)
    assert client.patch("/workouts/cardio/c1", json={"duration_minutes": 25}).status_code == 200
    written = [p for t, o, p in fake.writes if t == "cardio_sessions" and o == "update"][0]
    assert written["machine"] == "bike"
    assert written["params"] == {"watts": 120}


def test_editing_a_cardio_entry_returns_the_whole_recomputed_session(client):
    fake = FakeSupabase(session=make_session(), sets=[make_set(1)], cardio=[_cardio_row()])
    client.install(fake)
    body = client.patch("/workouts/cardio/c1", json={"duration_minutes": 40}).json()
    assert "sets" in body and "cardio" in body
    assert body["calories_burned"] is not None
    assert [t for t, o, _ in fake.writes if t == "workout_sessions" and o == "update"]


def test_editing_a_cardio_entry_that_is_not_yours_is_404(client):
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[])
    client.install(fake)
    assert client.patch("/workouts/cardio/nope", json={"duration_minutes": 10}).status_code == 404


# ---------------------------------------------------------------------------
# The not-migrated 503 must name the feature that is actually missing
#
# Found in E2E testing against a project that had workout_sessions but no
# cardio_sessions: posting cardio answered "The Workout Diary needs a one-time
# database update", while the Workout Diary was visibly working in front of the
# user. Cardio is a later migration than the diary, so that combination is a
# normal state, not a corrupted one.
# ---------------------------------------------------------------------------
def _missing_table_error(table: str) -> APIError:
    return APIError(
        {
            "message": f"Could not find the table 'public.{table}' in the schema cache",
            "code": "PGRST205",
            "hint": None,
            "details": None,
        }
    )


def test_a_missing_cardio_table_says_CARDIO_not_workout_diary(client):
    fake = FakeSupabase(session=make_session(), sets=[], cardio=[])
    fake.fail = {"cardio_sessions": _missing_table_error("cardio_sessions")}
    client.install(fake)
    resp = client.post(
        f"/workouts/sessions/{SESSION_ID}/cardio",
        json={"segments": [{"machine": "bike", "params": {"watts": 120}, "duration_minutes": 20}]},
    )
    assert resp.status_code == 503, resp.text
    detail = resp.json()["detail"]
    assert "Cardio" in detail, detail
    assert "cardio_migration.sql" in detail, detail
    # The half that makes it useful: it says the rest still works, because it does.
    assert "keeps working" in detail, detail


def test_a_missing_workout_table_still_says_workout_diary(client):
    """The general message is not replaced, only narrowed — a project missing
    workout_sessions itself has a genuinely different problem."""
    fake = FakeSupabase(session=make_session(), sets=[])
    fake.fail = {"workout_sessions": _missing_table_error("workout_sessions")}
    client.install(fake)
    resp = client.get("/workouts/sessions")
    assert resp.status_code == 503, resp.text
    detail = resp.json()["detail"]
    assert "Workout Diary" in detail, detail
    assert "Cardio" not in detail, detail


def test_an_unnamed_missing_table_falls_back_to_the_general_message(client):
    """PGRST205 names the table, but 42P01 from raw Postgres may not. Falling
    back is strictly no worse than the single message this replaced."""
    fake = FakeSupabase(session=make_session(), sets=[])
    fake.fail = {"workout_sets": APIError({"message": "relation does not exist", "code": "42P01", "hint": None, "details": None})}
    client.install(fake)
    resp = client.get(f"/workouts/sessions/{SESSION_ID}")
    assert resp.status_code == 503, resp.text
    assert "Workout Diary" in resp.json()["detail"]
