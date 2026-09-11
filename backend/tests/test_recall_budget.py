"""The per-request AI-call budget — the ceiling on fan-out.

ai_usage_service caps how many REQUESTS a user makes per day. This caps how
many PROVIDER CALLS one of those requests can make, which is a different
number: one gated `scan` could previously fan out to ~46 billable calls
(1 vision + 15 ingredients x (2 recall attempts + 1 micro backfill)), driven
entirely by model output. See gemini_service._MAX_AI_RECALLS_PER_REQUEST.

Everything here is offline — the point is the accounting, not the provider.
"""

import asyncio

import pytest

from services import gemini_service


@pytest.fixture(autouse=True)
def _no_real_calls(monkeypatch):
    """Every recall resolves instantly to a plausible figure, so the only
    thing under test is how many of them the budget allows."""
    calls = []

    async def fake_raw_call(food_name, **kwargs):
        calls.append(food_name)
        return {
            "calories_per_100g": 100.0, "protein_per_100g": 10.0,
            "carbs_per_100g": 10.0, "fats_per_100g": 1.0,
        }

    # Patch the layer BELOW the budget check so the spend still happens.
    monkeypatch.setattr(gemini_service, "_raw_recall_probe", fake_raw_call, raising=False)
    return calls


async def test_budget_is_unarmed_by_default():
    """A direct estimate_macros_for_food_name (routers/logs.py's rename path)
    makes one recall and is gated by its own quota — it must not be silently
    handed a budget it never asked for."""
    assert gemini_service._recall_budget.get() is None
    gemini_service._spend_recall_budget("anything")  # no-op, must not raise


async def test_budget_blocks_the_nth_plus_one_call():
    limit = gemini_service._MAX_AI_RECALLS_PER_REQUEST
    with gemini_service._recall_budget_scope():
        for i in range(limit):
            gemini_service._spend_recall_budget(f"food {i}")
        with pytest.raises(gemini_service.RecallBudgetExhaustedError):
            gemini_service._spend_recall_budget("one too many")


async def test_budget_is_shared_across_gathered_tasks():
    """The load-bearing property. The fan-out happens inside asyncio.gather,
    and a ContextVar is COPIED into each spawned task — so a decrement done by
    re-setting the var would be invisible to sibling tasks and every branch
    would get the full allowance. The mutable-box approach is what makes the
    budget actually shared; this test fails if someone 'simplifies' it back."""
    limit = gemini_service._MAX_AI_RECALLS_PER_REQUEST
    spent = 0
    blocked = 0

    async def one_ingredient(i):
        nonlocal spent, blocked
        await asyncio.sleep(0)  # force a real suspension, as a provider call would
        try:
            gemini_service._spend_recall_budget(f"food {i}")
            spent += 1
        except gemini_service.RecallBudgetExhaustedError:
            blocked += 1

    with gemini_service._recall_budget_scope():
        await asyncio.gather(*(one_ingredient(i) for i in range(limit + 8)))

    assert spent == limit, f"budget leaked: {spent} calls allowed, limit is {limit}"
    assert blocked == 8


async def test_budget_scope_is_reentrant():
    """A nested scope must not hand the request a second full allowance — that
    is how a future refactor wrapping one entry point in another would quietly
    double the ceiling."""
    with gemini_service._recall_budget_scope():
        gemini_service._spend_recall_budget("outer")
        remaining_before = gemini_service._recall_budget.get()[0]
        with gemini_service._recall_budget_scope():
            assert gemini_service._recall_budget.get()[0] == remaining_before
        assert gemini_service._recall_budget.get()[0] == remaining_before


async def test_budget_does_not_leak_between_concurrent_requests():
    """Two in-flight requests must not share a counter — a module global would
    have them starve each other."""
    limit = gemini_service._MAX_AI_RECALLS_PER_REQUEST

    async def one_request():
        with gemini_service._recall_budget_scope():
            for i in range(limit):
                await asyncio.sleep(0)
                gemini_service._spend_recall_budget(f"f{i}")
            return "ok"

    assert await asyncio.gather(one_request(), one_request()) == ["ok", "ok"]


async def test_exhausted_budget_degrades_to_an_unpriced_ingredient(monkeypatch):
    """The product-level contract: a pathological extraction must not 500 and
    must not keep spending. The ingredient survives, unpriced, for the user to
    correct — exactly how an implausible estimate already degrades."""

    async def always_exhausted(*args, **kwargs):
        raise gemini_service.RecallBudgetExhaustedError("pork")

    monkeypatch.setattr(gemini_service, "_resolve_ingredient", always_exhausted)

    out = await gemini_service._resolve_ingredient_tolerant(
        {"food_name": "pork", "weight_g": 120}, 0
    )
    assert out is not None, "budget exhaustion must not drop the ingredient"
    assert out["food_name"] == "pork"
    assert out["weight_g"] == 120
    assert out["calories"] == 0


# ---------------------------------------------------------------------------
# The GLOBAL (account-wide) spend ceiling.
#
# ai_usage_service's caps are per USER. This one is per DEPLOYMENT, and it is
# the only thing standing between a traffic spike and an unbounded bill. It
# used to be checked on exactly one route (POST /scan) and on none of the
# per-ingredient fan-out; it is now enforced inside _generate_content, which
# every Gemini call passes through.
# ---------------------------------------------------------------------------
async def test_global_capacity_ceiling_refuses_before_contacting_the_provider(monkeypatch):
    """The load-bearing property: no provider call is made once the pool is
    exhausted. A ceiling that still pays for the call it refuses is not one."""
    contacted = []

    def fake_client(*a, **k):
        contacted.append(1)
        raise AssertionError("provider was contacted despite an exhausted pool")

    monkeypatch.setattr(gemini_service.quota_service, "has_capacity", lambda pool: False)
    monkeypatch.setattr(
        gemini_service.quota_service, "candidate_pairs", lambda pool: ["gemini-3.8-flash"]
    )
    monkeypatch.setattr(gemini_service, "_get_gemini_client", fake_client)

    with pytest.raises(gemini_service.ProviderCapacityError):
        await gemini_service._generate_content(
            ["hi"], system_prompt="sys", response_schema=None
        )
    assert contacted == []


async def test_global_ceiling_is_not_reported_to_the_user_as_bad_food(monkeypatch):
    """ProviderCapacityError must stay distinct from InvalidFoodInputError.
    Conflating them would tell a user their perfectly good meal photo was
    unrecognisable when the real answer is 'the app is at its ceiling'."""
    assert not issubclass(
        gemini_service.ProviderCapacityError, gemini_service.InvalidFoodInputError
    )
    assert not issubclass(
        gemini_service.InvalidFoodInputError, gemini_service.ProviderCapacityError
    )


def test_global_ceiling_is_set_low_enough_to_bound_spend():
    """Guards the number itself, not just the mechanism. The pre-audit value
    was 10,000/day (~$1,200/month at measured per-call cost); this fails if
    someone raises it back to that class of number without doing the
    arithmetic in config.py's own comment."""
    from config import get_settings

    settings = get_settings()
    assert settings.gemini_model_rpd <= 3000, (
        f"gemini_model_rpd={settings.gemini_model_rpd} — at ~$0.004/call that is "
        f"~${settings.gemini_model_rpd * 0.004 * 30:.0f}/month of headroom. "
        "Re-read config.py's arithmetic before raising this."
    )
    assert settings.gemini_composite_model_rpd <= 1000
