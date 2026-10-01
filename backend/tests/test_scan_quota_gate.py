"""The per-user daily gate on the two paid logging paths, end to end.

POST /scan and POST /scan/describe are each capped at 8 real AI attempts per
user per UTC day (ai_usage_service._FEATURE_DAILY_LIMITS, raised from 6 and 5
on 2026-10-01). These tests drive the real routes and the real
ai_usage_service against an in-memory stand-in for the two Supabase RPCs, so
what is checked is the wiring a user actually hits: the number the route
passes, the 9th request being refused before any provider call, the two
features metering separate buckets, and refunds never minting quota.

The stand-in mirrors sql/schema.sql's try_consume_ai_feature_usage (increment,
then reject-and-roll-back past the limit) and refund_ai_feature_usage
(decrement only an existing, non-zero row; with p_max_refunds set, only while
that row's refund_count is under it, counting the refund; returns whether it
refunded). The SQL itself is not exercised here; nothing in this repo can run
it — it was verified live against the real project instead.
"""
import io
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main
import routers.scan as scan_router
import services.gemini_service as gemini_service
from auth import get_current_user
from rate_limit import limiter
from services import ai_usage_service, quota_service


class _FakeUser:
    id = "22222222-2222-2222-2222-222222222222"


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (220, 190, 90)).save(buf, format="JPEG")
    return buf.getvalue()


JPEG = _jpeg()

STAGE1_OK = json.dumps(
    {
        "food_name": "Omleta",
        "confidence_note": "",
        "ingredients": [{"food_name": "Oua", "search_name": "egg, whole, cooked", "weight_g": 150}],
    }
)


class _FakeQuotaDb:
    """Just enough of supabase-py for ai_usage_service: the two RPCs and the
    single-row usage read behind has_capacity()/quota_message()."""

    def __init__(self):
        self.counts: dict[str, int] = {}
        self.refunds: dict[str, int] = {}
        self.rpc_calls: list[tuple[str, dict]] = []

    # supabase.rpc(name, params).execute()
    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        feature = params["p_feature"]

        def execute():
            if name == "try_consume_ai_feature_usage":
                new = self.counts.get(feature, 0) + 1
                if new > params["p_daily_limit"]:
                    return SimpleNamespace(data=[{"allowed": False, "daily_count": None, "monthly_count": None}])
                self.counts[feature] = new
                return SimpleNamespace(data=[{"allowed": True, "daily_count": new, "monthly_count": None}])
            if name == "refund_ai_feature_usage":
                cap = params.get("p_max_refunds")
                if self.counts.get(feature, 0) <= 0:
                    return SimpleNamespace(data=False)
                if cap is not None and self.refunds.get(feature, 0) >= cap:
                    return SimpleNamespace(data=False)
                self.counts[feature] -= 1
                if cap is not None:
                    self.refunds[feature] = self.refunds.get(feature, 0) + 1
                return SimpleNamespace(data=True)
            raise AssertionError(f"unexpected rpc {name}")

        return SimpleNamespace(execute=execute)

    # supabase.table("ai_feature_usage").select(...).eq(...)x3.maybe_single().execute()
    # (and, for PATCH /logs, the one daily_logs row being renamed)
    def table(self, name):
        db = self
        if name == "daily_logs":
            row = {"id": "log-1", "user_id": _FakeUser.id, "food_name": "Oua", "weight_g": 100.0}

            class _Log:
                def __getattr__(self, _attr):
                    return lambda *a, **k: self

                def execute(self):
                    return SimpleNamespace(data=dict(row))

            return _Log()
        filters: dict[str, str] = {}
        single = []

        class _Q:
            def select(self, *_a):
                return self

            def eq(self, column, value):
                filters[column] = value
                return self

            def maybe_single(self):
                single.append(True)
                return self

            def execute(self):
                if not single:  # get_usage_summary's all-features read
                    return SimpleNamespace(
                        data=[{"feature": f, "call_count": c} for f, c in db.counts.items()]
                    )
                count = db.counts.get(filters.get("feature"), 0)
                return SimpleNamespace(data={"call_count": count}) if count else None

        return _Q()


@pytest.fixture
def db(monkeypatch):
    fake = _FakeQuotaDb()
    monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: fake)
    monkeypatch.setattr(quota_service, "has_capacity", lambda pool: True)
    return fake


