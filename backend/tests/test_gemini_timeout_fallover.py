"""Regression coverage for the "scan sometimes works, but often hangs 10s+
before an eventual client-side timeout" incident: neither AI client in
gemini_service.py had a request-level timeout configured, so a slow/hung
provider could hold a request open far longer than intended, and — because
nothing ever raised — this file's own carefully-built multi-model/
multi-provider fallover logic never got a chance to react. See
gemini_service.py's top-of-file comment for the full incident writeup.

These tests don't hit real network timeouts (too slow/flaky for a unit
suite) — they verify the two load-bearing pieces instead: (1) both client
factories actually configure a finite timeout, and (2) the fallover logic
correctly treats a timeout/connection failure exactly like a retryable API
error (falls over to the next model/provider) rather than either hanging or
raising an exception type nothing downstream recognizes.
"""

import httpx
import pytest

from services import gemini_service, quota_service


class _FakeCandidates:
    def __init__(self, finish_reason=None):
        self.finish_reason = finish_reason


class _FakeResponse:
    def __init__(self, text):
        self.text = text
        self.candidates = [_FakeCandidates()]


def _reset_quota(monkeypatch):
    monkeypatch.setattr(quota_service, "record_call", lambda *a, **k: None)
    monkeypatch.setattr(quota_service, "record_failure", lambda *a, **k: None)
    monkeypatch.setattr(quota_service, "record_success", lambda *a, **k: None)


def test_get_openai_client_sets_a_finite_timeout_and_disables_sdk_retries():
    """openai.AsyncOpenAI()'s own defaults — a 600s read timeout and 2 hidden
    internal retries — are exactly what let one degraded Mistral/Groq/NVIDIA
    candidate hold a request open far longer than this file's own
    cross-model fallover ever expected. Both must be overridden."""
    gemini_service._openai_clients.clear()
    client = gemini_service._get_openai_client("groq")
    try:
        assert client.timeout.connect == gemini_service._PROVIDER_CONNECT_TIMEOUT_SECONDS
        assert client.timeout.read == gemini_service._PROVIDER_READ_TIMEOUT_SECONDS
        assert client.max_retries == 0
    finally:
        gemini_service._openai_clients.clear()


def test_get_gemini_client_sets_a_finite_http_timeout():
    """genai.Client() with no http_options.timeout passes an explicit
    timeout=None straight through to httpx/aiohttp, which both treat as
    "wait forever" — live-confirmed against google-genai's own source. Task
    A vision (the primary photo-scan path) shares this one cached client, so
    an unbounded default here meant an unbounded photo scan."""
    gemini_service._gemini_client = None
    try:
        client = gemini_service._get_gemini_client()
        assert client._api_client._http_options.timeout == gemini_service._GEMINI_CALL_TIMEOUT_MS
    finally:
        gemini_service._gemini_client = None


async def test_generate_content_falls_over_from_a_timed_out_model_to_the_next(monkeypatch):
    """A hung first candidate must not take the whole call down with it —
    the existing per-model reactive fallover (previously only wired for
    errors.APIError) must treat a timeout the same way."""
    _reset_quota(monkeypatch)
    monkeypatch.setattr(quota_service, "candidate_pairs", lambda provider: ["model-a", "model-b"])
    monkeypatch.setattr(quota_service, "select_candidate", lambda provider: "model-a")

    calls = []

    class _FakeModels:
        async def generate_content(self, *, model, contents, config):
            calls.append(model)
            if model == "model-a":
                raise httpx.ConnectTimeout("simulated hang")
            return _FakeResponse('{"food_name": "ok"}')

    class _FakeAio:
        models = _FakeModels()

    class _FakeClient:
        aio = _FakeAio()

    monkeypatch.setattr(gemini_service, "_get_gemini_client", lambda: _FakeClient())

    response = await gemini_service._generate_content(
        ["hello"], system_prompt="sys", response_schema=None
    )

    assert response.text == '{"food_name": "ok"}'
    assert calls == ["model-a", "model-b"]


async def test_generate_content_raises_when_every_candidate_times_out(monkeypatch):
    """The last candidate's timeout must still propagate (not be silently
    swallowed) so a caller like analyze_food_image knows the whole chain is
    exhausted and can fall over to its own next provider."""
    _reset_quota(monkeypatch)
    monkeypatch.setattr(quota_service, "candidate_pairs", lambda provider: ["model-a"])
    monkeypatch.setattr(quota_service, "select_candidate", lambda provider: "model-a")

    class _FakeModels:
        async def generate_content(self, *, model, contents, config):
            raise httpx.ConnectTimeout("simulated hang")

    class _FakeAio:
        models = _FakeModels()

    class _FakeClient:
        aio = _FakeAio()

    monkeypatch.setattr(gemini_service, "_get_gemini_client", lambda: _FakeClient())

    with pytest.raises(httpx.ConnectTimeout):
        await gemini_service._generate_content(["hello"], system_prompt="sys", response_schema=None)


async def test_analyze_food_image_falls_back_to_nvidia_when_gemini_chain_times_out(monkeypatch):
    """The end-to-end path: every Gemini model timing out (not erroring)
    must still trigger the NVIDIA fallback, exactly like an errors.APIError
    chain-exhaustion already did — this is the exception type analyze_food_
    image's except clause didn't recognize before this fix, which would
    have surfaced as a raw 500 instead of the intended graceful degradation."""
    _reset_quota(monkeypatch)

    async def fake_generate_content(*args, **kwargs):
        raise httpx.ConnectTimeout("simulated hang")

    monkeypatch.setattr(gemini_service, "_generate_content", fake_generate_content)

    async def fake_nvidia(*args, **kwargs):
        return '{"food_name": "peanuts", "ingredients": [{"food_name": "peanuts", "search_name": "peanuts", "weight_g": 30}]}'

    monkeypatch.setattr(gemini_service, "_analyze_food_image_nvidia", fake_nvidia)

    async def fake_resolve_and_price(data, **kwargs):
        return data

    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", fake_resolve_and_price)

    result = await gemini_service.analyze_food_image(b"fake-bytes", "image/jpeg")
    assert result["food_name"] == "peanuts"
