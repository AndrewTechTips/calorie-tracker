"""Phase 3 hardening — the failsafe-JSON-parsing half of the AI-output
redesign (see CLAUDE.md's own "From Ledger to Bento" proposal thread).
Covers the two new rungs added to gemini_service.py's parsing pipeline:

1. _parse_json_response's repair pass for common near-misses (a trailing
   comma before a closing bracket/brace, "smart" typographic quotes) —
   tried only after a plain json.loads on the untouched text has already
   failed, so a well-formed response is never touched by it.
2. _resolve_and_price_ingredients' per-ingredient tolerance: one malformed
   ingredient (a non-numeric weight_g, a non-dict item) is dropped and
   logged instead of failing the whole scan alongside every other,
   genuinely fine, ingredient in the same response.

NUTRITION_DB_GROUNDING_ENABLED is forced false in conftest.py, so these
tests use ingredients with every explicit_* field set — that's the one
_resolve_ingredient branch that does pure arithmetic with no database/AI
network call, keeping this a real unit test.
"""
import pytest

from services.gemini_service import (
    InvalidFoodInputError,
    _parse_json_response,
    _repair_near_miss_json,
    _resolve_and_price_ingredients,
)


def test_parse_json_response_strips_code_fence():
    raw = '```json\n{"food_name": "Apple"}\n```'
    assert _parse_json_response(raw) == {"food_name": "Apple"}


def test_parse_json_response_repairs_trailing_comma_in_object():
    raw = '{"food_name": "Apple", "weight_g": 100,}'
    assert _parse_json_response(raw) == {"food_name": "Apple", "weight_g": 100}


def test_parse_json_response_repairs_trailing_comma_in_array():
    raw = '{"tags": ["fruit", "raw",]}'
    assert _parse_json_response(raw) == {"tags": ["fruit", "raw"]}


def test_parse_json_response_repairs_smart_quotes():
    raw = "{“food_name”: “Apple”}"
    assert _parse_json_response(raw) == {"food_name": "Apple"}


def test_parse_json_response_repairs_smart_quotes_and_trailing_comma_together():
    raw = "{“food_name”: “Apple”, “weight_g”: 100,}"
    assert _parse_json_response(raw) == {"food_name": "Apple", "weight_g": 100}


def test_parse_json_response_still_raises_on_genuinely_broken_json():
    # The repair pass is narrow by design — this isn't a near-miss, it's not
    # JSON at all, and must still fail loudly rather than guess.
    with pytest.raises(InvalidFoodInputError):
        _parse_json_response("Sure, here's the food: chicken and rice.")


def test_parse_json_response_still_rejects_invalid_input_sentinel():
    raw = '{"error": "invalid_input", "message": "not food"}'
    with pytest.raises(InvalidFoodInputError):
        _parse_json_response(raw)


def test_repair_near_miss_json_leaves_well_formed_json_unchanged():
    # The repair pass must be a no-op on already-valid JSON — it should never
    # be able to change the meaning of a well-formed response, since
    # _parse_json_response only ever calls it after a plain parse failed.
    raw = '{"a": 1, "b": [1, 2, 3], "c": "note, with a comma"}'
    assert _repair_near_miss_json(raw) == raw


def _stage1_item(food_name, weight_g, calories, protein=0.0, carbs=0.0, fats=0.0):
    """A Stage-1-shaped raw extraction item with every explicit_* field set
    — the one _resolve_ingredient branch that's pure arithmetic, no
    database/AI call, keeping these tests real unit tests."""
    return {
        "food_name": food_name,
        "search_name": food_name,
        "weight_g": weight_g,
        "explicit_calories": calories,
        "explicit_protein": protein,
        "explicit_carbs": carbs,
        "explicit_fats": fats,
    }


async def test_resolve_and_price_ingredients_drops_one_malformed_ingredient():
    # A stray non-numeric weight_g (a real shape a language model can emit
    # despite strict-JSON-mode enforcing which keys exist, never that every
    # value is well-typed) must not take the other two, genuinely fine,
    # ingredients down with it.
    data = {
        "food_name": "Mixed plate",
        "ingredients": [
            _stage1_item("Chicken breast", 150, 250, protein=45, fats=6),
            _stage1_item("Mystery sauce", "a splash", 50, protein=1, carbs=5, fats=2),
            _stage1_item("Rice", 120, 155, protein=3, carbs=34),
        ],
    }
    result = await _resolve_and_price_ingredients(data)
    assert [i["food_name"] for i in result["ingredients"]] == ["Chicken breast", "Rice"]
    assert result["calories"] == 405  # 250 + 155 — the malformed one excluded, not zeroed


async def test_resolve_and_price_ingredients_falls_back_when_every_ingredient_is_malformed():
    # A much stronger signal than one bad item — this must degrade to a
    # deterministic zero-value placeholder (never a fresh database/AI call,
    # which can itself fail — see this fallback's own comment for the
    # live-verified failure mode that would otherwise reintroduce) rather
    # than a hard failure on a scan the user is actively waiting on.
    data = {
        "food_name": "Fallback dish",
        "weight_g": 200,
        "ingredients": [
            _stage1_item("A", "not a number", 10),
            "not even an object",
        ],
    }
    result = await _resolve_and_price_ingredients(data)
    assert len(result["ingredients"]) == 1
    assert result["ingredients"][0]["food_name"] == "Fallback dish"
    assert result["ingredients"][0]["calories"] == 0
    assert result["ingredients"][0]["macro_source"] is None
    assert result["weight_g"] == 200
    assert result["calories"] == 0
