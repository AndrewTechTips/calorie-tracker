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

import re

import httpx
import pytest

from config import get_settings
from services import gemini_service, quota_service


class _FakeCandidates:
    def __init__(self, finish_reason=None):
        self.finish_reason = finish_reason


class _FakeResponse:
    def __init__(self, text):
        self.text = text
        self.candidates = [_FakeCandidates()]


async def _no_sleep(_seconds):
    """Collapses _TRANSIENT_RETRY_BACKOFF_SECONDS so the retry tests stay fast.
    The backoff's VALUE is not what they are testing — that a retry happens at
    all, and what it does to the failure record, is."""
    return None


def _reset_quota(monkeypatch):
    monkeypatch.setattr(quota_service, "record_call", lambda *a, **k: None)
    monkeypatch.setattr(quota_service, "record_failure", lambda *a, **k: None)
    monkeypatch.setattr(quota_service, "record_success", lambda *a, **k: None)


def test_get_openai_client_sets_a_finite_timeout_and_disables_sdk_retries(monkeypatch):
    """openai.AsyncOpenAI()'s own defaults — a 600s read timeout and 2 hidden
    internal retries — are exactly what let one degraded Mistral/Groq
    candidate hold a request open far longer than this file's own
    cross-model fallover ever expected. Both must be overridden.

    The key is injected here rather than in tests/conftest.py on purpose.
    MISTRAL_API_KEY is OPTIONAL (config.py defaults it to "") and a blank key
    is load-bearing behavior elsewhere — _generate_text skips the fallback
    entirely when it is empty, which is how a partially-configured .env
    degrades gracefully. Setting a fake key session-wide would make the whole
    suite believe the fallback is configured and quietly change what those
    paths do. This test is the only one that constructs a real AsyncOpenAI
    (which refuses to build with an empty key: "openai.OpenAIError: Missing
    credentials"), so it supplies its own.

    Without this the test passed locally — pydantic-settings reads the
    developer's own backend/.env — and failed in CI, which has no .env. A test
    whose result depends on an untracked local file isn't testing the code.

    Phase 2 note: this used to exercise the Groq client. Groq is gone; Mistral
    is now the single non-Google text fallback, and the property under test is
    unchanged — a finite timeout and no hidden SDK retries underneath this
    file's own timeout accounting."""
    settings = get_settings()
    monkeypatch.setattr(settings, "mistral_api_key", "test-mistral-key", raising=False)

    gemini_service._openai_clients.clear()
    client = gemini_service._get_openai_client("mistral")
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
    # model-a twice, then model-b. The repeat is _call_model's own transient
    # retry (2026-09-11): a ConnectTimeout fails fast and is exactly the kind of
    # blip worth a second attempt before it counts as evidence the model is
    # unhealthy. The fallover still happens when that second attempt also
    # fails, which is what this test is really about.
    assert calls == ["model-a", "model-a", "model-b"]


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


async def test_analyze_food_image_falls_back_to_mistral_when_gemini_chain_times_out(monkeypatch):
    """The end-to-end path: every Gemini model timing out (not erroring)
    must still trigger the vision fallback, exactly like an errors.APIError
    chain-exhaustion already did — this is the exception type analyze_food_
    image's except clause didn't recognize before this fix, which would
    have surfaced as a raw 500 instead of the intended graceful degradation."""
    _reset_quota(monkeypatch)

    async def fake_generate_content(*args, **kwargs):
        raise httpx.ConnectTimeout("simulated hang")

    monkeypatch.setattr(gemini_service, "_generate_content", fake_generate_content)

    async def fake_vision_fallback(*args, **kwargs):
        return '{"food_name": "peanuts", "ingredients": [{"food_name": "peanuts", "search_name": "peanuts", "weight_g": 30}]}'

    monkeypatch.setattr(gemini_service, "_analyze_food_image_fallback", fake_vision_fallback)

    async def fake_resolve_and_price(data, **kwargs):
        return data

    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", fake_resolve_and_price)

    result = await gemini_service.analyze_food_image(b"fake-bytes", "image/jpeg")
    assert result["food_name"] == "peanuts"
    # ...and the result must SAY it came from the fallback. Added 2026-09-11:
    # over 27 real scans the fallback answered 4 and was wrong on all 4, at a
    # median 3.2x calorie overcount, while reaching the user looking exactly
    # like a Gemini answer. Provenance is the minimum fix.
    assert result[gemini_service.VISION_PROVIDER_KEY] == gemini_service.VISION_PROVIDER_FALLBACK


