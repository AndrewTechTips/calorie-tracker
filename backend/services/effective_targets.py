"""One tiny helper, shared by every backend read of "this user's calorie
goal FOR TODAY", so the "Trim tomorrow" one-day override
(profiles.temp_calorie_override / temp_override_date — see sql/schema.sql and
routers/coach.py's POST /coach/damage-control/trim-tomorrow) is honoured
identically everywhere instead of each call site reimplementing the check.

Deliberately NOT applied in routers/trends.py: the historical
adherence/streak engine keeps a single stable definition of "an adherent
day" (calories within ADHERENCE_TOLERANCE of profiles.daily_calories). The
override is a soft, self-expiring nudge for the live dashboard — the ring,
"calories left", the Damage Control card, the coach banner — not a
retroactive redefinition of what counted as on-target on past days.

Pure and Supabase-free (takes an already-fetched profile dict + a date), so
it's unit-tested alongside the deterministic Damage Control math in
tests/test_damage_control_service.py.
"""

from datetime import date

DEFAULT_DAILY_CALORIES = 2200.0


def effective_calorie_target(profile: dict | None, local_today: date) -> float:
    """The calorie target to show/measure against for `local_today`.

    Returns profiles.temp_calorie_override IFF profiles.temp_override_date is
    exactly `local_today` (the override was set, by "Trim tomorrow", for this
    specific day and hasn't lapsed). Otherwise the normal
    profiles.daily_calories, falling back to DEFAULT_DAILY_CALORIES when the
    profile row or the column is missing (a not-yet-migrated project, or a
    brand-new row mid-self-heal — same defensive default the routers already
    use inline today).
    """
    profile = profile or {}
    base = profile.get("daily_calories") or DEFAULT_DAILY_CALORIES

    override = profile.get("temp_calorie_override")
    override_date = profile.get("temp_override_date")
    if override is None or override_date is None:
        return float(base)

    # override_date may arrive as a date (rare) or an ISO string (the usual
    # shape back from Supabase) — normalise both to "YYYY-MM-DD" for the
    # comparison rather than parsing, which keeps this dependency-free.
    override_date_str = override_date.isoformat() if isinstance(override_date, date) else str(override_date)[:10]
    if override_date_str == local_today.isoformat():
        return float(override)
    return float(base)
