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


# ---------------------------------------------------------------------------
# Thinking-token headroom.
#
# Found by live production QA, not by reasoning: thinking tokens DO count
# against max_output_tokens on Gemini 3.8, which Phase 2 had assumed they no
# longer did. Measured on a real scan of a sarmale plate:
#   vision   medium  334 thinking + 315 answer = 649 of 700  (93% used)
#   chef     high    769 thinking +  17 answer = MAX_TOKENS, answer never
#                    written, main dish silently dropped from the meal
# See gemini_service._THINKING_TOKEN_RESERVE for the full writeup.
# ---------------------------------------------------------------------------
def test_thinking_reserve_covers_the_measured_usage():
    """The reserves must exceed what was actually observed, or the bug this
    was written for comes straight back."""
    r = gemini_service._THINKING_TOKEN_RESERVE
    assert r["medium"] > 334, "measured 334 thinking tokens on a real vision call"
    assert r["high"] > 769, "measured 769 on a call that then truncated — a FLOOR, not a peak"
    assert r["low"] < r["medium"] < r["high"], (
        "the levels must stay ordered: a level told to think harder cannot be "
        "given less room than the one below it"
    )

    # 2026-09-11 re-measurement (27 real scans, 33 Stage-1 vision calls, every
    # call's usage_metadata recorded). The old medium=768 truncated 43% of
    # first attempts; these are the numbers that replaced it.
    assert r["medium"] > 2090, (
        "measured peak thinking on a completed Stage-1 vision call was 2090 — "
        "a reserve at or below it reinstates the truncation this was raised for"
    )
    # The peak came from a call whose own ceiling was only 78 tokens above it,
    # so it samples a tail rather than ending one. Headroom is multiplicative.
    assert r["medium"] >= 2090 * 1.1, "keep ~10% above the observed peak, not 'peak plus a bit'"


def test_stage1_first_attempt_budget_fits_the_measured_demand():
    """The first rung and the reserve are one pool — thinking and answer draw
    from the same max_output_tokens — so what matters is their TOTAL.

    Measured across 23 completed Stage-1 calls: thinking peaked at 2090, the
    visible answer peaked at 221. A first attempt that cannot hold both is the
    truncate-then-retry cycle that cost 31% of a measured Gemini bill."""
    first_rung = gemini_service._STAGE1_ANSWER_TOKEN_LADDER[0]
    budget = gemini_service._with_thinking_headroom(first_rung, "medium")

    assert first_rung >= 221, "the visible answer measured 73-221 tokens"
    assert budget >= 2090 + 221, "one attempt must hold peak thinking AND a full answer"
    assert budget >= (2090 + 221) * 1.15, "with headroom, since 2090 samples a tail"

    # The ladder must still ESCALATE — the retry exists to buy room the first
    # attempt did not have.
    assert gemini_service._STAGE1_ANSWER_TOKEN_LADDER[1] > first_rung


def test_headroom_is_added_on_top_of_the_answer_allowance():
    f = gemini_service._with_thinking_headroom
    assert f(700, None) == 700, "no thinking configured means no reserve"
    assert f(700, "medium") == 700 + gemini_service._THINKING_TOKEN_RESERVE["medium"]
    assert f(800, "high") == 800 + gemini_service._THINKING_TOKEN_RESERVE["high"]
    # An unrecognised level must not silently drop the reserve to zero — that
    # is the exact failure mode being fixed.
    assert f(600, "nonsense") >= 600 + gemini_service._THINKING_TOKEN_RESERVE["medium"]
    assert f(600, "HIGH") == 600 + gemini_service._THINKING_TOKEN_RESERVE["high"]


def test_composite_chef_budget_would_not_have_truncated():
    """Regression on the exact observed numbers: the chef path must now fit
    769 thinking tokens plus a real scratchpad answer."""
    budget = gemini_service._with_thinking_headroom(800, "high")
    assert budget >= 769 + 800, f"chef budget {budget} still too tight for the measured usage"


def test_truncation_detector_is_defensive_about_shape():
    """Runs on the success path of every Gemini call — a shape it does not
    recognise must read as 'not truncated', never raise."""
    d = gemini_service._finish_reason_is_truncation

    class _C:
        def __init__(self, fr): self.finish_reason = fr

    class _R:
        def __init__(self, fr): self.candidates = [_C(fr)]

    assert d(_R("FinishReason.MAX_TOKENS")) is True
    assert d(_R("MAX_TOKENS")) is True
    assert d(_R("FinishReason.STOP")) is False
    assert d(object()) is False          # no .candidates at all
    assert d(_R(None)) is False