@pytest.fixture
def ai_calls(monkeypatch):
    """Stubs the provider layer and counts how many real attempts were made."""
    calls = {"n": 0}

    async def _fake_generate_content(*args, **kwargs):
        calls["n"] += 1
        return SimpleNamespace(text=STAGE1_OK, candidates=[])

    async def _fake_price(data, user_id=None):
        for item in data.get("ingredients", []):
            item.update(
                weight_g=float(item.get("weight_g") or 0),
                calories=150.0, protein=12.0, carbs=1.0, fats=11.0,
                fiber=0.0, sugar=0.5, sodium=140.0, macro_source="usda",
            )
        data.update(
            weight_g=150.0, calories=150, protein=12.0, carbs=1.0, fats=11.0,
            fiber=0.0, sugar=0.5, sodium=140.0, confidence_note=None,
        )
        return data

    monkeypatch.setattr(gemini_service, "_generate_content", _fake_generate_content)
    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", _fake_price)
    return calls


@pytest.fixture
def client(monkeypatch):
    # The per-minute limiter would reject a 9-request loop; it is a separate
    # mechanism from the daily quota these tests are about.
    monkeypatch.setattr(limiter, "enabled", False)
    main.app.dependency_overrides[get_current_user] = lambda: _FakeUser()
    try:
        yield TestClient(main.app, raise_server_exceptions=False)
    finally:
        main.app.dependency_overrides.pop(get_current_user, None)


def _photo(client):
    return client.post(
        "/scan",
        files={"image": ("photo.jpg", JPEG, "image/jpeg")},
        data={"context_text": "", "attached_items": "[]", "language": "ro"},
    )


def _describe(client, text="2 oua fierte"):
    return client.post("/scan/describe", json={"description": text, "attached_items": [], "language": "ro"})


# --- the numbers themselves ---------------------------------------------------


def test_photo_and_describe_limits_are_eight_each():
    """Pinned so a later edit to either number is a deliberate, reviewed
    change to a paid ceiling rather than a drive-by."""
    assert ai_usage_service._FEATURE_DAILY_LIMITS["scan"] == 8
    assert ai_usage_service._FEATURE_DAILY_LIMITS["scan_describe"] == 8
    # Neither paid logging path has a monthly gate; a stray entry would add
    # a second, undocumented ceiling.
    assert "scan" not in ai_usage_service._FEATURE_MONTHLY_LIMITS
    assert "scan_describe" not in ai_usage_service._FEATURE_MONTHLY_LIMITS


async def test_usage_summary_reports_eight_for_both(db):
    """GET /ai-usage (Settings -> AI Limits) reads the same constant the gate
    enforces, so the UI cannot show one number while the route uses another."""
    db.counts.update(scan=3, scan_describe=8)
    summary = {row["feature"]: row for row in await ai_usage_service.get_usage_summary("u")}
    assert (summary["scan"]["limit"], summary["scan"]["remaining"]) == (8, 5)
    assert (summary["scan_describe"]["limit"], summary["scan_describe"]["remaining"]) == (8, 0)


# --- the gate, through the real routes ----------------------------------------


@pytest.mark.parametrize("send, feature", [(_photo, "scan"), (_describe, "scan_describe")])
def test_eight_attempts_succeed_and_the_ninth_is_refused_before_any_ai_call(
    client, db, ai_calls, send, feature
):
    for i in range(8):
        response = send(client)
        assert response.status_code == 200, f"attempt {i + 1}: {response.text}"
    assert db.counts[feature] == 8
    calls_before = ai_calls["n"]

    ninth = send(client)

    assert ninth.status_code == 429
    assert "limit" in ninth.json()["detail"].lower()
    assert ai_calls["n"] == calls_before, "a refused request must never reach the provider"
    assert db.counts[feature] == 8, "a refused request must not move the counter"
    # The route passes the configured ceiling, not a stale literal.
    consumes = [p for name, p in db.rpc_calls if name == "try_consume_ai_feature_usage"]
    assert {p["p_daily_limit"] for p in consumes} == {8}


def test_photo_and_describe_meter_separate_buckets(client, db, ai_calls):
    for _ in range(8):
        assert _photo(client).status_code == 200
    assert _photo(client).status_code == 429

    # Exhausting photo scans leaves every describe untouched, and vice versa.
    for _ in range(8):
        assert _describe(client).status_code == 200
    assert _describe(client).status_code == 429
    assert db.counts == {"scan": 8, "scan_describe": 8}


def test_attached_items_only_describe_is_free(client, db, ai_calls):
    """No description text means a deterministic sum with no provider call —
    it must neither spend quota nor be blocked by an exhausted one."""
    db.counts["scan_describe"] = 8
    item = {
        "food_name": "Iaurt", "weight_g": 150, "calories": 90, "protein": 5,
        "carbs": 6, "fats": 4, "fiber": 0, "sugar": 6, "sodium": 60,
    }
    response = client.post("/scan/describe", json={"description": "", "attached_items": [item], "language": "ro"})
    assert response.status_code == 200
    assert db.counts["scan_describe"] == 8
    assert ai_calls["n"] == 0


