from collections import defaultdict
from datetime import datetime, timezone

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
    current_day_number: int,
) -> TrendsResponse:
    """Pure aggregation: groups raw daily_logs/water_logs rows into one entry
    per *logical* day (profiles.current_day_number at the time each row was
    written — see backend/services/day_service.py and the day_number column
    comment in sql/schema.sql), not per calendar date. This is deliberate:
    pressing "End Day" more than once on the same real date must show up as
    two separate rows here, since that's what "End Day" means to the user —
    and a brand-new account must only ever show days 1..current_day_number,
    never phantom days before it existed. weight_rows is still grouped by
    calendar date (a body-weight trend is inherently about calendar time, not
    logical "sessions"), and only used to fill in DayTrend.weight_kg for the
    calendar date that happens to overlap each logical day's most recent log.

    Kept side-effect-free and Supabase-independent on purpose so it's
    trivially unit-testable — see backend/tests/test_trends_service.py."""
    totals: dict[int, dict] = defaultdict(lambda: {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0})
    latest_date_for_day: dict[int, str] = {}
    for row in log_rows:
        day_number = row["day_number"]
        totals[day_number]["calories"] += row["calories"]
        totals[day_number]["protein"] += row["protein"]
        totals[day_number]["carbs"] += row["carbs"]
        totals[day_number]["fats"] += row["fats"]
        row_date = parse_date(row["logged_at"])
        if day_number not in latest_date_for_day or row_date > latest_date_for_day[day_number]:
            latest_date_for_day[day_number] = row_date

    water_totals: dict[int, int] = defaultdict(int)
    for row in water_rows:
        water_totals[row["day_number"]] += row["amount_ml"]

    # If multiple weigh-ins happened the same calendar date, the latest wins.
    weight_by_date: dict[str, float] = {}
    for row in sorted(weight_rows, key=lambda r: r["logged_at"]):
        weight_by_date[parse_date(row["logged_at"])] = row["weight_kg"]

    days_to_show = min(current_day_number, retention_days)
    first_day = current_day_number - days_to_show + 1

    days: list[DayTrend] = []
    for day_number in range(first_day, current_day_number + 1):
        day_totals = totals.get(day_number, {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0})
        has_logs = day_number in totals
        adherent = has_logs and abs(day_totals["calories"] - target_calories) <= target_calories * ADHERENCE_TOLERANCE
        day_date = latest_date_for_day.get(day_number)
        days.append(
            DayTrend(
                day_number=day_number,
                date=day_date,
                calories=day_totals["calories"],
                protein=day_totals["protein"],
                carbs=day_totals["carbs"],
                fats=day_totals["fats"],
                water_ml=water_totals.get(day_number, 0),
                weight_kg=weight_by_date.get(day_date) if day_date else None,
                adherent=adherent,
            )
        )

    # Counts consecutive adherent days ending at the most recent *completed*
    # day. The current day (current_day_number) is skipped rather than judged
    # while it has zero logs yet — it isn't over, so "nothing logged so far"
    # must never zero out an otherwise-intact streak. If it already has logs,
    # it's judged normally (a bad day logged so far legitimately breaks it).
    streak = 0
    for day in reversed(days):  # most recent first
        if day.day_number == current_day_number and day.day_number not in totals:
            continue
        if not day.adherent:
            break
        streak += 1

    return TrendsResponse(days=days, streak=streak)
