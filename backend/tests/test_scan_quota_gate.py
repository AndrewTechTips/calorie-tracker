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
(decrement, clamped at zero, existing rows only). The SQL itself is not
exercised here; nothing in this repo can run it.
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
                if feature in self.counts:
                    self.counts[feature] = max(0, self.counts[feature] - 1)
                return SimpleNamespace(data=None)
            raise AssertionError(f"unexpected rpc {name}")

        return SimpleNamespace(execute=execute)

    # supabase.table("ai_feature_usage").select(...).eq(...)x3.maybe_single().execute()
    def table(self, _name):
        db = self
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