# --- refunds can only return what this request spent -------------------------


def test_a_failure_before_the_spend_does_not_refund(client, db, ai_calls, monkeypatch):
    """has_capacity() runs inside the same try block as the refund handlers.
    If it raises, nothing was consumed, so a refund would hand back a scan the
    user had genuinely used earlier today. Repeated, that is unlimited scans."""
    db.counts["scan"] = 5

    async def _boom(user_id, feature):
        raise RuntimeError("supabase blinked")

    monkeypatch.setattr(ai_usage_service, "has_capacity", _boom)

    response = _photo(client)

    assert response.status_code == 500
    assert db.counts["scan"] == 5
    assert not any(name == "refund_ai_feature_usage" for name, _ in db.rpc_calls)


def test_describe_does_not_refund_when_the_spend_itself_failed(client, db, ai_calls, monkeypatch):
    db.counts["scan_describe"] = 5

    async def _boom(user_id, feature):
        raise RuntimeError("rpc transport error")

    monkeypatch.setattr(ai_usage_service, "try_consume", _boom)

    response = _describe(client)

    assert response.status_code == 500
    assert db.counts["scan_describe"] == 5
    assert ai_calls["n"] == 0


@pytest.mark.parametrize("send, feature", [(_photo, "scan"), (_describe, "scan_describe")])
def test_a_provider_failure_after_the_spend_is_refunded_exactly_once(
    client, db, monkeypatch, send, feature
):
    async def _provider_down(*args, **kwargs):
        raise RuntimeError("provider 500")

    monkeypatch.setattr(gemini_service, "_generate_content", _provider_down)
    monkeypatch.setattr(gemini_service, "_call_openai_text", _provider_down, raising=False)
    monkeypatch.setattr(scan_router, "analyze_food_image", _provider_down)
    monkeypatch.setattr(scan_router, "estimate_from_description", _provider_down)

    response = send(client)

    assert response.status_code == 500
    assert db.counts[feature] == 0
    refunds = [p for name, p in db.rpc_calls if name == "refund_ai_feature_usage"]
    assert len(refunds) == 1


def test_refund_never_takes_the_counter_below_zero(db):
    import asyncio

    asyncio.run(ai_usage_service.refund("u", "scan"))
    assert "scan" not in db.counts


# --- the daily refund cap (2026-10-01) ----------------------------------------
#
# A failed attempt is refunded, but every failure is still a billed provider
# call. Without a cap, a user able to provoke failures could make paid calls
# forever without their counter moving. These pin: the first five failures
# per feature per day are free, the sixth is charged and SAYS so, and the
# total number of real attempts one user can make is bounded.

_CAP = ai_usage_service._DAILY_REFUND_LIMIT


def _fail_with(monkeypatch, exc):
    async def _boom(*args, **kwargs):
        raise exc

    monkeypatch.setattr(scan_router, "analyze_food_image", _boom)
    monkeypatch.setattr(scan_router, "estimate_from_description", _boom)


def test_the_refund_cap_is_five():
    assert _CAP == 5


@pytest.mark.parametrize("send, feature", [(_photo, "scan"), (_describe, "scan_describe")])
def test_failures_past_the_cap_are_charged_and_say_so(client, db, monkeypatch, send, feature):
    import asyncio

    _fail_with(monkeypatch, asyncio.TimeoutError())

    for i in range(_CAP):
        r = send(client)
        assert r.status_code == 503 and r.headers["X-AI-Error"] == "timeout"
        assert "X-AI-Charged" not in r.headers, f"failure {i + 1} was refunded and must not claim a charge"
    assert db.counts[feature] == 0
    assert db.refunds[feature] == _CAP

    sixth = send(client)

    assert sixth.status_code == 503
    assert sixth.headers["X-AI-Charged"] == "1"
    assert db.counts[feature] == 1, "the sixth failure stays charged"
    assert db.refunds[feature] == _CAP


@pytest.mark.parametrize("send, feature", [(_photo, "scan"), (_describe, "scan_describe")])
def test_one_user_can_make_at_most_limit_plus_cap_real_attempts_a_day(
    client, db, monkeypatch, send, feature
):
    """The abuse bound itself: however the attempts fail, the provider is
    reached at most daily limit + refund cap times."""
    attempts = {"n": 0}

    async def _counted_failure(*args, **kwargs):
        attempts["n"] += 1
        raise RuntimeError("provider 500")

    monkeypatch.setattr(scan_router, "analyze_food_image", _counted_failure)
    monkeypatch.setattr(scan_router, "estimate_from_description", _counted_failure)

    statuses = [send(client).status_code for _ in range(30)]

    limit = ai_usage_service._FEATURE_DAILY_LIMITS[feature]
    assert attempts["n"] == limit + _CAP == 13
    assert statuses[:13] == [500] * 13
    assert set(statuses[13:]) == {429}


