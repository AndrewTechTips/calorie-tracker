from datetime import date, timedelta

import pytest

from services import recap_service as r

# A Sunday, so a 7-day window ending here is Mon..Sun.
TODAY = date(2026, 9, 6)
WEEK = [TODAY - timedelta(days=i) for i in range(6, -1, -1)]  # oldest..today


def _log(d, calories, protein=140, carbs=200, fats=70, fiber=25, sugar=40, food="meal", tag="regular"):
    return {
        "log_date": d.isoformat() if isinstance(d, date) else d,
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fats": fats,
        "fiber": fiber,
        "sugar": sugar,
        "food_name": food,
        "workout_tag": tag,
    }


def _water(d, ml):
    return {"log_date": d.isoformat() if isinstance(d, date) else d, "amount_ml": ml}


def _summary(d, calories, target=2200):
    return {"date": d.isoformat() if isinstance(d, date) else d, "calories": calories, "target": target}


def _run(logs, water=None, weight=None, summary=None, *, cal=2200, protein=160, water_ml=3000):
    return r.compute_recap(
        logs,
        water or [],
        weight or [],
        summary or [],
        target_calories=cal,
        target_protein=protein,
        target_water_ml=water_ml,
        today=TODAY,
        timezone_name="Europe/Bucharest",
        retention_days=7,
    )


def _kinds(out):
    return {i["kind"] for i in out["insights"]}


# ---------------------------------------------------------------------------
# Shape guarantees
# ---------------------------------------------------------------------------
def test_always_returns_one_or_two_insights_and_a_full_metrics_block():
    out = _run([_log(d, 2180) for d in WEEK])
    assert 1 <= len(out["insights"]) <= 2
    m = out["metrics"]
    for key in ("days_logged", "days_adherent", "streak", "avg_calories", "headline", "spark"):
        assert key in m
    assert len(m["spark"]) == 7
    assert out["week_start"] == WEEK[0].isoformat()
    assert out["week_end"] == TODAY.isoformat()


def test_empty_week_yields_exactly_one_quiet_insight():
    out = _run([])
    assert len(out["insights"]) == 1
    assert out["insights"][0]["kind"] == "weekShape"
    assert out["insights"][0]["variant"] == "quiet"
    assert out["metrics"]["headline"] == {"kind": "quiet", "value": 0}


def test_one_logged_day_is_still_a_quiet_week_no_noise_insights():
    out = _run([_log(WEEK[3], 1800)])
    assert _kinds(out) == {"weekShape"}
    assert out["metrics"]["headline"]["kind"] == "quiet"


# ---------------------------------------------------------------------------
# Individual insight thresholds
# ---------------------------------------------------------------------------
def test_perfect_targeting_fires_when_every_logged_day_is_on_target():
    out = _run([_log(d, 2180) for d in WEEK])  # all within +-10% of 2200
    on_target = next(i for i in out["insights"] if i["kind"] == "onTargetDays")
    assert on_target["variant"] == "perfect"
    assert on_target["data"] == {"hit": 7, "of": 7, "rate": 1.0}


def test_rough_targeting_when_hardly_any_day_on_target():
    out = _run([_log(d, 3000) for d in WEEK])  # all ~36% over
    on_target = next(i for i in out["insights"] if i["kind"] == "onTargetDays")
    assert on_target["variant"] == "rough"


def test_streak_insight_needs_at_least_three_and_skips_unlogged_today():
    # Mon..Sat on target, today (Sun) not logged -> streak of 6, not broken.
    out = _run([_log(d, 2180) for d in WEEK[:-1]])
    assert out["metrics"]["streak"] == 6
    assert out["metrics"]["headline"] == {"kind": "streak", "value": 6}


def test_weekend_effect_fires_on_a_big_weekend_swing():
    logs = [_log(d, 3400 if d.weekday() in (5, 6) else 2050) for d in WEEK]
    out = _run(logs)
    we = next(i for i in out["insights"] if i["kind"] == "weekendEffect")
    assert we["variant"] == "higher"
    assert we["data"]["weekend_avg"] == 3400
    assert we["data"]["weekday_avg"] == 2050
    assert we["data"]["delta_pct"] > 15


def test_weekend_effect_silent_when_weekends_match_weekdays():
    out = _run([_log(d, 2180) for d in WEEK])
    assert "weekendEffect" not in _kinds(out)


def test_calories_vs_baseline_uses_daily_calorie_summary():
    logs = [_log(d, 2600) for d in WEEK]  # this week avg 2600
    # 20 prior days at ~2100
    summary = [_summary(WEEK[0] - timedelta(days=k), 2100) for k in range(1, 21)]
    out = _run(logs, summary=summary)
    m = out["metrics"]
    assert m["baseline_avg_calories"] == 2100
    assert m["baseline_days"] == 20
    ins = next((i for i in out["insights"] if i["kind"] == "caloriesVsBaseline"), None)
    # It may or may not make the top-2 depending on other findings, but it
    # must at least be computable; force it to the top by removing competition:
    plain = r.compute_recap(
        [_log(d, 2600) for d in WEEK],
        [],
        [],
        summary,
        target_calories=2600,  # so "on target" every day -> perfect competes...
        target_protein=0,
        target_water_ml=0,
        today=TODAY,
        retention_days=7,
    )
    # With protein/water targets off and calories exactly on the (raised)
    # target, the baseline delta is the standout behavioural finding.
    assert "caloriesVsBaseline" in {i["kind"] for i in plain["insights"]}
    bi = next(i for i in plain["insights"] if i["kind"] == "caloriesVsBaseline")
    assert bi["variant"] == "above"
    assert bi["data"]["baseline_avg"] == 2100


