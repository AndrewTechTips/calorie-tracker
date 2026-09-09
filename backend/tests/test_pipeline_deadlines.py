"""Diagnostic F5/F6 regression pins: quota refunds on a non-answer, and the
end-to-end deadlines that stop a provider fallover chain from running long
past the point the client gave up.

Both bugs were invisible from the unit-test layer before this file existed,
because neither is about a wrong VALUE — F5 was a missing operation (nothing
in the codebase could give a spent credit back) and F6 was a missing ceiling
(every individual HTTP call was bounded; the walk across candidates was not).
The tests here therefore assert on control flow and elapsed time rather than
on macros.
"""

import asyncio
import time

import pytest

from services import ai_usage_service, gemini_service


# ---------------------------------------------------------------------------
# F6 — per-ingredient pricing deadline
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_ingredient_pricing_deadline_degrades_to_unpriced_not_dropped(monkeypatch):
    """An ingredient whose pricing runs out of budget must survive as an
    UNPRICED row, not disappear.

    Dropping it would make the meal total silently too low with nothing on
    screen to explain the gap — the exact class of quiet wrongness this
    pipeline exists to avoid. Keeping the name and weight lets the user
    price it from the review form like any other estimate.
    """
    monkeypatch.setattr(gemini_service, "_INGREDIENT_RESOLVE_TIMEOUT_SECONDS", 0.2)

    async def never_returns(item):
        await asyncio.sleep(30)

    monkeypatch.setattr(gemini_service, "_resolve_ingredient", never_returns)

    data = await gemini_service._resolve_and_price_ingredients(
        {
            "food_name": "Omleta",
            "ingredients": [
                {"food_name": "Eggs", "search_name": "egg", "weight_g": 100, "is_composite": False},
                {"food_name": "Cheese", "search_name": "cheese", "weight_g": 30, "is_composite": False},
            ],
        }
    )

    assert len(data["ingredients"]) == 2, "a timed-out ingredient must be kept, not filtered out"
    for item in data["ingredients"]:
        # macro_source None is the honest "no source at all" signal, and is
        # distinct from "ai_estimate" (a real, if weak, provenance).
        assert item["macro_source"] is None
        assert item["calories"] == 0
    # Identification survives even though pricing didn't.
    assert [i["food_name"] for i in data["ingredients"]] == ["Eggs", "Cheese"]
    assert data["weight_g"] == 130.0
    assert data["calories"] == 0


@pytest.mark.asyncio
async def test_ingredient_deadline_is_paid_once_not_once_per_ingredient(monkeypatch):
    """Ingredients resolve concurrently (asyncio.gather), so the budget is a
    ceiling for the whole meal, not a per-component cost. A 6-ingredient
    plate must not cost 6x a 1-ingredient one — that multiplication was the
    original latency bug's shape."""
    monkeypatch.setattr(gemini_service, "_INGREDIENT_RESOLVE_TIMEOUT_SECONDS", 0.3)

    async def never_returns(item):
        await asyncio.sleep(30)

    monkeypatch.setattr(gemini_service, "_resolve_ingredient", never_returns)

    started = time.monotonic()
    await gemini_service._resolve_and_price_ingredients(
        {
            "food_name": "Big plate",
            "ingredients": [
                {"food_name": f"Item {i}", "search_name": "food", "weight_g": 50, "is_composite": False}
                for i in range(6)
            ],
        }
    )
    elapsed = time.monotonic() - started
    assert elapsed < 1.0, f"6 ingredients took {elapsed:.2f}s — they are resolving serially, not concurrently"


@pytest.mark.asyncio
async def test_malformed_ingredient_is_still_dropped_not_kept_unpriced(monkeypatch):
    """The timeout branch must not swallow the pre-existing malformed-item
    behavior: a non-dict / non-numeric item has nothing worth showing the
    user, so it is still dropped entirely."""

    async def boom(item):
        raise ValueError("not a real ingredient")

    monkeypatch.setattr(gemini_service, "_resolve_ingredient", boom)

    data = await gemini_service._resolve_and_price_ingredients(
        {
            "food_name": "Rice",
            "weight_g": 200,
            "ingredients": [{"food_name": "Rice", "search_name": "rice", "weight_g": 200}],
        }
    )
    # Falls all the way through to the deterministic zero placeholder, which
    # is _resolve_and_price_ingredients' own pre-existing "everything failed"
    # path — not an unpriced-by-deadline row.
    assert len(data["ingredients"]) == 1
    assert data["ingredients"][0]["calories"] == 0


# ---------------------------------------------------------------------------
# F6 — Stage 1 extraction deadline
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stage1_text_extraction_has_a_hard_deadline(monkeypatch):
    """The Task B chain walks 4 Mistral models, then 4 Groq models, then
    native Gemini — 9 candidates at 15s each. Unbounded, that is ~135s
    against a client that aborts at 30-45s. The deadline must fire and must
    surface as asyncio.TimeoutError, which is what the routers refund on."""
    monkeypatch.setattr(gemini_service, "_STAGE1_EXTRACTION_TIMEOUT_SECONDS", 0.2)

    async def never_returns(*args, **kwargs):
        await asyncio.sleep(30)

    monkeypatch.setattr(gemini_service, "_call_openai_compatible", never_returns)

    started = time.monotonic()
    with pytest.raises(asyncio.TimeoutError):
        await gemini_service.estimate_from_description("100g rice and 2 eggs")
    assert time.monotonic() - started < 1.0


def test_deadline_budget_fits_under_the_client_abort():
    """Stage 1 + one concurrent round of ingredient pricing must leave real
    headroom under the frontend's 45s abort (api.js::scanFood). If someone
    raises either constant, this is the check that says the budget no longer
    adds up."""
    worst_case = (
        gemini_service._STAGE1_EXTRACTION_TIMEOUT_SECONDS
        + gemini_service._INGREDIENT_RESOLVE_TIMEOUT_SECONDS
    )
    assert worst_case <= 35.0, f"backend worst case is {worst_case}s — too close to the 45s client abort"


# ---------------------------------------------------------------------------
# F5 — quota refund
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_refund_calls_the_inverse_rpc_with_the_monthly_axis_flagged(monkeypatch):
    """The two axes are spent together by try_consume, so they must be
    returned together. "scan" is daily-only; "weekly_recap" is the one
    monthly-gated feature."""
    calls = []

    class _FakeSupabase:
        def rpc(self, name, params):
            calls.append((name, params))

            class _Exec:
                def execute(self_inner):
                    return None

            return _Exec()

    monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: _FakeSupabase())

    await ai_usage_service.refund("user-1", "scan")
    await ai_usage_service.refund("user-1", "weekly_recap")

    assert [c[0] for c in calls] == ["refund_ai_feature_usage", "refund_ai_feature_usage"]
    assert calls[0][1]["p_feature"] == "scan"
    assert calls[0][1]["p_refund_monthly"] is False
    assert calls[1][1]["p_refund_monthly"] is True


@pytest.mark.asyncio
async def test_refund_never_raises(monkeypatch):
    """A refund runs from an exception handler, often when Supabase is
    exactly the thing that just failed. It must never replace the caller's
    real, already-diagnosed error with a second one — nor escape past the
    handler that attaches CORS headers, which would turn a readable 500 into
    an opaque browser network failure."""

    class _BrokenSupabase:
        def rpc(self, name, params):
            raise RuntimeError("supabase is down")

    monkeypatch.setattr(ai_usage_service, "get_supabase", lambda: _BrokenSupabase())

    await ai_usage_service.refund("user-1", "scan")  # must not raise
