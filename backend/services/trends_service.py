from collections import defaultdict
from datetime import date, datetime, timedelta

from models import DayTrend, TrendsResponse
from services.daytime_service import local_today

# A day counts as "adherent" for the streak if it has at least one log (so an
# empty/unused day never silently counts as a win) and its total calories
# land within this fraction of the daily target — same ±10% tolerance the
# dashboard's own status banner logic (frontend/js/coach.js) is built around.
ADHERENCE_TOLERANCE = 0.10


def parse_date(iso_string: str, tz_name: str = "UTC") -> str:
    """Supabase returns timestamptz as an ISO string; normalize 'Z' (which
    older Python's fromisoformat can't parse) and take the date **in the
    user's own timezone** — the same `local_today` logic every other date in
    this app uses (log_date, day-lock, streaks). Used only for weight_logs,
    which still groups by the date a weigh-in was recorded, not by log_date —
    weight isn't part of the log_date/day-lock model at all (see
    sql/schema.sql's weight_logs table comment).

    Deliberately NOT a raw UTC conversion: the `days` list this gets matched
    against (compute_trends below) is built from local calendar dates, so a
    weigh-in near local midnight in any non-UTC timezone — including this
    app's actual Romanian-speaking users, UTC+2/+3 — would otherwise get
    bucketed under the wrong day (or fall outside the retained window
    entirely) purely because UTC and local disagree on what date it is at
    that moment."""
    parsed = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
    return local_today(tz_name, now=parsed).isoformat()


def compute_trends(
    log_rows: list[dict],
    water_rows: list[dict],
    weight_rows: list[dict],
    *,
    retention_days: int,
    target_calories: float,
    today: date,
    timezone_name: str = "UTC",
) -> TrendsResponse:
    """Pure aggregation: groups raw daily_logs/water_logs rows into one entry
    per calendar date (each row's own `log_date` — a real date in the user's
    timezone, set at write time; see backend/services/daytime_service.py and
    the log_date column comment in sql/schema.sql). One row per date, unique
    by construction — replaces the old day_number logical-session model,
    which could legitimately put two "days" on the same real date.

    Always shows exactly `retention_days` consecutive dates ending at
    `today`, zeroed for any date with no logs — matches the old model's
    "always show retention_days entries" behavior, but with no more
    "phantom day before the account existed" special-casing needed, since
    calendar dates always exist regardless of account age.

    weight_rows are grouped by their own calendar date (a body-weight trend
    is inherently about calendar time), used to fill DayTrend.weight_kg for
    whichever date it matches.

    Kept side-effect-free and Supabase-independent on purpose so it's
    trivially unit-testable — see backend/tests/test_trends_service.py."""
    totals: dict[str, dict] = defaultdict(lambda: {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0})
    for row in log_rows:
        day_date = row["log_date"]
        totals[day_date]["calories"] += row["calories"]
        totals[day_date]["protein"] += row["protein"]
        totals[day_date]["carbs"] += row["carbs"]
        totals[day_date]["fats"] += row["fats"]

    water_totals: dict[str, int] = defaultdict(int)
    for row in water_rows:
        water_totals[row["log_date"]] += row["amount_ml"]

    # If multiple weigh-ins happened the same calendar date, the latest wins.
    weight_by_date: dict[str, float] = {}
    for row in sorted(weight_rows, key=lambda r: r["logged_at"]):
        weight_by_date[parse_date(row["logged_at"], timezone_name)] = row["weight_kg"]

    first_day = today - timedelta(days=retention_days - 1)

    days: list[DayTrend] = []
    for offset in range(retention_days):
        day_date = first_day + timedelta(days=offset)
        day_date_str = day_date.isoformat()
        day_totals = totals.get(day_date_str, {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0})
        has_logs = day_date_str in totals
        adherent = has_logs and abs(day_totals["calories"] - target_calories) <= target_calories * ADHERENCE_TOLERANCE
        days.append(
            DayTrend(
                date=day_date_str,
                calories=day_totals["calories"],
                protein=day_totals["protein"],
                carbs=day_totals["carbs"],
                fats=day_totals["fats"],
                water_ml=water_totals.get(day_date_str, 0),
                weight_kg=weight_by_date.get(day_date_str),
                adherent=adherent,
            )
        )

    # Counts consecutive adherent days ending at the most recent, real day
    # (today). Today is skipped rather than judged while it has zero logs
    # yet — it isn't over, so "nothing logged so far" must never zero out an
    # otherwise-intact streak. If it already has logs, it's judged normally
    # (a bad day logged so far legitimately breaks it).
    today_str = today.isoformat()
    streak = 0
    for day in reversed(days):  # most recent first
        if day.date == today_str and day.date not in totals:
            continue
        if not day.adherent:
            break
        streak += 1

    return TrendsResponse(days=days, streak=streak)