@pytest.mark.asyncio
async def test_analyze_food_image_marks_a_normal_gemini_answer_as_primary(monkeypatch):
    """The other half of the provenance contract — a healthy scan must NOT be
    tagged as a fallback, or the telemetry that decides this fallback's future
    is measuring noise."""
    _reset_quota(monkeypatch)

    class _Response:
        text = '{"food_name": "peanuts", "ingredients": [{"food_name": "peanuts", "search_name": "peanuts", "weight_g": 30}]}'

    async def fake_generate_content(*args, **kwargs):
        return _Response()

    async def fail_fallback(*args, **kwargs):
        raise AssertionError("the fallback must not run when Gemini answered")

    async def fake_resolve_and_price(data, **kwargs):
        return data

    monkeypatch.setattr(gemini_service, "_generate_content", fake_generate_content)
    monkeypatch.setattr(gemini_service, "_analyze_food_image_fallback", fail_fallback)
    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", fake_resolve_and_price)

    result = await gemini_service.analyze_food_image(b"fake-bytes", "image/jpeg")
    assert result[gemini_service.VISION_PROVIDER_KEY] == gemini_service.VISION_PROVIDER_PRIMARY


# ---------------------------------------------------------------------------
# Phase 2 regression guards.
#
# The consolidation deleted ~35KB of provider-chain machinery, and the risk
# with a deletion that size is not that something obviously breaks — the suite
# catches that — but that a name survives in a path the suite only ever
# reaches with a mock in place. That happened once during this refactor:
# _analyze_food_image_nvidia still called a helper the deletion had removed,
# and no test caught it because every test that reaches the vision fallback
# monkeypatches the whole function. It would have surfaced as a NameError the
# first time Google actually went down — the single worst moment to discover
# your fallback does not import.
#
# These import the real thing and check the wiring rather than the behaviour.
# ---------------------------------------------------------------------------
def test_every_name_the_fallback_paths_reference_actually_exists():
    """Compile-time reachability for the two outage paths. A missing helper on
    either is invisible until an outage, so check them directly."""
    import inspect

    for func in (
        gemini_service._analyze_food_image_fallback,
        gemini_service._call_openai_text,
        gemini_service._generate_free_text,
        gemini_service._free_text_candidates,
    ):
        source = inspect.getsource(func)
        for name in re.findall(r"\b(_[a-z][a-z0-9_]*)\s*\(", source):
            if name in {"_", func.__name__}:
                continue
            assert hasattr(gemini_service, name) or name in func.__code__.co_varnames, (
                f"{func.__name__} calls {name}() which no longer exists in gemini_service"
            )


def test_removed_provider_machinery_is_actually_gone():
    """Phase 2 deleted these by name. If one reappears, the consolidation is
    being un-done a piece at a time and this should say so out loud."""
    for name in (
        "_call_openai_compatible",
        "_task_b_chain",
        "_task_c_chain",
        "_reasoning_effort_for",
        "_REASONING_MODEL_TOKEN_RESERVE",
        "_GEMINI_TEXT_FALLBACK_THINKING_BUDGET",
        "_groq_models",
        "_mistral_models_for",
    ):
        assert not hasattr(gemini_service, name), f"{name} is back in gemini_service"


