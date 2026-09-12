"""Regression coverage for the lazy per-ingredient breakdown (perf audit NET-1).

`GET /logs` serves the whole retention window on every app open, and it used to
send each row's full `ingredients` array with it — up to fifteen ten-field
objects per row (sql/schema.sql's daily_logs_ingredients_bounded), routinely
several times the size of every other column on the row combined, on the request
that gates first paint. Almost nothing reads it: the breakdown matters only when
the user opens one specific entry to edit it, appends a scan to it, or saves it
as a meal. It is now fetched per entry from `GET /logs/{log_id}`.

Two hand-synced pairs came out of that split, and neither has anything tying it
together automatically — the same discipline CLAUDE.md describes for
sql/schema.sql and the Pydantic models generally:

  1. routers/logs.py::_LOG_LIST_COLUMNS, the explicit Supabase select, against
     DailyLogListItem's fields. A required field missing from the select is not
     a degraded response, it is a ValidationError during serialization — i.e.
     every GET /logs 500s, for every user, on the app's boot request.
  2. Which fields are deliberately NOT in the list shape. `ingredients` is the
     payload win itself; `custom_food_saved` is a PATCH-only signal and not a
     database column at all, so selecting it would error.

These assert on the real model and the real constant rather than on a copy of
either, so the test fails if either side moves without the other.
"""

import pytest
from pydantic import ValidationError

from models import DailyLogListItem, DailyLogResponse
from routers.logs import _LOG_LIST_COLUMNS

SELECTED_COLUMNS = set(_LOG_LIST_COLUMNS.split(","))

# A row shaped exactly as the narrowed select returns it.
ROW = {
    "id": "0c8f1b6a-0000-4000-8000-000000000001",
    "food_name": "Omleta cu branza",
    "weight_g": 180,
    "calories": 320,
    "protein": 22,
    "carbs": 3,
    "fats": 24,
    "fiber": 0,
    "sugar": 1,
    "sodium": 410,
    "workout_tag": "regular",
    "source": "ai",
    "log_date": "2026-09-12",
    "logged_at": "2026-09-12T08:00:00Z",
    "discover_recipe_id": None,
    "saved_meal_id": None,
}


def test_every_required_list_field_is_actually_selected():
    """The 500-on-boot case. A required field absent from the select reaches
    the response model as missing, and FastAPI raises during serialization —
    outside any handler try/except."""
    required = {name for name, f in DailyLogListItem.model_fields.items() if f.is_required()}
    assert not (required - SELECTED_COLUMNS), (
        f"required DailyLogListItem field(s) missing from _LOG_LIST_COLUMNS: {sorted(required - SELECTED_COLUMNS)}"
    )


def test_nothing_is_selected_that_is_not_a_field():
    """The other direction: a column name in the select that no model carries is
    either a typo (PostgREST errors) or a column being fetched for nobody."""
    known = set(DailyLogResponse.model_fields)
    assert not (SELECTED_COLUMNS - known), f"selected but not a model field: {sorted(SELECTED_COLUMNS - known)}"


def test_select_and_list_shape_match_exactly():
    """Stronger than the two directions above taken separately: the list shape
    and the select are the same set, so neither can drift silently."""
    assert set(DailyLogListItem.model_fields) == SELECTED_COLUMNS


def test_the_list_shape_omits_exactly_the_lazy_and_patch_only_fields():
    lazy = set(DailyLogResponse.model_fields) - set(DailyLogListItem.model_fields)
    assert lazy == {"ingredients", "custom_food_saved"}, sorted(lazy)


def test_a_serialised_list_row_carries_no_ingredients_key():
    """The payload assertion proper. Not 'ingredients is None' — the key must be
    absent, because a null per row is still bytes on the boot request, and its
    absence is what the frontend reads as 'not fetched yet' (app.js's
    hydrateLogIngredients treats undefined/null/array as three distinct states)."""
    dumped = DailyLogListItem.model_validate(ROW).model_dump()
    assert "ingredients" not in dumped
    assert "custom_food_saved" not in dumped


def test_full_response_still_carries_the_breakdown():
    """GET /logs/{id}, POST /logs and PATCH /logs/{id} must be unaffected —
    the breakdown moved, it was not dropped."""
    full = DailyLogResponse.model_validate(
        {
            **ROW,
            "ingredients": [
                {
                    "food_name": "oua",
                    "weight_g": 120,
                    "calories": 170,
                    "protein": 13,
                    "carbs": 1,
                    "fats": 12,
                    "fiber": 0,
                    "sugar": 0,
                    "sodium": 140,
                    "macro_source": "usda",
                }
            ],
        }
    )
    assert full.ingredients is not None and len(full.ingredients) == 1
    assert full.ingredients[0].macro_source == "usda"


def test_full_response_inherits_the_list_shape():
    """DailyLogResponse extends DailyLogListItem rather than duplicating it, so
    a field added for one is inherited by the other and the two cannot diverge
    field-by-field. Guarding the relationship, not just today's field list."""
    assert issubclass(DailyLogResponse, DailyLogListItem)
    assert set(DailyLogListItem.model_fields) < set(DailyLogResponse.model_fields)


def test_a_row_missing_a_required_column_fails_loudly():
    """Proves the first test is testing something real: drop a selected column
    and the list shape genuinely refuses to validate."""
    incomplete = {k: v for k, v in ROW.items() if k != "food_name"}
    with pytest.raises(ValidationError):
        DailyLogListItem.model_validate(incomplete)