def test_capacity_stops_are_always_refunded_and_never_use_up_the_cap(client, db, monkeypatch):
    """ProviderCapacityError is raised BEFORE any provider call — it costs
    nothing, so it is refunded unconditionally and must not eat the
    allowance an honest user needs for real failures later in the day."""
    from services.gemini_service import ProviderCapacityError

    _fail_with(monkeypatch, ProviderCapacityError("ceiling"))
    for _ in range(_CAP + 3):
        r = _describe(client)
        assert r.status_code == 503 and r.headers["X-AI-Error"] == "capacity"
        assert "X-AI-Charged" not in r.headers
    assert db.counts["scan_describe"] == 0
    assert db.refunds.get("scan_describe", 0) == 0
    capped_flags = {p["p_max_refunds"] for name, p in db.rpc_calls if name == "refund_ai_feature_usage"}
    assert capped_flags == {None}


def test_the_cap_is_per_feature(client, db, monkeypatch):
    import asyncio

    _fail_with(monkeypatch, asyncio.TimeoutError())
    for _ in range(_CAP + 1):
        _photo(client)
    assert db.refunds["scan"] == _CAP

    # Photo failures used up the photo allowance only.
    r = _describe(client)
    assert r.status_code == 503 and "X-AI-Charged" not in r.headers
    assert db.counts["scan_describe"] == 0


def test_log_correction_failures_share_the_same_cap(client, db, monkeypatch):
    import routers.logs as logs_router

    async def _boom(*args, **kwargs):
        raise RuntimeError("provider 500")

    monkeypatch.setattr(logs_router, "get_supabase", lambda: db)
    monkeypatch.setattr(logs_router, "estimate_macros_for_food_name", _boom)

    def _rename(i):
        return client.patch("/logs/log-1", json={"food_name": f"Branza telemea {i}"})

    for i in range(_CAP):
        r = _rename(i)
        assert r.status_code == 503 and "X-AI-Charged" not in r.headers
    sixth = _rename(99)
    assert sixth.status_code == 503 and sixth.headers["X-AI-Charged"] == "1"
    assert db.counts["log_correction"] == 1


def test_the_charged_header_is_readable_by_the_browser():
    """Without CORS exposing it, fetch() cannot see the header and the
    frontend would keep promising "it didn't count" on a charged failure."""
    cors = next(m for m in main.app.user_middleware if m.cls.__name__ == "CORSMiddleware")
    assert "X-AI-Charged" in cors.kwargs["expose_headers"]
    assert "X-AI-Error" in cors.kwargs["expose_headers"]


# --- refund() itself ----------------------------------------------------------


class _RpcStub:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def rpc(self, name, params):
        self.calls.append(params)
        outcome = self.outcomes.pop(0)

        def execute():
            if isinstance(outcome, Exception):
                raise outcome
            return SimpleNamespace(data=outcome)

        return SimpleNamespace(execute=execute)


@pytest.mark.parametrize("data, expected", [(True, True), (False, False), (None, False)])
async def test_refund_reports_whether_it_refunded(monkeypatch, data, expected):
    stub = _RpcStub(data)
    monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: stub)
    assert await ai_usage_service.refund("u", "scan") is expected
    assert stub.calls[0]["p_max_refunds"] == _CAP


async def test_refund_is_uncapped_on_request(monkeypatch):
    stub = _RpcStub(True)
    monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: stub)
    assert await ai_usage_service.refund("u", "scan", capped=False) is True
    assert stub.calls[0]["p_max_refunds"] is None


async def test_refund_falls_back_to_the_pre_migration_function(monkeypatch):
    """Deploying this code before the SQL is applied must change nothing:
    PostgREST answers PGRST202 for the unknown p_max_refunds argument, and
    refund() retries the old three-argument call (uncapped, as before)."""
    from postgrest.exceptions import APIError

    missing = APIError({"code": "PGRST202", "message": "Could not find the function", "details": None, "hint": None})
    stub = _RpcStub(missing, None)
    monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: stub)

    assert await ai_usage_service.refund("u", "scan") is True
    assert "p_max_refunds" in stub.calls[0]
    assert "p_max_refunds" not in stub.calls[1]


async def test_refund_never_raises_and_reports_a_failure_as_charged(monkeypatch):
    from postgrest.exceptions import APIError

    other = APIError({"code": "42501", "message": "permission denied", "details": None, "hint": None})
    for outcome in (other, RuntimeError("supabase down")):
        stub = _RpcStub(outcome)
        monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: stub)
        assert await ai_usage_service.refund("u", "scan") is False