def test_thinking_level_replaces_the_numeric_budget():
    """Gemini 3.8 rejects thinking_budget outright. _call_model must not be
    able to send one, and the levels it does send must be in the accepted
    enum — 'minimal' is a 400 from the API, not a silent downgrade."""
    import inspect

    params = inspect.signature(gemini_service._call_model).parameters
    assert "thinking_level" in params
    assert "thinking_budget" not in params

    assert gemini_service._thinking_config(None) is None
    # The SDK coerces the string to a ThinkingLevel enum whose .value is
    # upper-case, so compare case-insensitively.
    def level_of(value):
        config = gemini_service._thinking_config(value)
        raw = config.thinking_level
        return str(getattr(raw, "value", raw)).lower()

    assert level_of("high") == "high"

    # This guard is load-bearing, and verified against the SDK rather than
    # assumed: google-genai accepts BOTH "minimal" and outright garbage
    # client-side (garbage only raises a UserWarning), so neither is caught
    # until the API returns a 400 mid-request. "minimal" in particular is a
    # documented hard error on Gemini 3.8. Normalising here is what keeps a
    # bad config value from becoming a failed user request.
    assert level_of("minimal") in gemini_service._VALID_THINKING_LEVELS
    assert level_of("nonsense") in gemini_service._VALID_THINKING_LEVELS


def test_chat_transcript_is_bounded():
    """History is chat's only unbounded input and it is re-sent on every turn.
    ChatTurn allows 800 chars x 12 turns = ~2,400 tokens per turn before this
    trim; the cap is what keeps a long conversation from costing more each
    time it continues."""

    class _Turn:
        def __init__(self, role, content):
            self.role = role
            self.content = content

    history = [_Turn("user" if i % 2 == 0 else "coach", "x" * 800) for i in range(12)]
    transcript = gemini_service._format_chat_transcript(history, "what should I eat?")

    lines = transcript.split("\n")
    assert len(lines) == gemini_service._CHAT_HISTORY_TURNS + 1, "old turns must be dropped"
    for line in lines[:-1]:
        assert len(line) <= gemini_service._CHAT_TURN_CHARS + len("Coach: ")
    # The current message is never truncated — it is the actual question.
    assert lines[-1] == "User: what should I eat?"


async def test_meal_suggestions_do_not_trigger_micro_backfill_calls(monkeypatch):
    """_ground_ingredient's micro backfill costs an AI call per ingredient.
    Meal suggestions produce up to 4 x 6 = 24 ingredients behind one tap, so
    backfilling there was up to 24 extra calls (48 with the old validating
    wrapper's retry) for fiber precision on a suggestion the user has not
    accepted. It must stay off for that path."""
    calls = []

    async def fake_lookup(name):
        return {
            "food_name": name, "source": "usda",
            "calories_per_100g": 100.0, "protein_per_100g": 10.0,
            "carbs_per_100g": 10.0, "fats_per_100g": 1.0,
            # deliberately silent on the micros — the backfill trigger
        }

    async def spy_fill(match, food_name):
        calls.append(food_name)
        return match

    monkeypatch.setattr(gemini_service.nutrition_db_service, "lookup", fake_lookup)
    monkeypatch.setattr(gemini_service, "_fill_missing_micros", spy_fill)

    await gemini_service._finalize_ingredients(
        {
            "name": "Test meal",
            "ingredients": [
                {"food_name": f"food {i}", "weight_g": 100, "calories": 100,
                 "protein": 10, "carbs": 10, "fats": 1}
                for i in range(6)
            ],
        },
        name_field="name",
        max_ingredients=6,
    )
    assert calls == [], f"meal suggestions made {len(calls)} micro-backfill AI calls"


# ---------------------------------------------------------------------------
# Phase 2b guards — the "$0.00 for chat and suggestions" operational rule.
#
# This is a budget promise, not an optimisation, so it needs a structural
# guard rather than a comment: the failure mode is silent (the feature keeps
# working, a bill appears a month later) and it reappears every time someone
# edits one of these three call sites and reaches for the nearer-looking
# _generate_text.
# ---------------------------------------------------------------------------
async def test_free_features_never_reach_the_paid_key_by_default(monkeypatch):
    """chat / suggestions / recap must not call Gemini while
    free_text_allow_paid_fallback is off — not even when every free provider
    has failed. An exception is the intended, honest outcome there."""
    monkeypatch.setattr(get_settings(), "free_text_allow_paid_fallback", False, raising=False)

    async def explode_gemini(*args, **kwargs):
        raise AssertionError("a free-tier feature reached the PAID Gemini path")

    async def failing_free(*args, **kwargs):
        raise RuntimeError("simulated free-provider outage")

    monkeypatch.setattr(gemini_service, "_generate_content", explode_gemini)
    monkeypatch.setattr(gemini_service, "_call_openai_text", failing_free)
    monkeypatch.setattr(
        gemini_service, "_free_text_candidates", lambda: [("groq", "m1"), ("mistral", "m2")]
    )

    with pytest.raises(RuntimeError, match="simulated free-provider outage"):
        await gemini_service._generate_free_text(
            system_prompt="sys", user_content="hi", response_schema=None, max_output_tokens=300
        )


