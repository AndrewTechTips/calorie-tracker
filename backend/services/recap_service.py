"""Weekly Recap — the deterministic insights engine.

The recap used to be a single AI-written paragraph. It's now:
  1. this module — pure math over the user's own rows: per-day aggregation,
     a longitudinal baseline from daily_calorie_summary, a metrics block, and
     a ranked set of candidate "insights" from which the top 2 (diverse, by
     family) are returned;
  2. an AI caption (gemini_service.generate_weekly_recap) that gets ONLY
     those pre-computed insights + headline numbers and writes 1-2 sentences
     tying them together — it never sees raw data and can't introduce a fact;
  3. a Spotify-Wrapped-style frontend that renders the metrics/insights with
     bold typography and the caption as a thin connective layer on top.

Same "pure, Supabase-free, unit-tested" discipline as trends_service.py /
damage_control_service.py — routers/coach.py does the reads and hands plain
lists/dicts in. See tests/test_recap_service.py.

The insight *text* is NOT built here: this module returns each insight as a
stable `kind` + a `variant` + a `data` dict of numbers, and the frontend
renders the localized sentence from i18n.js (recap.insights.<kind>...). The
backend stays free of user-facing prose, exactly like every other string in
this app that isn't an error message.
"""

from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta

from services.trends_service import ADHERENCE_TOLERANCE, parse_date

WEEKEND_WEEKDAYS = {5, 6}  # Saturday, Sunday (date.weekday(): Mon=0 … Sun=6)

# How far back daily_calorie_summary is read for the "vs your recent norm"
# baseline — 4 weeks before the recap week. Kept < summary_retention_days (90).
BASELINE_DAYS = 28


