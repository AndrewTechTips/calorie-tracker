from services.discover_service import ROTATION_LIMIT, ROTATION_MIN_TIMES, summarize_activity


def _row(recipe_id, logged_at):
    return {"discover_recipe_id": recipe_id, "logged_at": logged_at}


def test_empty_input_is_all_zero():
    out = summarize_activity([], total_recipes=39)
    assert out == {"total_recipes": 39, "cooked_count": 0, "rotation": []}


def test_counts_distinct_recipes_and_ignores_non_discover_rows():
    rows = [
        _row("ro-sarmale", "2026-08-30T18:00:00+00:00"),
        _row("ro-sarmale", "2026-08-31T18:00:00+00:00"),
        _row("intl-turkey-stirfry", "2026-08-29T12:00:00+00:00"),
        {"discover_recipe_id": None, "logged_at": "2026-08-31T09:00:00+00:00"},  # a normal manual log
        {"logged_at": "2026-08-31T09:05:00+00:00"},  # older row, column absent entirely
    ]
    out = summarize_activity(rows, total_recipes=39)
    assert out["cooked_count"] == 2  # sarmale + stir-fry, the null/missing rows don't count


def test_rotation_needs_repeat_and_is_ordered_by_count_then_recency():
    rows = [
        _row("a", "2026-08-20T18:00:00+00:00"),
        _row("a", "2026-08-21T18:00:00+00:00"),
        _row("a", "2026-08-22T18:00:00+00:00"),  # a: 3x
        _row("b", "2026-08-25T18:00:00+00:00"),
        _row("b", "2026-08-26T18:00:00+00:00"),  # b: 2x, more recent than a
        _row("c", "2026-08-27T18:00:00+00:00"),  # c: 1x -> not in rotation
    ]
    out = summarize_activity(rows, total_recipes=39)
    assert [e["recipe_id"] for e in out["rotation"]] == ["a", "b"]
    assert out["rotation"][0]["times_cooked"] == 3
    assert out["rotation"][1]["last_cooked_at"].isoformat() == "2026-08-26T18:00:00+00:00"


def test_rotation_min_times_boundary():
    rows = [_row("x", "2026-08-20T18:00:00+00:00")] * ROTATION_MIN_TIMES
    assert len(summarize_activity(rows, total_recipes=39)["rotation"]) == 1
    assert summarize_activity(rows[:-1], total_recipes=39)["rotation"] == []


def test_rotation_is_capped():
    rows = []
    for i in range(ROTATION_LIMIT + 5):
        rid = f"r{i}"
        rows += [_row(rid, "2026-08-20T18:00:00+00:00"), _row(rid, "2026-08-21T18:00:00+00:00")]
    assert len(summarize_activity(rows, total_recipes=39)["rotation"]) == ROTATION_LIMIT
