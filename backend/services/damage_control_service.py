"""Damage Control — all of it, deterministically.

This feature used to be an LLM-written "reset the day" paragraph
(gemini_service.DAMAGE_CONTROL_PROMPT, now removed). It's now pure arithmetic
plus a 14-day "zoom-out" sparkline: the psychological work is done by SHOWING
that today's spike is one notch on an otherwise steady line, and by DEFLATING
the number ("700 over ≈ 88 kcal/day if you even it out over a week"), not by
a model finding warm words for it.

Same "pure, Supabase-free, unit-tested" discipline as trends_service.py /
workout_service.py — routers/coach.py does the reads and hands plain
dicts/values in. See tests/test_damage_control_service.py.
"""

from __future__ import annotations

from datetime import date, timedelta

# --- Deflation -------------------------------------------------------------
# "Spread the overage across the next week" — a fixed, friendly horizon.
# Clamped defensively so the per-day figure is never derived from an absurd
# spread (a "over 1 day" that reads as alarming, or a "over 30 days" that
# reads as meaningless).
DEFLATION_SPREAD_DAYS = 7
_MIN_SPREAD_DAYS = 3
_MAX_SPREAD_DAYS = 14
_KCAL_PER_G_FAT = 9


def compute_deflation(calories_over: float, spread_days: int = DEFLATION_SPREAD_DAYS) -> dict:
    """Turn a raw overage into the two numbers that shrink it:
    per_day_kcal  — the overage spread evenly across `spread_days`
                    ("that's one fewer handful of nuts a day").
    fat_equiv_g   — the overage as grams of body fat IF today were every day
                    (it isn't) — an honest ceiling that still deflates the
                    catastrophe (700 kcal ≈ 78 g, not "a pound").
    """
    over = max(0.0, float(calories_over))
    spread = max(_MIN_SPREAD_DAYS, min(int(spread_days), _MAX_SPREAD_DAYS))
    return {
        "spread_days": spread,
        "per_day_kcal": round(over / spread) if over > 0 else 0,
        "fat_equiv_g": round(over / _KCAL_PER_G_FAT) if over > 0 else 0,
    }


# --- The "zoom-out" sparkline -------------------------------------------------
def build_sparkline(
    summary_rows: list[dict],
    *,
    today: date,
    window_days: int,
    default_target: float,
) -> list[dict]:
    """A DENSE series of exactly `window_days` points, oldest first, ending on
    `today`, built from daily_calorie_summary rows ({date, calories, target}).

    Days with no logged food become {calories: 0, logged: False} — but keep
    `default_target` rather than 0 so the target reference line stays flat
    across gaps instead of collapsing. Rows outside the window are ignored.
    """
    by_date: dict[str, dict] = {}
    for row in summary_rows:
        raw = row.get("date")
        key = raw.isoformat() if isinstance(raw, date) else str(raw)[:10]
        by_date[key] = row

    first = today - timedelta(days=window_days - 1)
    points: list[dict] = []
    for offset in range(window_days):
        d = first + timedelta(days=offset)
        key = d.isoformat()
        row = by_date.get(key)
        points.append(
            {
                "date": key,
                "calories": float(row["calories"]) if row else 0.0,
                "target": float(row["target"]) if row and row.get("target") else float(default_target),
                "is_today": d == today,
                "logged": row is not None,
            }
        )
    return points


def trailing_average(points: list[dict], *, include_today: bool) -> int:
    """Mean calories over the logged days in the sparkline. `include_today`
    off is the "your average barely moves" number the copy leans on — the
    baseline the user was already running before this meal. Returns 0 (not a
    ZeroDivisionError) when there's nothing logged yet."""
    vals = [
        p["calories"]
        for p in points
        if p["logged"] and (include_today or not p["is_today"])
    ]
    if not vals:
        return 0
    return round(sum(vals) / len(vals))


# --- "Move it" — brisk-walk estimate --------------------------------------
# Standard MET → kcal/min conversion: kcal/min = MET * 3.5 * kg / 200
# (ACSM / Compendium of Physical Activities). MET 4.3 ≈ a brisk ~5 km/h walk.
BRISK_WALK_MET = 4.3
DEFAULT_BODYWEIGHT_KG = 70.0
_MIN_WALK_MINUTES = 5
_MAX_WALK_MINUTES = 60  # a prefill the user will actually tap "Save" on


def walk_minutes_for(calories_over: float, weight_kg: float | None = None) -> int:
    """Minutes of brisk walking that burn roughly `calories_over`, clamped to
    a realistic 5–60 min so the "Move it" prefill is something a person
    actually does — not a literal "walk for 2 hours". The card copy frames it
    as "every bit counts", not "this cancels it out"."""
    over = max(0.0, float(calories_over))
    weight = float(weight_kg) if weight_kg and weight_kg > 0 else DEFAULT_BODYWEIGHT_KG
    kcal_per_min = BRISK_WALK_MET * 3.5 * weight / 200.0
    if kcal_per_min <= 0 or over <= 0:
        return _MIN_WALK_MINUTES
    return max(_MIN_WALK_MINUTES, min(round(over / kcal_per_min), _MAX_WALK_MINUTES))


# --- "Trim tomorrow" -----------------------------------------------------
# Never propose a target below this, no matter how large the overage — same
# floor the old AI prompt's SAFETY block enforced ("never imply a calorie
# floor below roughly 1200-1500 kcal").
TRIM_FLOOR_KCAL = 1500


def trimmed_target_for_tomorrow(current_target: float, per_day_kcal: float, *, floor: int = TRIM_FLOOR_KCAL) -> int:
    """Tomorrow's gently-lowered target: today's target minus the deflation
    per-day figure (so the trim matches the number the card just showed the
    user), never below `floor`."""
    return max(round(float(current_target) - float(per_day_kcal)), int(floor))