# ---------------------------------------------------------------------------
# Per-day aggregation
# ---------------------------------------------------------------------------
def _empty_day() -> dict:
    return {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fats": 0.0, "fiber": 0.0, "sugar": 0.0}


def _aggregate_week(log_rows: list[dict], water_rows: list[dict], *, week_dates: list[date], target_calories: float):
    by_date: dict[str, dict] = {}
    for row in log_rows:
        d = row["log_date"]
        bucket = by_date.setdefault(d, _empty_day())
        for k in ("calories", "protein", "carbs", "fats", "fiber", "sugar"):
            bucket[k] += row.get(k) or 0

    water_by_date: dict[str, float] = {}
    for row in water_rows:
        water_by_date[row["log_date"]] = water_by_date.get(row["log_date"], 0.0) + (row.get("amount_ml") or 0)

    days = []
    for d in week_dates:
        ds = d.isoformat()
        totals = by_date.get(ds, _empty_day())
        logged = ds in by_date
        adherent = logged and abs(totals["calories"] - target_calories) <= target_calories * ADHERENCE_TOLERANCE
        days.append(
            {
                "date": ds,
                "weekday": d.weekday(),
                "logged": logged,
                "adherent": adherent,
                "water_ml": water_by_date.get(ds, 0.0),
                **totals,
            }
        )
    return days


def _current_streak(days: list[dict], today: date) -> int:
    """Consecutive adherent days ending at the most recent real day. Today is
    skipped (not judged) while it still has no logs — mirrors
    trends_service.compute_trends exactly, so the recap and Progress never
    disagree on the streak."""
    today_str = today.isoformat()
    streak = 0
    for day in reversed(days):
        if day["date"] == today_str and not day["logged"]:
            continue
        if not day["adherent"]:
            break
        streak += 1
    return streak


def _mean(values) -> float | None:
    values = list(values)
    return sum(values) / len(values) if values else None


# ---------------------------------------------------------------------------
# Baseline from daily_calorie_summary (the longitudinal payoff of Phase 1)
# ---------------------------------------------------------------------------
def _summary_window(summary_rows: list[dict], start: date, end: date) -> list[dict]:
    """summary_rows whose date is in [start, end) — start inclusive, end
    exclusive. Row dates arrive as ISO strings (or occasionally date objects)."""
    out = []
    for row in summary_rows:
        raw = row.get("date")
        d = raw if isinstance(raw, date) else datetime.fromisoformat(str(raw)[:10]).date()
        if start <= d < end:
            out.append(row)
    return out


# ---------------------------------------------------------------------------
# Insight candidates — each returns a dict (kind/variant/family/score/data)
# or None. `ctx` is the assembled context built in compute_recap.
# ---------------------------------------------------------------------------
def _insight_on_target_days(ctx) -> dict | None:
    m = ctx["logged_count"]
    if m < 3:
        return None
    hit = ctx["adherent_count"]
    rate = hit / m
    if rate >= 1.0 and m >= 4:
        variant, score = "perfect", 90.0
    elif rate >= 0.6:
        variant, score = "strong", 50.0 + 30.0 * rate
    elif rate <= 0.2 and m >= 4:
        variant, score = "rough", 46.0
    else:
        variant, score = "mixed", 24.0
    return {
        "kind": "onTargetDays",
        "variant": variant,
        "family": "adherence",
        "score": score,
        "data": {"hit": hit, "of": m, "rate": round(rate, 2)},
    }


def _insight_streak(ctx) -> dict | None:
    streak = ctx["streak"]
    if streak < 3:
        return None
    return {
        "kind": "streak",
        "variant": "active",
        "family": "adherence",
        "score": 45.0 + min(streak, 14) * 3.0,
        "data": {"days": streak},
    }


def _insight_protein_consistency(ctx) -> dict | None:
    m = ctx["logged_count"]
    tgt = ctx["target_protein"]
    if m < 3 or tgt <= 0:
        return None
    hit = ctx["protein_hit_days"]
    rate = hit / m
    if rate >= 0.85:
        variant, score = "nailed", 60.0 + 20.0 * rate
    elif rate <= 0.3:
        variant, score = "lagged", 42.0
    else:
        return None
    return {
        "kind": "proteinConsistency",
        "variant": variant,
        "family": "protein",
        "score": score,
        "data": {
            "hit": hit,
            "of": m,
            "avg": round(ctx["avg_protein"]),
            "target": round(tgt),
        },
    }


def _insight_weekend_effect(ctx) -> dict | None:
    weekday = [d for d in ctx["logged_days"] if d["weekday"] not in WEEKEND_WEEKDAYS]
    weekend = [d for d in ctx["logged_days"] if d["weekday"] in WEEKEND_WEEKDAYS]
    if len(weekday) < 2 or len(weekend) < 1:
        return None
    wk_avg = _mean(d["calories"] for d in weekday)
    we_avg = _mean(d["calories"] for d in weekend)
    if not wk_avg:
        return None
    delta_pct = (we_avg - wk_avg) / wk_avg
    if delta_pct >= 0.15:
        variant, score = "higher", 50.0 + min(delta_pct, 0.6) * 80.0
    elif delta_pct <= -0.15:
        variant, score = "lower", 40.0 + min(-delta_pct, 0.5) * 40.0
    else:
        return None
    return {
        "kind": "weekendEffect",
        "variant": variant,
        "family": "weekend",
        "score": score,
        "data": {
            "weekday_avg": round(wk_avg),
            "weekend_avg": round(we_avg),
            "delta_kcal": round(abs(we_avg - wk_avg)),
            "delta_pct": round(abs(delta_pct) * 100),
        },
    }


def _insight_calories_vs_baseline(ctx) -> dict | None:
    base_avg = ctx["baseline_avg_calories"]
    base_days = ctx["baseline_days"]
    if base_avg is None or base_days < 10 or ctx["logged_count"] < 3 or not ctx["avg_calories"]:
        return None
    delta_pct = (ctx["avg_calories"] - base_avg) / base_avg
    if abs(delta_pct) < 0.06:
        return None
    confidence = min(base_days / 21.0, 1.0)
    score = (40.0 + min(abs(delta_pct), 0.4) * 120.0) * confidence
    return {
        "kind": "caloriesVsBaseline",
        "variant": "above" if delta_pct > 0 else "below",
        "family": "baseline",
        "score": score,
        "data": {
            "this_week_avg": round(ctx["avg_calories"]),
            "baseline_avg": round(base_avg),
            "baseline_days": base_days,
            "delta_kcal": round(abs(ctx["avg_calories"] - base_avg)),
            "delta_pct": round(abs(delta_pct) * 100),
        },
    }


def _insight_consistency(ctx) -> dict | None:
    days = ctx["logged_days"]
    if len(days) < 4:
        return None
    vals = [d["calories"] for d in days]
    mean = _mean(vals)
    if not mean:
        return None
    cv = statistics.pstdev(vals) / mean
    lo, hi = min(vals), max(vals)
    if cv <= 0.10:
        variant, score = "steady", 58.0
    elif cv >= 0.28:
        variant, score = "swingy", 46.0
    else:
        return None
    return {
        "kind": "consistency",
        "variant": variant,
        "family": "consistency",
        "score": score,
        "data": {"min": round(lo), "max": round(hi), "spread": round(hi - lo), "days": len(days)},
    }


def _insight_hydration(ctx) -> dict | None:
    tgt = ctx["target_water_ml"]
    if tgt <= 0:
        return None
    hit = ctx["water_hit_days"]
    window = ctx["window_days"]
    rate = hit / window
    if rate >= 0.7:
        variant, score = "strong", 44.0 + 20.0 * rate
    elif rate <= 0.25:
        variant, score = "low", 38.0
    else:
        return None
    return {
        "kind": "hydration",
        "variant": variant,
        "family": "hydration",
        "score": score,
        "data": {"hit": hit, "of": window, "avg_ml": round(ctx["avg_water_ml"]), "target_ml": round(tgt)},
    }


def _insight_weigh_in(ctx) -> dict | None:
    count = ctx["weigh_ins"]
    change = ctx["weight_change_kg"]
    span = ctx["weigh_in_span_days"]
    if count >= 2 and change is not None and abs(change) >= 0.3 and span >= 3:
        return {
            "kind": "weighIn",
            "variant": "down" if change < 0 else "up",
            "family": "weight",
            "score": 48.0 + min(abs(change), 1.5) * 15.0,
            "data": {"count": count, "change_kg": round(abs(change), 1)},
        }
    if count >= 3:
        return {"kind": "weighIn", "variant": "tracked", "family": "weight", "score": 36.0, "data": {"count": count}}
    if count <= 1:
        return {"kind": "weighIn", "variant": "sparse", "family": "weight", "score": 28.0, "data": {"count": count}}
    return None


def _insight_fallback(ctx) -> dict:
    """Always emitted — the guaranteed floor so `insights` is never empty.
    A quiet week (≤2 logged days) and a full-but-unremarkable week (≥5 logged,
    nothing else notable) each get their own honest framing rather than a
    manufactured "achievement"."""
    m = ctx["logged_count"]
    if m <= 2:
        variant, score = "quiet", 18.0
    elif m >= 5:
        variant, score = "steady", 24.0
    else:
        variant, score = "summary", 10.0
    return {
        "kind": "weekShape",
        "variant": variant,
        "family": "fallback",
        "score": score,
        "data": {"logged": m, "of": ctx["window_days"], "hit": ctx["adherent_count"]},
    }


_INSIGHT_FNS = (
    _insight_on_target_days,
    _insight_streak,
    _insight_protein_consistency,
    _insight_weekend_effect,
    _insight_calories_vs_baseline,
    _insight_consistency,
    _insight_hydration,
    _insight_weigh_in,
)


def _rank_insights(candidates: list[dict], limit: int = 2) -> list[dict]:
    """Highest score first, but never two from the same family — the second
    slot goes to the best insight telling a *different* story, so the recap
    can't lead with "you were over baseline" and "your adherence dropped"
    (one story, said twice). Falls back to same-family only if there's
    genuinely nothing else."""
    ordered = sorted(candidates, key=lambda c: c["score"], reverse=True)
    picked: list[dict] = []
    families: set[str] = set()
    for c in ordered:
        if c["family"] in families:
            continue
        picked.append(c)
        families.add(c["family"])
        if len(picked) == limit:
            return picked
    for c in ordered:
        if c not in picked:
            picked.append(c)
            if len(picked) == limit:
                break
    return picked


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def compute_recap(
    log_rows: list[dict],
    water_rows: list[dict],
    weight_rows: list[dict],
    summary_rows: list[dict],
    *,
    target_calories: float,
    target_protein: float,
    target_water_ml: float,
    today: date,
    timezone_name: str = "UTC",
    retention_days: int = 7,
    baseline_days: int = BASELINE_DAYS,
) -> dict:
    week_dates = [today - timedelta(days=i) for i in range(retention_days - 1, -1, -1)]
    week_start, week_end = week_dates[0], week_dates[-1]

    days = _aggregate_week(log_rows, water_rows, week_dates=week_dates, target_calories=target_calories)
    logged_days = [d for d in days if d["logged"]]
    logged_count = len(logged_days)
    adherent_count = sum(1 for d in days if d["adherent"])
    streak = _current_streak(days, today)

    avg_calories = _mean(d["calories"] for d in logged_days) or 0.0
    avg_protein = _mean(d["protein"] for d in logged_days) or 0.0
    protein_hit_days = sum(1 for d in logged_days if target_protein > 0 and d["protein"] >= 0.9 * target_protein)

    water_hit_days = sum(1 for d in days if target_water_ml > 0 and d["water_ml"] >= target_water_ml)
    avg_water_ml = _mean(d["water_ml"] for d in days) or 0.0

    # Weigh-ins that fall inside the recap week, one value per calendar date.
    weight_by_date: dict[str, float] = {}
    for row in sorted(weight_rows, key=lambda r: r["logged_at"]):
        d = parse_date(row["logged_at"], timezone_name)
        if week_start.isoformat() <= d <= week_end.isoformat():
            weight_by_date[d] = row["weight_kg"]
    weigh_dates = sorted(weight_by_date)
    weigh_ins = len(weigh_dates)
    weight_change_kg = (weight_by_date[weigh_dates[-1]] - weight_by_date[weigh_dates[0]]) if weigh_ins >= 2 else None
    weigh_in_span_days = (
        (date.fromisoformat(weigh_dates[-1]) - date.fromisoformat(weigh_dates[0])).days if weigh_ins >= 2 else 0
    )

    # Baseline + previous-week averages from daily_calorie_summary.
    baseline = _summary_window(summary_rows, week_start - timedelta(days=baseline_days), week_start)
    baseline_avg_calories = _mean(r["calories"] for r in baseline)
    prev_week = _summary_window(summary_rows, week_start - timedelta(days=retention_days), week_start)
    prev_week_avg_calories = _mean(r["calories"] for r in prev_week)

    # The logged day closest to target — a Wrapped-y "your best day was …".
    best_day = None
    if logged_days and target_calories > 0:
        b = min(logged_days, key=lambda d: abs(d["calories"] - target_calories))
        best_day = {"date": b["date"], "weekday": b["weekday"], "calories": round(b["calories"])}

    ctx = {
        "window_days": retention_days,
        "logged_days": logged_days,
        "logged_count": logged_count,
        "adherent_count": adherent_count,
        "streak": streak,
        "avg_calories": avg_calories,
        "avg_protein": avg_protein,
        "protein_hit_days": protein_hit_days,
        "target_protein": target_protein,
        "target_water_ml": target_water_ml,
        "water_hit_days": water_hit_days,
        "avg_water_ml": avg_water_ml,
        "weigh_ins": weigh_ins,
        "weight_change_kg": weight_change_kg,
        "weigh_in_span_days": weigh_in_span_days,
        "baseline_avg_calories": baseline_avg_calories,
        "baseline_days": len(baseline),
    }

    # With ≤2 logged days there's no week to find patterns in — every "real"
    # insight would just be noise off a tiny sample ("water was low 0/7",
    # "only 1 weigh-in"). A quiet week gets one honest line and nothing else.
    if logged_count >= 3:
        candidates = [c for c in (fn(ctx) for fn in _INSIGHT_FNS) if c]
    else:
        candidates = []
    candidates.append(_insight_fallback(ctx))
    insights = _rank_insights(candidates, limit=2)

    # Headline stat for the sheet's hero slot — the single most characteristic
    # number of the week, picked deterministically.
    if streak >= 3:
        headline = {"kind": "streak", "value": streak}
    elif logged_count >= 3:
        headline = {"kind": "onTarget", "value": adherent_count, "of": logged_count}
    else:
        headline = {"kind": "quiet", "value": logged_count}

    metrics = {
        "days_logged": logged_count,
        "window_days": retention_days,
        "days_adherent": adherent_count,
        "adherence_pct": round(100 * adherent_count / logged_count) if logged_count else 0,
        "streak": streak,
        "avg_calories": round(avg_calories),
        "target_calories": round(target_calories),
        "prev_week_avg_calories": round(prev_week_avg_calories) if prev_week_avg_calories is not None else None,
        "baseline_avg_calories": round(baseline_avg_calories) if baseline_avg_calories is not None else None,
        "baseline_days": len(baseline),
        "avg_protein": round(avg_protein),
        "target_protein": round(target_protein),
        "protein_hit_days": protein_hit_days,
        "avg_water_ml": round(avg_water_ml),
        "target_water_ml": round(target_water_ml),
        "water_hit_days": water_hit_days,
        "weigh_ins": weigh_ins,
        "weight_change_kg": round(weight_change_kg, 1) if weight_change_kg is not None else None,
        "best_day": best_day,
        "headline": headline,
        # The 7 calorie bars the frontend draws (oldest→today), reusing the
        # Damage Control sparkline aesthetic for visual consistency.
        "spark": [
            {"date": d["date"], "calories": round(d["calories"]), "logged": d["logged"], "adherent": d["adherent"]}
            for d in days
        ],
    }

    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "insights": insights,
        "metrics": metrics,
    }


