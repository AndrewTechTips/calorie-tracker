"""POST /scan must not charge a scan for a failure the user cannot act on.

THE BUG THIS GUARDS (reported as "422 on a good photo, and it still ate one
of my daily scans"). `_parse_json_response` raised the same exception —
InvalidFoodInputError — for two conditions that mean opposite things:

  * the model followed the contract and returned {"error": "invalid_input"},
    i.e. a real verdict that the input is not food. Billed, 422, no refund:
    the user got an answer, just a negative one.
  * the model's response never arrived in a usable state at all — truncated
    mid-JSON by MAX_TOKENS, prose instead of JSON, valid JSON that is not an
    object, or an object missing schema-required fields. Nothing judged the
    photo.

The router could not tell them apart, so the second class was reported as
"Couldn't identify food in that image" AND charged. Six distinct backend
failures, one misleading message, one wrongly-spent credit.

These tests pin the split: only a genuine verdict is allowed to keep the
user's money, and only a genuine verdict is allowed to say the photo was the
problem.
"""
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import main
import routers.scan as scan_router
import services.gemini_service as gemini_service
from auth import get_current_user
from rate_limit import limiter
from services import ai_usage_service, quota_service
from services.gemini_service import InvalidFoodInputError, ModelResponseUnusableError


class _FakeUser:
    id = "11111111-1111-1111-1111-111111111111"


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (220, 190, 90)).save(buf, format="JPEG")
    return buf.getvalue()


JPEG = _jpeg()

# A well-formed Stage 1 extraction result (identification only — Stage 2/3
# does the pricing), matching EXTRACTION_RESPONSE_SCHEMA.
STAGE1_OK = json.dumps(
    {
        "food_name": "Omleta",
        "confidence_note": "",
        "ingredients": [
            {"food_name": "Oua", "search_name": "egg, whole, cooked", "weight_g": 150},
        ],
    }
)


@pytest.fixture
def ledger(monkeypatch):
    """Counts what the per-user daily quota actually spent, net of refunds."""
    counts = {"consumed": 0, "refunded": 0}

    async def _has_capacity(user_id, feature):
        return True

    async def _try_consume(user_id, feature):
        counts["consumed"] += 1
        return True

    async def _refund(user_id, feature):
        counts["refunded"] += 1

    async def _quota_message(user_id, feature):
        return "out of scans"

    monkeypatch.setattr(ai_usage_service, "has_capacity", _has_capacity)
    monkeypatch.setattr(ai_usage_service, "try_consume", _try_consume)
    monkeypatch.setattr(ai_usage_service, "refund", _refund)
    monkeypatch.setattr(ai_usage_service, "quota_message", _quota_message)
    monkeypatch.setattr(quota_service, "has_capacity", lambda pool: True)
    counts["net"] = 0
    yield counts


@pytest.fixture
def client(monkeypatch):
    # The route's own "3/10 seconds" burst clause would reject the later
    # cases in a fast test run; it is not what these tests are about.
    monkeypatch.setattr(limiter, "enabled", False)
    main.app.dependency_overrides[get_current_user] = lambda: _FakeUser()
    try:
        yield TestClient(main.app, raise_server_exceptions=False)
    finally:
        main.app.dependency_overrides.pop(get_current_user, None)


def _post(client):
    return client.post(
        "/scan",
        files={"image": ("photo.jpg", JPEG, "image/jpeg")},
        data={"context_text": "", "attached_items": "[]", "language": "ro"},
    )


def _net(ledger):
    return ledger["consumed"] - ledger["refunded"]


def _stub_stage1(monkeypatch, *responses):
    """Make each successive Stage 1 attempt return the next raw body."""
    seen = []

    async def _fake_generate_content(*args, **kwargs):
        seen.append(kwargs.get("max_output_tokens"))
        body = responses[min(len(seen) - 1, len(responses) - 1)]

        class _Response:
            text = body
            candidates = []

        return _Response()

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
    return seen


# --- the exception contract itself -----------------------------------------