async def test_free_text_walks_to_the_next_candidate_then_stops(monkeypatch):
    """The ordered walk is the whole routing policy: first candidate's failure
    (in production, Groq's 1,000-output-tokens-per-minute 429) must hand off
    to the next, and a success must stop the walk there."""
    seen = []

    async def flaky(*, provider, model, **kwargs):
        seen.append((provider, model))
        if provider == "groq":
            raise RuntimeError("429 OTPM")
        return '{"reply": "ok"}'

    monkeypatch.setattr(gemini_service, "_call_openai_text", flaky)
    monkeypatch.setattr(
        gemini_service, "_free_text_candidates", lambda: [("groq", "a"), ("mistral", "b")]
    )

    out = await gemini_service._generate_free_text(
        system_prompt="sys", user_content="hi", response_schema=None, max_output_tokens=300
    )
    assert out == '{"reply": "ok"}'
    assert seen == [("groq", "a"), ("mistral", "b")]


def test_free_text_candidates_skip_providers_with_no_key(monkeypatch):
    """An unset key must degrade to one fewer candidate, never to a failed
    request — the same "blank key simply drops that provider" contract the
    paid fallback has."""
    settings = get_settings()
    monkeypatch.setattr(settings, "free_text_models", "groq:m1,mistral:m2,bogus:m3", raising=False)
    monkeypatch.setattr(settings, "groq_api_key", "", raising=False)
    monkeypatch.setattr(settings, "mistral_api_key", "k", raising=False)

    assert gemini_service._free_text_candidates() == [("mistral", "m2")]


def test_free_features_are_wired_to_the_free_path():
    """Reads the three call sites directly. Cheaper than mocking each one, and
    it fails on the exact edit this guard exists to catch."""
    import inspect

    for func in (
        gemini_service.chat_with_coach,
        gemini_service.generate_meal_suggestions,
        gemini_service.generate_weekly_recap,
    ):
        source = inspect.getsource(func)
        assert "_generate_free_text(" in source, f"{func.__name__} is not on the free path"
        assert "await _generate_text(" not in source, f"{func.__name__} calls the PAID path"


# ---------------------------------------------------------------------------
# Failure classification and the cooldown it arms (2026-09-11).
#
# THE BUG: Settings.gemini_models configures ONE model, so quota_service's
# cooldown does not demote a model in favour of a sibling — it empties the
# "gemini" pool, and POST /scan's proactive has_capacity() check then refuses
# EVERY user's scan with a 503 for the whole duration. One real
# 504 DEADLINE_EXCEEDED from Google did exactly that during this repo's own
# diagnostic testing: a single transient blip, on one request, taking scanning
# down account-wide for ten minutes.
#
# These exercise the real _call_model, not quota_service in isolation, because
# the fix is split across the two and the interesting part is the seam: which
# errors get a retry BEFORE anything is recorded, which record a failure that
# only counts toward a streak, and which are conclusive enough to cool down on
# sight. A real 504 cannot be forced on demand, so these are monkeypatched.
# ---------------------------------------------------------------------------


class _Recorder:
    """Captures what _call_model told quota_service, without the real state."""

    def __init__(self, monkeypatch):
        self.failures = []
        self.successes = []
        monkeypatch.setattr(quota_service, "record_call", lambda *a, **k: None)
        monkeypatch.setattr(
            quota_service, "record_failure",
            lambda p, m, *, immediate=False: self.failures.append((p, m, immediate)) or False,
        )
        monkeypatch.setattr(
            quota_service, "record_success", lambda p, m: self.successes.append((p, m))
        )
        monkeypatch.setattr(quota_service, "consecutive_failures", lambda p, m: len(self.failures))


