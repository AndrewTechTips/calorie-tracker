"""Read-time aggregation for the Discover "closing the loop" activity view
(GET /discover/activity, Phase 2).

Pure functions only — no Supabase/HTTP calls, same "kept side-effect-free
and independently unit-tested" discipline as trends_service.compute_trends
and notification_service's eligibility helpers. The router fetches the raw
daily_logs rows (over the retention window) and hands them here; everything
below is deterministic given its inputs.
"""

from datetime import datetime

# A recipe is "in your rotation" once you've cooked it at least this many
# times within the retained window. 2 is the lowest value that still means
# "you came back to this one" rather than "you tried it once".
ROTATION_MIN_TIMES = 2
# Cap the rail so a very active week can't produce an unbounded horizontal
# scroll — the tail past this is the least-repeated anyway.
ROTATION_LIMIT = 8


def _parse_ts(value) -> datetime:
    """logged_at comes back from Supabase as an ISO-8601 string (sometimes
    'Z'-suffixed). Tolerant parse so one odd row can't break the rollup;
    an unparseable timestamp sorts oldest rather than raising."""
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return datetime.min


def summarize_activity(rows: list[dict], total_recipes: int) -> dict:
    """Roll `rows` (each a daily_logs row with at least `discover_recipe_id`
    and `logged_at`) up into the GET /discover/activity payload shape.

    - `cooked_count`: distinct non-null discover_recipe_id values.
    - `rotation`: recipes cooked ROTATION_MIN_TIMES+ in the window, ordered
      most-cooked first, then most-recently-cooked first, capped at
      ROTATION_LIMIT.

    Rows with no discover_recipe_id (the overwhelming majority of real
    daily_logs rows — manual/scan/barcode logs) are ignored.
    """
    times: dict[str, int] = {}
    last_at: dict[str, datetime] = {}
    for row in rows:
        recipe_id = row.get("discover_recipe_id")
        if not recipe_id:
            continue
        times[recipe_id] = times.get(recipe_id, 0) + 1
        ts = _parse_ts(row.get("logged_at"))
        if recipe_id not in last_at or ts > last_at[recipe_id]:
            last_at[recipe_id] = ts

    rotation = sorted(
        (
            {"recipe_id": rid, "times_cooked": n, "last_cooked_at": last_at[rid]}
            for rid, n in times.items()
            if n >= ROTATION_MIN_TIMES
        ),
        key=lambda e: (e["times_cooked"], e["last_cooked_at"]),
        reverse=True,
    )[:ROTATION_LIMIT]

    return {
        "total_recipes": total_recipes,
        "cooked_count": len(times),
        "rotation": rotation,
    }
