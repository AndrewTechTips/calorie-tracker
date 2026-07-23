from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from models import DayTrend, TrendsResponse

# A day counts as "adherent" for the streak if it has at least one log (so an
# empty/unused day never silently counts as a win) and its total calories
# land within this fraction of the daily target — same ±10% tolerance the
# dashboard's own status banner logic (frontend/js/coach.js) is built around.
ADHERENCE_TOLERANCE = 0.10


def parse_date(iso_string: str) -> str:
    """Supabase returns timestamptz as an ISO string; normalize 'Z' (which
    older Python's fromisoformat can't parse) and take just the UTC date."""
    return datetime.fromisoformat(iso_string.replace("Z", "+00:00")).astimezone(timezone.utc).date().isoformat()


def compute_trends(
    log_rows: list[dict],
    water_rows: list[dict],
    weight_rows: list[dict],
    *,
    retention_days: int,
    target_calories: float,
    today: date | None = None,
) -> TrendsResponse:
    """Pure aggregation: groups raw daily_logs/water_logs/weight_logs rows
    (already fetched within the retained window) into one entry per calendar
    day, plus the current adherence streak. Kept side-effect-free and
    Supabase-independent on purpose so it's trivially unit-testable — see
    backend/tests/test_trends_service.py."""
    today = today or datetime.now(timezone.utc).date()

    totals: dict[str, dict] = defaultdict(lambda: {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0})
    for row in log_rows:
        day = parse_date(row["logged_at"])
        totals[day]["calories"] += row["calories"]
        totals[day]["protein"] += row["protein"]
        totals[day]["carbs"] += row["carbs"]
        totals[day]["fats"] += row["fats"]

    water_totals: dict[str, int] = defaultdict(int)
    for row in water_rows:
        water_totals[parse_date(row["logged_at"])] += row["amount_ml"]

    # If multiple weigh-ins happened the same day, the latest one wins.
    weight_by_day: dict[str, float] = {}
    for row in sorted(weight_rows, key=lambda r: r["logged_at"]):
        weight_by_day[parse_date(row["logged_at"])] = row["weight_kg"]

    days: list[DayTrend] = []
    for offset in range(retention_days - 1, -1, -1):
        day_key = (today - timedelta(days=offset)).isoformat()
        day_totals = totals.get(day_key, {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0})
        has_logs = day_key in totals
        adherent = has_logs and abs(day_totals["calories"] - target_calories) <= target_calories * ADHERENCE_TOLERANCE
        days.append(
            DayTrend(
                date=day_key,
                calories=day_totals["calories"],
                protein=day_totals["protein"],
                carbs=day_totals["carbs"],
                fats=day_totals["fats"],
                water_ml=water_totals.get(day_key, 0),
                weight_kg=weight_by_day.get(day_key),
                adherent=adherent,
            )
        )

    # Counts consecutive adherent days ending at the most recent *completed*
    # day. Today is skipped rather than judged while it has zero logs yet —
    # the day isn't over, so "nothing logged so far" must never zero out an
    # otherwise-intact streak. If today already has logs, it's judged
    # normally (a bad day logged so far legitimately breaks the streak).
    today_key = today.isoformat()
    streak = 0
    for day in reversed(days):  # most recent first
        if day.date == today_key and day.date not in totals:
            continue
        if not day.adherent:
            break
        streak += 1

    return TrendsResponse(days=days, streak=streak)