def test_unusable_is_a_subclass_so_existing_handlers_cannot_regress():
    """Several callers (routers/coach.py, the free-tier features) only care
    that the model gave them nothing usable and are correct either way. The
    subclass relationship is what lets those sites stay untouched instead of
    turning into uncaught exceptions."""
    assert issubclass(ModelResponseUnusableError, InvalidFoodInputError)


@pytest.mark.parametrize(
    "body",
    [
        pytest.param('{"food_name": "Omle', id="truncated_mid_json"),
        pytest.param("This looks like a cheese omelette.", id="prose_not_json"),
        pytest.param('[{"food_name": "Omleta"}]', id="json_array_not_object"),
        pytest.param("", id="empty_body"),
    ],
)
def test_parse_failures_are_unusable_not_a_verdict(body):
    with pytest.raises(ModelResponseUnusableError):
        gemini_service._parse_json_response(body)


def test_invalid_input_stays_a_plain_verdict():
    """Must NOT be the unusable subclass — this one is allowed to keep the
    user's scan, and is the only condition that is."""
    with pytest.raises(InvalidFoodInputError) as excinfo:
        gemini_service._parse_json_response('{"error": "invalid_input"}')
    assert not isinstance(excinfo.value, ModelResponseUnusableError)


# --- the route contract -----------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        pytest.param('{"food_name": "Omle', id="truncated_mid_json"),
        pytest.param("This looks like a cheese omelette.", id="prose_not_json"),
        pytest.param('[{"food_name": "Omleta"}]', id="json_array_not_object"),
        pytest.param('{"food_name": "Omleta"}', id="object_missing_ingredients"),
        pytest.param("", id="empty_body"),
    ],
)
def test_unusable_response_refunds_the_scan_and_does_not_blame_the_photo(
    client, ledger, monkeypatch, body
):
    _stub_stage1(monkeypatch, body)
    response = _post(client)

    assert _net(ledger) == 0, "a failure the user cannot act on must not cost a scan"
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "identify" not in detail.lower(), "must not blame a photo nothing ever judged"


def test_genuine_invalid_input_verdict_still_422_and_still_charged(
    client, ledger, monkeypatch
):
    """The deliberate exception to the refund rule: a real, billed provider
    call looked at the input and answered. See ai_usage_service.refund."""
    _stub_stage1(monkeypatch, '{"error": "invalid_input"}')
    response = _post(client)

    assert response.status_code == 422
    assert _net(ledger) == 1


# --- the Stage 1 retry ------------------------------------------------------


def test_truncated_first_attempt_is_retried_at_a_bigger_budget_and_succeeds(
    client, ledger, monkeypatch
):
    """The reported symptom: a good photo, a truncated Stage 1 answer, and a
    dead end. A MAX_TOKENS truncation is a budget problem, so the retry has
    to actually raise the budget — repeating the same request would truncate
    in exactly the same place."""
    seen = _stub_stage1(monkeypatch, '{"food_name": "Omle', STAGE1_OK)
    response = _post(client)

    assert response.status_code == 200
    assert len(seen) == 2, "an unusable Stage 1 answer must be retried once"
    assert seen[1] > seen[0], "the retry must get a larger output allowance"
    assert _net(ledger) == 1


def test_a_clean_first_answer_costs_exactly_one_call(client, ledger, monkeypatch):
    """The retry must be reached only on failure — it is a billed call."""
    seen = _stub_stage1(monkeypatch, STAGE1_OK)
    response = _post(client)

    assert response.status_code == 200
    assert len(seen) == 1
    assert _net(ledger) == 1


def test_a_verdict_is_never_retried(client, ledger, monkeypatch):
    """Asking the same question again with a bigger budget just buys the same
    verdict twice. Only unusable answers are worth a second call."""
    seen = _stub_stage1(monkeypatch, '{"error": "invalid_input"}', STAGE1_OK)
    response = _post(client)

    assert response.status_code == 422
    assert len(seen) == 1