def _client_raising(monkeypatch, *errors_then_ok, calls):
    """A fake Gemini client that raises the given errors in order, then answers."""
    queue = list(errors_then_ok)

    class _FakeModels:
        async def generate_content(self, *, model, contents, config):
            calls.append(model)
            if queue:
                raise queue.pop(0)
            return _FakeResponse('{"food_name": "ok"}')

    class _FakeAio:
        models = _FakeModels()

    class _FakeClient:
        aio = _FakeAio()

    monkeypatch.setattr(gemini_service, "_get_gemini_client", lambda: _FakeClient())


def _api_error(code):
    """A google-genai APIError carrying a status code, built without touching
    the SDK's own constructor signature (which varies across versions)."""
    exc = gemini_service.errors.APIError.__new__(gemini_service.errors.APIError)
    exc.code = code
    exc.message = f"simulated {code}"
    return exc


@pytest.mark.asyncio
@pytest.mark.parametrize("code", sorted(gemini_service._TRANSIENT_RETRY_STATUS_CODES))
async def test_one_isolated_transient_error_self_heals_and_records_no_failure(
    monkeypatch, code
):
    """THE HEADLINE FIX. A single 5xx must be retried and, when the retry
    works, must leave no trace — no failure recorded, so nothing can accumulate
    toward a cooldown that would take scanning down for everyone."""
    rec = _Recorder(monkeypatch)
    monkeypatch.setattr(gemini_service.asyncio, "sleep", _no_sleep)
    calls = []
    _client_raising(monkeypatch, _api_error(code), calls=calls)

    response = await gemini_service._call_model(
        gemini_service._get_gemini_client(), "model-a", ["hi"],
        system_prompt="sys", response_schema=None, thinking_level=None,
        max_output_tokens=100,
    )

    assert response.text == '{"food_name": "ok"}'
    assert calls == ["model-a", "model-a"], "the transient error must be retried once"
    assert rec.failures == [], f"a recovered {code} must not count as a failure"
    assert rec.successes == [("gemini", "model-a")]


@pytest.mark.asyncio
async def test_a_transient_error_that_does_not_recover_counts_toward_the_streak(monkeypatch):
    """The retry is one chance, not unlimited. When it also fails, the failure
    is recorded — but NOT as immediate, so it takes a streak to cool down."""
    rec = _Recorder(monkeypatch)
    monkeypatch.setattr(gemini_service.asyncio, "sleep", _no_sleep)
    calls = []
    _client_raising(monkeypatch, _api_error(504), _api_error(504), calls=calls)

    with pytest.raises(gemini_service.errors.APIError):
        await gemini_service._call_model(
            gemini_service._get_gemini_client(), "model-a", ["hi"],
            system_prompt="sys", response_schema=None, thinking_level=None,
            max_output_tokens=100,
        )

    assert calls == ["model-a", "model-a"], "exactly one retry, then give up"
    assert rec.failures == [("gemini", "model-a", False)], "must not be immediate"


@pytest.mark.asyncio
@pytest.mark.parametrize("code", sorted(gemini_service._DISQUALIFYING_STATUS_CODES))
async def test_a_disqualifying_error_cools_down_immediately_without_a_retry(monkeypatch, code):
    """401/403 is the credential and 404 is the model name. Neither depends on
    the request, so a second attempt returns the identical answer — retrying or
    waiting for a streak just burns round-trips to re-learn what the first one
    already proved."""
    rec = _Recorder(monkeypatch)
    calls = []
    _client_raising(monkeypatch, _api_error(code), calls=calls)

    with pytest.raises(gemini_service.errors.APIError):
        await gemini_service._call_model(
            gemini_service._get_gemini_client(), "model-a", ["hi"],
            system_prompt="sys", response_schema=None, thinking_level=None,
            max_output_tokens=100,
        )

    assert calls == ["model-a"], "a conclusive error must not be retried"
    assert rec.failures == [("gemini", "model-a", True)], "must arm on the first occurrence"


