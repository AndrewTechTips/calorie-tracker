"""A 503 from an AI route must say WHICH 503 it is.

THE BUG THIS GUARDS (2026-09-30 user report, with screenshots). A user with
5 of 5 "Descrie o masă" left typed an 8-item meal and was told "Scanarea AI a
atins capacitatea pentru azi" — AI scanning is at capacity for today. Two
defects compounded:

  * The one-shot change (2026-09-17) made Stage 1's answer 5-10x longer, and
    the real description took 11-22s against a 15s per-call deadline that
    google-genai sends to Google as a SERVER deadline. Google answered 504,
    _call_model retried the identical request at the identical deadline, and
    the 26s stage guard killed the retry: asyncio.TimeoutError -> a refunded
    503 "taking too long".
  * The frontend rendered EVERY 503 as "at capacity for today", although only
    one of the backend's four 503s means that. The others are refunded and
    retryable — which is why the counter still read 5 of 5.

These tests pin both halves: the cause travels in X-AI-Error, and Stage 1
gets a deadline sized for the answer it now produces.
"""
import asyncio
import json

import pytest
from fastapi.testclient import TestClient

import main
import routers.scan as scan_router
import services.gemini_service as gemini_service
from auth import get_current_user
from rate_limit import limiter
from services import ai_usage_service, quota_service


class _FakeUser:
    id = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(limiter, "enabled", False)

    async def _yes(user_id, feature):
        return True

    async def _refund(user_id, feature):
        return None

    monkeypatch.setattr(ai_usage_service, "has_capacity", _yes)
    monkeypatch.setattr(ai_usage_service, "try_consume", _yes)
    monkeypatch.setattr(ai_usage_service, "refund", _refund)
    monkeypatch.setattr(quota_service, "has_capacity", lambda pool: True)
    main.app.dependency_overrides[get_current_user] = lambda: _FakeUser()
    try:
        yield TestClient(main.app, raise_server_exceptions=False)
    finally:
        main.app.dependency_overrides.pop(get_current_user, None)


def _describe(client):
    return client.post(
        "/scan/describe",
        json={"description": "omleta din 4 oua, 250g paine, 250g skyr", "attached_items": [], "language": "ro"},
    )


def _estimate_raising(monkeypatch, exc):
    async def _raise(*args, **kwargs):
        raise exc

    monkeypatch.setattr(scan_router, "estimate_from_description", _raise)


@pytest.mark.parametrize(
    "exc, code",
    [
        pytest.param(asyncio.TimeoutError(), scan_router.AI_ERROR_TIMEOUT, id="deadline"),
        pytest.param(
            gemini_service.ModelResponseUnusableError("truncated"),
            scan_router.AI_ERROR_UNUSABLE,
            id="unusable",
        ),
        pytest.param(
            gemini_service.ProviderCapacityError("gemini"),
            scan_router.AI_ERROR_CAPACITY,
            id="capacity",
        ),
    ],
)
def test_every_ai_503_names_its_cause(client, monkeypatch, exc, code):
    _estimate_raising(monkeypatch, exc)
    response = _describe(client)
    assert response.status_code == 503
    assert response.headers.get(scan_router.AI_ERROR_HEADER) == code


def test_only_a_real_capacity_stop_is_labelled_capacity(client, monkeypatch):
    """The exact report: a deadline must never reach the user as capacity."""
    _estimate_raising(monkeypatch, asyncio.TimeoutError())
    response = _describe(client)
    assert response.headers.get(scan_router.AI_ERROR_HEADER) != scan_router.AI_ERROR_CAPACITY


def test_the_photo_route_pre_check_is_labelled_capacity(client, monkeypatch):
    monkeypatch.setattr(quota_service, "has_capacity", lambda pool: False)
    response = client.post(
        "/scan",
        files={"image": ("photo.jpg", b"not-read", "image/jpeg")},
        data={"context_text": "", "attached_items": "[]", "language": "ro"},
    )
    assert response.status_code == 503
    assert response.headers.get(scan_router.AI_ERROR_HEADER) == scan_router.AI_ERROR_CAPACITY


def test_cors_lets_the_browser_read_the_cause(client, monkeypatch):
    """Without expose_headers, fetch() sees null and the frontend would fall
    back to guessing — the header is only useful if it survives CORS."""
    _estimate_raising(monkeypatch, asyncio.TimeoutError())
    origin = main.settings.cors_origins[0]
    response = client.post(
        "/scan/describe",
        json={"description": "paine", "attached_items": [], "language": "ro"},
        headers={"Origin": origin},
    )
    exposed = response.headers.get("access-control-expose-headers", "")
    assert scan_router.AI_ERROR_HEADER.lower() in exposed.lower()


# --- the deadline itself ------------------------------------------------------