def test_calories_vs_baseline_needs_enough_baseline_days():
    logs = [_log(d, 2600) for d in WEEK]
    summary = [_summary(WEEK[0] - timedelta(days=k), 2100) for k in range(1, 6)]  # only 5 days
    out = _run(logs, summary=summary, protein=0, water_ml=0)
    assert "caloriesVsBaseline" not in _kinds(out)


def test_consistency_steady_vs_swingy():
    steady = _run([_log(d, 2200) for d in WEEK], protein=0, water_ml=0)
    assert any(i["kind"] == "consistency" and i["variant"] == "steady" for i in steady["insights"])

    swings = [1500, 3200, 1700, 3400, 1600, 3100, 2000]
    swingy = _run([_log(d, c) for d, c in zip(WEEK, swings)], protein=0, water_ml=0)
    assert any(i["kind"] == "consistency" and i["variant"] == "swingy" for i in swingy["insights"])


def test_hydration_candidate_strong_low_and_silent_mid():
    # Tested at the candidate level: the ranker can legitimately push a "water
    # was low" note below a week's bigger stories, so asserting it lands in
    # the top-2 would be testing the ranker, not this insight.
    base = {"window_days": 7, "avg_water_ml": 2500}
    assert r._insight_hydration({**base, "target_water_ml": 3000, "water_hit_days": 6})["variant"] == "strong"
    assert r._insight_hydration({**base, "target_water_ml": 3000, "water_hit_days": 1})["variant"] == "low"
    assert r._insight_hydration({**base, "target_water_ml": 3000, "water_hit_days": 3}) is None
    assert r._insight_hydration({**base, "target_water_ml": 0, "water_hit_days": 0}) is None


def test_weigh_in_change_and_metrics():
    weight = [
        {"logged_at": f"{WEEK[1].isoformat()}T07:00:00Z", "weight_kg": 81.0},
        {"logged_at": f"{WEEK[5].isoformat()}T07:00:00Z", "weight_kg": 80.2},
    ]
    out = _run([_log(d, 2180) for d in WEEK], weight=weight)
    assert out["metrics"]["weigh_ins"] == 2
    assert out["metrics"]["weight_change_kg"] == -0.8
    wi = next((i for i in out["insights"] if i["kind"] == "weighIn"), None)
    if wi:  # may not make top-2, but if present it's the "down" variant
        assert wi["variant"] == "down"


# ---------------------------------------------------------------------------
# Ranking / diversity
# ---------------------------------------------------------------------------
def test_top_two_insights_come_from_different_families():
    # Big weekend swing (weekend) + protein nailed (protein) + baseline delta
    # (baseline) all fire; the top 2 must not both be same-family.
    logs = [_log(d, 3400 if d.weekday() in (5, 6) else 2050, protein=170) for d in WEEK]
    summary = [_summary(WEEK[0] - timedelta(days=k), 2000) for k in range(1, 25)]
    out = _run(logs, summary=summary)
    fams = [i["family"] for i in out["insights"]]
    assert len(fams) == 2 and fams[0] != fams[1]


def test_real_insight_beats_the_fallback():
    logs = [_log(d, 3400 if d.weekday() in (5, 6) else 2050) for d in WEEK]
    out = _run(logs, protein=0, water_ml=0)
    assert out["insights"][0]["kind"] != "weekShape"
    assert out["insights"][0]["kind"] == "weekendEffect"


# ---------------------------------------------------------------------------
# insight_gloss — every kind/variant renders a non-empty English line
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "insight",
    [
        {"kind": "onTargetDays", "variant": v, "data": {"hit": 4, "of": 6, "rate": 0.66}}
        for v in ("perfect", "strong", "rough", "mixed")
    ]
    + [{"kind": "streak", "variant": "active", "data": {"days": 5}}]
    + [
        {"kind": "proteinConsistency", "variant": v, "data": {"hit": 6, "of": 7, "avg": 150, "target": 160}}
        for v in ("nailed", "lagged")
    ]
    + [
        {
            "kind": "weekendEffect",
            "variant": v,
            "data": {"weekday_avg": 2100, "weekend_avg": 3000, "delta_kcal": 900, "delta_pct": 43},
        }
        for v in ("higher", "lower")
    ]
    + [
        {
            "kind": "caloriesVsBaseline",
            "variant": v,
            "data": {
                "this_week_avg": 2500,
                "baseline_avg": 2100,
                "baseline_days": 20,
                "delta_kcal": 400,
                "delta_pct": 19,
            },
        }
        for v in ("above", "below")
    ]
    + [
        {"kind": "consistency", "variant": v, "data": {"min": 2000, "max": 2400, "spread": 400, "days": 6}}
        for v in ("steady", "swingy")
    ]
    + [
        {"kind": "hydration", "variant": v, "data": {"hit": 5, "of": 7, "avg_ml": 2800, "target_ml": 3000}}
        for v in ("strong", "low")
    ]
    + [
        {"kind": "weighIn", "variant": v, "data": {"count": 3, "change_kg": 0.6}}
        for v in ("down", "up", "tracked", "sparse")
    ]
    + [
        {"kind": "weekShape", "variant": v, "data": {"logged": 2, "of": 7, "hit": 1}}
        for v in ("quiet", "steady", "summary")
    ],
)
def test_insight_gloss_is_non_empty_for_every_kind_variant(insight):
    gloss = r.insight_gloss(insight)
    assert isinstance(gloss, str) and len(gloss) > 5