@pytest.mark.asyncio
async def test_a_429_records_no_failure_at_all(monkeypatch):
    """Throttling is not ill health — the RPM bucket governs it, and
    quota_service.record_failure's docstring has always said "NOT for a plain
    429" while this file armed a cooldown on one anyway. On a single-model pool
    that turned "slow down for a moment" into "scanning is off for everyone"."""
    rec = _Recorder(monkeypatch)
    calls = []
    _client_raising(monkeypatch, _api_error(429), calls=calls)

    with pytest.raises(gemini_service.errors.APIError):
        await gemini_service._call_model(
            gemini_service._get_gemini_client(), "model-a", ["hi"],
            system_prompt="sys", response_schema=None, thinking_level=None,
            max_output_tokens=100,
        )

    assert calls == ["model-a"], "a 429 is not retried here — the RPM bucket handles it"
    assert rec.failures == [], "a 429 must never reach the cooldown"


@pytest.mark.asyncio
async def test_a_read_timeout_is_not_retried_but_still_only_counts_toward_the_streak(
    monkeypatch,
):
    """A ReadTimeout has already spent the full 15s read budget, so a second
    attempt cannot fit inside _VISION_PRIMARY_BUDGET_SECONDS and would only eat
    the slice reserved for the vision fallback. It goes straight to the streak
    counter, which is what keeps one of them from arming a cooldown alone."""
    rec = _Recorder(monkeypatch)
    calls = []
    _client_raising(monkeypatch, httpx.ReadTimeout("slow"), calls=calls)

    with pytest.raises(httpx.ReadTimeout):
        await gemini_service._call_model(
            gemini_service._get_gemini_client(), "model-a", ["hi"],
            system_prompt="sys", response_schema=None, thinking_level=None,
            max_output_tokens=100,
        )

    assert calls == ["model-a"], "an already-expensive timeout must not be repeated"
    assert rec.failures == [("gemini", "model-a", False)]


@pytest.mark.asyncio
async def test_a_connect_error_is_cheap_enough_to_retry(monkeypatch):
    """The other side of the same judgement: a refused connection or DNS blip
    fails fast, so retrying costs almost nothing and frequently works."""
    rec = _Recorder(monkeypatch)
    monkeypatch.setattr(gemini_service.asyncio, "sleep", _no_sleep)
    calls = []
    _client_raising(monkeypatch, httpx.ConnectError("refused"), calls=calls)

    response = await gemini_service._call_model(
        gemini_service._get_gemini_client(), "model-a", ["hi"],
        system_prompt="sys", response_schema=None, thinking_level=None,
        max_output_tokens=100,
    )

    assert response.text == '{"food_name": "ok"}'
    assert calls == ["model-a", "model-a"]
    assert rec.failures == []


def test_the_three_error_buckets_do_not_overlap():
    """A code in two buckets would make behaviour depend on clause order, which
    is exactly the kind of bug that hides until an outage."""
    transient = gemini_service._TRANSIENT_RETRY_STATUS_CODES
    throttled = gemini_service._THROTTLED_STATUS_CODES
    disqualifying = gemini_service._DISQUALIFYING_STATUS_CODES
    assert not (transient & throttled)
    assert not (transient & disqualifying)
    assert not (throttled & disqualifying)
    # 400 belongs to none of them on purpose — see the block comment in
    # gemini_service. It falls through to the ordinary streak path so that one
    # user's malformed upload cannot cool the pool down for everybody, while a
    # genuine config-level 400 (which fails every call) still reaches the
    # streak within three requests.
    assert 400 not in transient | throttled | disqualifying


# ---------------------------------------------------------------------------
# The user-facing half of the fallback provenance (2026-09-11).
#
# The internal stamp above answers "how often does this run" for an operator.
# These cover the other half: the person holding the phone is told that the
# numbers came from a backup service and should be checked. Measured basis for
# doing that at all — pixtral answered 6 real scans across two diagnostic
# passes and was wrong on all 6, at a median 3.2x calorie overcount.
# ---------------------------------------------------------------------------


