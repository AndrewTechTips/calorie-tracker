from datetime import date, timedelta

from data.discover_data import DISCOVER_CHALLENGES
from services.discover_challenge_service import (
    challenge_for_date,
    count_progress,
    is_complete,
    iso_week_key,
    week_bounds,
)

# A tiny stand-in recipe catalog — count_progress only ever reads `tags` and
# `calories` off each entry.
RECIPES_BY_ID = {
    "r-any": {"tags": ["quick"], "calories": 600},
    "r-ro": {"tags": ["romanian", "high-protein"], "calories": 300},
    "r-light": {"tags": ["cut"], "calories": 350},
    "r-heavy": {"tags": ["bulk"], "calories": 700},
}


def _rows(*ids):
    return [{"discover_recipe_id": i} for i in ids]


# --- iso_week_key -----------------------------------------------------------
def test_iso_week_key_format():
    assert iso_week_key(date(2026, 1, 1)) == "2026-W01"
    assert iso_week_key(date(2026, 1, 5)) == "2026-W02"


def test_iso_week_key_uses_iso_year_at_the_boundary():
    # 2027-01-01 is a Friday -> ISO week 53 of 2026, not week 1 of 2027.
    assert iso_week_key(date(2027, 1, 1)) == "2026-W53"


# --- week_bounds ---------------------------------------------------------------
def test_week_bounds_is_monday_to_sunday_inclusive():
    mon, sun = week_bounds(date(2026, 9, 2))  # a Wednesday
    assert mon == date(2026, 8, 31)
    assert sun == date(2026, 9, 6)
    assert mon.weekday() == 0
    assert sun.weekday() == 6


def test_week_bounds_on_a_sunday_stays_in_that_week():
    mon, sun = week_bounds(date(2026, 9, 6))  # the Sunday itself
    assert mon == date(2026, 8, 31)
    assert sun == date(2026, 9, 6)


# --- challenge_for_date (deterministic weekly rotation) ----------------------
def test_challenge_is_stable_within_a_week():
    monday = date(2026, 8, 31)
    for offset in range(7):
        assert challenge_for_date(monday + timedelta(days=offset))["key"] == challenge_for_date(monday)["key"]


def test_consecutive_weeks_advance_by_one_catalog_slot_and_wrap():
    n = len(DISCOVER_CHALLENGES)
    start = date(2026, 2, 2)  # a Monday, mid-year — no year-boundary week reset in range
    slots = [DISCOVER_CHALLENGES.index(challenge_for_date(start + timedelta(weeks=w))) for w in range(n + 2)]
    for a, b in zip(slots, slots[1:]):
        assert b == (a + 1) % n


def test_rotation_covers_the_whole_catalog_within_n_weeks():
    start = date(2026, 2, 2)
    seen = {challenge_for_date(start + timedelta(weeks=w))["key"] for w in range(len(DISCOVER_CHALLENGES))}
    assert seen == {c["key"] for c in DISCOVER_CHALLENGES}


def test_every_challenge_has_the_required_shape():
    for c in DISCOVER_CHALLENGES:
        assert {"key", "name", "description", "target", "rule"} <= set(c)
        assert c["target"] > 0
        assert {"en", "ro"} <= set(c["name"])
        assert {"en", "ro"} <= set(c["description"])
        assert c["rule"]["type"] in {"any", "tag", "calories_max"}


# --- count_progress ----------------------------------------------------------
def test_any_rule_counts_distinct_recipes():
    assert count_progress({"type": "any"}, _rows("r-any", "r-any", "r-ro"), RECIPES_BY_ID) == 2


def test_tag_rule_only_counts_matching_recipes():
    assert count_progress({"type": "tag", "tag": "romanian"}, _rows("r-ro", "r-any", "r-light"), RECIPES_BY_ID) == 1


def test_calories_max_rule_is_inclusive_ceiling():
    assert count_progress({"type": "calories_max", "max": 400}, _rows("r-light", "r-ro", "r-heavy"), RECIPES_BY_ID) == 2


def test_progress_ignores_null_missing_and_unknown_recipe_ids():
    rows = _rows("r-any") + [{"discover_recipe_id": None}, {"discover_recipe_id": "ghost"}, {}]
    assert count_progress({"type": "any"}, rows, RECIPES_BY_ID) == 1


def test_unknown_rule_type_counts_nothing():
    assert count_progress({"type": "moon-phase"}, _rows("r-any", "r-ro"), RECIPES_BY_ID) == 0


# --- is_complete -----------------------------------------------------------
def test_is_complete_boundary():
    assert is_complete(2, 3) is False
    assert is_complete(3, 3) is True
    assert is_complete(5, 3) is True