@pytest.mark.asyncio
async def test_describe_stage1_gets_the_one_shot_deadline_not_the_client_default(monkeypatch):
    seen = {}

    async def _fake_generate_text(**kwargs):
        seen.update(kwargs)
        return json.dumps({"food_name": "x", "ingredients": []})

    async def _fake_price(data, user_id=None):
        return data

    monkeypatch.setattr(gemini_service, "_generate_text", _fake_generate_text)
    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", _fake_price)

    await gemini_service.estimate_from_description("omleta", language="ro")

    assert seen["request_timeout_seconds"] == gemini_service._STAGE1_GEMINI_CALL_TIMEOUT_SECONDS
    assert seen["request_timeout_seconds"] > gemini_service._PROVIDER_READ_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_vision_stage1_gets_the_one_shot_deadline(monkeypatch):
    seen = {}

    class _Response:
        text = json.dumps({"food_name": "x", "ingredients": []})

    async def _fake_generate_content(*args, **kwargs):
        seen.update(kwargs)
        return _Response()

    async def _fake_price(data, user_id=None):
        return data

    monkeypatch.setattr(gemini_service, "_generate_content", _fake_generate_content)
    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", _fake_price)

    await gemini_service.analyze_food_image(b"img", "image/jpeg", "", language="ro")

    assert seen["request_timeout_seconds"] == gemini_service._STAGE1_GEMINI_CALL_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_call_model_sends_the_deadline_to_the_sdk(monkeypatch):
    configs = []

    class _Models:
        async def generate_content(self, *, model, contents, config):
            configs.append(config)

            class _R:
                text = "{}"
                candidates = []

            return _R()

    class _Client:
        class aio:
            models = _Models()

    monkeypatch.setattr(quota_service, "record_call", lambda p, m: None)
    monkeypatch.setattr(quota_service, "record_success", lambda p, m: None)

    await gemini_service._call_model(
        _Client(), "model-a", ["hi"], system_prompt="s", response_schema=None,
        thinking_level=None, max_output_tokens=100, request_timeout_seconds=32.0,
    )
    await gemini_service._call_model(
        _Client(), "model-a", ["hi"], system_prompt="s", response_schema=None,
        thinking_level=None, max_output_tokens=100,
    )

    assert configs[0].http_options.timeout == 32_000
    assert configs[1].http_options is None, "other calls keep the client's 15s default"


def _api_error(code):
    exc = gemini_service.errors.APIError.__new__(gemini_service.errors.APIError)
    exc.code = code
    exc.message = f"simulated {code}"
    return exc


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now


def _client_504_after(clock, seconds, calls):
    class _Models:
        async def generate_content(self, *, model, contents, config):
            calls.append(model)
            clock.now += seconds
            raise _api_error(504)

    class _Client:
        class aio:
            models = _Models()

    return _Client()


async def _no_sleep(_):
    return None


@pytest.mark.asyncio
async def test_a_504_that_spent_our_own_deadline_is_not_retried(monkeypatch):
    """Google's 504 at OUR deadline is not a blip: the identical request at
    the identical deadline expires again, and in production the stage guard
    killed that doomed retry and ate the text fallback's window with it."""
    clock = _Clock()
    monkeypatch.setattr(gemini_service, "time", clock)
    monkeypatch.setattr(gemini_service.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(quota_service, "record_call", lambda p, m: None)
    monkeypatch.setattr(gemini_service, "_record_provider_failure", lambda *a, **k: None)
    calls = []

    with pytest.raises(gemini_service.errors.APIError):
        await gemini_service._call_model(
            _client_504_after(clock, 32.0, calls), "model-a", ["hi"],
            system_prompt="s", response_schema=None, thinking_level=None,
            max_output_tokens=100, request_timeout_seconds=32.0,
        )

    assert calls == ["model-a"], "a spent-deadline 504 must not be retried"


@pytest.mark.asyncio
async def test_a_fast_504_is_still_retried(monkeypatch):
    """The existing transient-retry contract is unchanged for a 504 that came
    back quickly — that one IS a blip on Google's side."""
    clock = _Clock()
    monkeypatch.setattr(gemini_service, "time", clock)
    monkeypatch.setattr(gemini_service.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(quota_service, "record_call", lambda p, m: None)
    monkeypatch.setattr(gemini_service, "_record_provider_failure", lambda *a, **k: None)
    calls = []

    with pytest.raises(gemini_service.errors.APIError):
        await gemini_service._call_model(
            _client_504_after(clock, 1.0, calls), "model-a", ["hi"],
            system_prompt="s", response_schema=None, thinking_level=None,
            max_output_tokens=100, request_timeout_seconds=32.0,
        )

    assert calls == ["model-a", "model-a"]
