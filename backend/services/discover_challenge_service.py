"""Pure logic for the Discover weekly challenge (Phase 3, "The Payoff").

No Supabase/HTTP calls — same side-effect-free, independently-unit-tested
discipline as trends_service.compute_trends, discover_service.summarize_activity
and notification_service's eligibility helpers. The impure orchestration
(reading daily_logs, writing public.discover_challenges, healing an Ollie
heart) lives in services/pet_scheduler.py's sweep and routers/discover.py;
everything here is deterministic given its inputs.

The catalog of challenges (bilingual copy + the scoring `rule`) lives in
data/discover_data.py's DISCOVER_CHALLENGES — this module only decides which
one a given week gets and how far along a set of cooked-recipe rows is.
"""

from datetime import date, timedelta

from data.discover_data import DISCOVER_CHALLENGES


def iso_week_key(d: date) -> str:
    """The stable per-week key persisted in public.discover_challenges, e.g.
    "2026-W35". Uses the ISO year/week (not the calendar year) so the
    week-1 / week-52-53 boundary is consistent — `date(2027, 1, 1)` is
    ISO week 53 of 2026, and gets "2026-W53"."""
    iso = d.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def challenge_for_date(d: date) -> dict:
    """Which DISCOVER_CHALLENGES entry is active for the week containing `d`.
    Deterministic rotation by ISO-week number (1..53) modulo the catalog
    size, so every user working in the same week sees the same challenge and
    it advances by exactly one each week. Independent of list position
    identity — reordering the catalog is safe, it just changes the future
    schedule."""
    return DISCOVER_CHALLENGES[(d.isocalendar()[1] - 1) % len(DISCOVER_CHALLENGES)]


def week_bounds(d: date) -> tuple[date, date]:
    """(Monday, Sunday) of the ISO week containing `d`, inclusive — the
    date range daily_logs.log_date rows are filtered to when scoring
    progress. The whole current week always fits inside the 7-day retention
    window (a Monday row is at most ~6 days old on the following Sunday), so
    the active challenge never loses data to cleanup; a past week can, which
    is why only the current week is ever evaluated."""
    monday = d - timedelta(days=d.weekday())
    return monday, monday + timedelta(days=6)


def recipe_qualifies(rule: dict, recipe: dict) -> bool:
    """Whether one cooked recipe counts toward a challenge, per its `rule`
    (see DISCOVER_CHALLENGES' module comment for the shapes). An unknown
    rule type counts nothing rather than raising — a forward-compatible
    default if the catalog ever grows a type this deploy doesn't know."""
    kind = rule.get("type")
    if kind == "any":
        return True
    if kind == "tag":
        return rule.get("tag") in (recipe.get("tags") or [])
    if kind == "calories_max":
        return (recipe.get("calories") or 0) <= rule["max"]
    return False


def count_progress(rule: dict, rows: list[dict], recipes_by_id: dict) -> int:
    """How many DISTINCT qualifying Discover recipes appear in `rows` (each a
    daily_logs row with a `discover_recipe_id`). Cooking the same dish twice
    is one toward the goal. Rows with no id, or an id not in the catalog
    (`recipes_by_id`), are ignored — same tolerance as
    discover_service.summarize_activity."""
    seen: set[str] = set()
    for row in rows:
        recipe_id = row.get("discover_recipe_id")
        if not recipe_id or recipe_id in seen:
            continue
        recipe = recipes_by_id.get(recipe_id)
        if recipe is not None and recipe_qualifies(rule, recipe):
            seen.add(recipe_id)
    return len(seen)


def is_complete(progress: int, target: int) -> bool:
    return progress >= target