# ---------------------------------------------------------------------------
# English glosses for the AI caption prompt — NOT shown to the user (the
# frontend renders the localized sentence from i18n). These exist purely so
# the caption model has concrete natural-language to connect, without ever
# seeing raw rows. One line per insight kind/variant.
# ---------------------------------------------------------------------------
def insight_gloss(insight: dict) -> str:
    k, v, d = insight["kind"], insight.get("variant"), insight["data"]
    if k == "onTargetDays":
        return {
            "perfect": f"Hit calorie target on all {d['of']} logged days.",
            "strong": f"On calorie target {d['hit']} of {d['of']} logged days.",
            "rough": f"On calorie target only {d['hit']} of {d['of']} logged days.",
            "mixed": f"On calorie target {d['hit']} of {d['of']} logged days.",
        }.get(v, "")
    if k == "streak":
        return f"{d['days']}-day adherence streak currently running."
    if k == "proteinConsistency":
        return (
            f"Protein stayed strong — near or above target {d['hit']} of {d['of']} days "
            f"(avg {d['avg']}g, target {d['target']}g)."
            if v == "nailed"
            else f"Protein ran low most days — {d['hit']} of {d['of']} near target "
            f"(avg {d['avg']}g, target {d['target']}g)."
        )
    if k == "weekendEffect":
        return (
            f"Weekend days averaged {d['delta_kcal']} kcal ({d['delta_pct']}%) higher than weekdays "
            f"({d['weekend_avg']} vs {d['weekday_avg']})."
            if v == "higher"
            else f"Weekend days averaged {d['delta_kcal']} kcal lower than weekdays."
        )
    if k == "caloriesVsBaseline":
        dir_word = "above" if v == "above" else "below"
        return (
            f"This week averaged {d['this_week_avg']} kcal, {d['delta_kcal']} ({d['delta_pct']}%) {dir_word} "
            f"the {d['baseline_days']}-day baseline of {d['baseline_avg']}."
        )
    if k == "consistency":
        return (
            f"Calories were very steady all week ({d['min']}–{d['max']} kcal across {d['days']} days)."
            if v == "steady"
            else f"Calories swung a lot ({d['min']}–{d['max']} kcal across {d['days']} days)."
        )
    if k == "hydration":
        return (
            f"Water hit target {d['hit']} of {d['of']} days."
            if v == "strong"
            else f"Water hit target only {d['hit']} of {d['of']} days."
        )
    if k == "weighIn":
        return {
            "down": f"Weight down {d['change_kg']} kg across {d['count']} weigh-ins this week.",
            "up": f"Weight up {d['change_kg']} kg across {d['count']} weigh-ins this week.",
            "tracked": f"{d['count']} weigh-ins logged this week.",
            "sparse": f"Only {d['count']} weigh-in this week.",
        }.get(v, "")
    if k == "weekShape":
        return {
            "quiet": f"A quiet week — only {d['logged']} of {d['of']} days logged.",
            "steady": f"A steady, unremarkable week — {d['logged']} days logged, {d['hit']} on target.",
            "summary": f"{d['logged']} of {d['of']} days logged, {d['hit']} on target.",
        }.get(v, "")
    return ""