async def _fallback_scan(monkeypatch, language):
    _reset_quota(monkeypatch)

    async def fake_generate_content(*args, **kwargs):
        raise httpx.ConnectTimeout("simulated hang")

    async def fake_vision_fallback(*args, **kwargs):
        return (
            '{"food_name": "peanuts", "confidence_note": "portion estimated",'
            ' "ingredients": [{"food_name": "peanuts", "search_name": "peanuts", "weight_g": 30}]}'
        )

    async def fake_resolve_and_price(data, **kwargs):
        return data

    monkeypatch.setattr(gemini_service, "_generate_content", fake_generate_content)
    monkeypatch.setattr(gemini_service, "_analyze_food_image_fallback", fake_vision_fallback)
    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", fake_resolve_and_price)
    monkeypatch.setattr(gemini_service.asyncio, "sleep", _no_sleep)
    return await gemini_service.analyze_food_image(
        b"fake-bytes", "image/jpeg", language=language
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "ro"])
async def test_a_fallback_result_carries_a_lighter_confidence_note(monkeypatch, language):
    """The signal must reach the user, in their own language, through the field
    the review sheet already renders — no schema change, no frontend deploy."""
    result = await _fallback_scan(monkeypatch, language)
    note = result["confidence_note"]

    assert note.startswith(gemini_service._FALLBACK_CONFIDENCE_NOTE[language]), (
        "the backup-service caveat leads — it is about whether to trust the "
        "numbers at all, which outranks the model's note about what it could see"
    )
    # The model's own caveat is kept, not replaced.
    assert "portion estimated" in note


@pytest.mark.asyncio
async def test_an_unknown_language_falls_back_to_english_copy(monkeypatch):
    """Same convention as notification_copy.notification_text() — an
    unrecognised language gets English rather than a KeyError on a path the
    user is already having a bad time on."""
    result = await _fallback_scan(monkeypatch, "de")
    assert result["confidence_note"].startswith(gemini_service._FALLBACK_CONFIDENCE_NOTE["en"])


@pytest.mark.asyncio
async def test_a_normal_gemini_result_gets_no_backup_service_note(monkeypatch):
    """The other half of the contract. If this note appeared on healthy scans
    it would be noise, and users would learn to ignore it by the time it
    actually mattered."""
    _reset_quota(monkeypatch)

    class _Response:
        text = (
            '{"food_name": "peanuts", "confidence_note": "portion estimated",'
            ' "ingredients": [{"food_name": "peanuts", "search_name": "peanuts", "weight_g": 30}]}'
        )

    async def fake_generate_content(*args, **kwargs):
        return _Response()

    async def fake_resolve_and_price(data, **kwargs):
        return data

    monkeypatch.setattr(gemini_service, "_generate_content", fake_generate_content)
    monkeypatch.setattr(gemini_service, "_resolve_and_price_ingredients", fake_resolve_and_price)

    result = await gemini_service.analyze_food_image(b"fake-bytes", "image/jpeg", language="en")
    assert result["confidence_note"] == "portion estimated"
    for copy in gemini_service._FALLBACK_CONFIDENCE_NOTE.values():
        assert copy not in result["confidence_note"]


def test_the_fallback_note_does_not_trip_the_frontend_uncertain_tier():
    """frontend/js/scan.js's LOW_CONFIDENCE_PHRASES keyword-matches this note to
    drop the confidence badge to the "uncertain" tier, and that list is
    ENGLISH-ONLY. Copy that tripped it would give an English user a warning
    triangle and a Romanian user a sparkle for the identical situation.

    Getting the tier right for a fallback result is worth doing — but keyed off
    provenance in the frontend, not smuggled in through a substring coincidence
    in one of two languages. This test pins the current, deliberate choice so a
    later copy edit cannot reintroduce the asymmetry by accident."""
    low_confidence_phrases = [
        "hard to tell", "hard to see", "difficult to", "couldn't fully",
        "could not fully", "partially obscured", "low light", "blurry",
        "rough estimate", "uncertain", "not clearly visible", "guess", "unclear",
    ]
    for language, copy in gemini_service._FALLBACK_CONFIDENCE_NOTE.items():
        lowered = copy.lower()
        tripped = [p for p in low_confidence_phrases if p in lowered]
        assert not tripped, (
            f"{language} fallback copy contains {tripped} — that silently changes the "
            "frontend confidence badge, and only for English readers"
        )
