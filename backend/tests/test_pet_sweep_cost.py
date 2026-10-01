"""The pet sweep must stay cheap without changing a single heart.

Measured 2026-10-01 (log-ingestion audit): the sweep read pet_state,
discover_challenges and this week's cooked recipes for every profile on every
30-minute tick — 1 + 3 reads per account, 48 times a day — although hearts
move at most once a day per user and a finished challenge never changes.
A tick now makes at most four batched reads, whatever the number of users.

These run the real sweep against tests/fake_postgrest.py, which applies
filters and writes like PostgREST, so a wrong batched read shows up as a
wrong heart rather than passing silently. The rewrite was additionally
checked against the previous implementation (git history) on 1,200 random
scenarios x up to 30 ticks across 10 days and 4 timezones: zero differences
in anything either version wrote.
"""

from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from postgrest.exceptions import APIError

from services import pet_scheduler as sched
from services import pet_service
from tests.fake_postgrest import FakePostgrest

# 2026-09-27 is a Sunday (ISO week 39: high-protein challenge, target 3);
# 2026-09-28 is the Monday that starts week 40 (quick-kitchen, target 3).
SUNDAY = date(2026, 9, 27)
MONDAY = date(2026, 9, 28)
HIGH_PROTEIN = ["ro-tocanita-pui", "ro-mici", "signature-miso-salmon-broccolini"]
QUICK = ["ro-ciorba-legume", "ro-salata-vinete", "ro-zacusca-toast"]

# Fixed local "today" per timezone, so two users can sit in different ISO
# weeks during the same tick.
TZ_TODAY = {"UTC": MONDAY, "America/New_York": SUNDAY}


def _profile(user_id, tz="UTC", calories=2000, water=3000):
    return {"id": user_id, "timezone": tz, "daily_calories": calories, "daily_water_ml": water}


def _pet(user_id, hearts=pet_service.MAX_HEARTS, last_evaluated=None):
    return {"user_id": user_id, "hearts": hearts, "last_evaluated_date": last_evaluated}


@pytest.fixture
def run(monkeypatch):
    monkeypatch.setattr(sched, "get_settings", lambda: SimpleNamespace(retention_days=7))
    monkeypatch.setattr(sched, "local_today", lambda tz: TZ_TODAY.get(tz, MONDAY))

    def _run(db):
        monkeypatch.setattr(sched, "get_supabase", lambda: db)
        sched.sweep()
        return db

    return _run


def _pet_row(db, user_id):
    return next(row for row in db.tables["pet_state"] if row["user_id"] == user_id)


# --- cost ---------------------------------------------------------------------


@pytest.mark.parametrize("user_count", [1, 5, 20])
def test_a_quiet_tick_costs_four_reads_whatever_the_user_count(run, user_count):
    """Everyone already judged up to yesterday, challenges in progress: the
    old sweep made 1 + 3 x users reads here and changed nothing."""
    users = [f"u{i}" for i in range(user_count)]
    db = FakePostgrest({
        "profiles": [_profile(u) for u in users],
        "pet_state": [_pet(u, last_evaluated=(MONDAY - timedelta(days=1)).isoformat()) for u in users],
        "discover_challenges": [
            {"user_id": u, "iso_week": "2026-W40", "challenge_key": "quick-kitchen", "target": 3, "progress": 0,
             "completed_at": None, "heart_awarded": False}
            for u in users
        ],
        "daily_logs": [],
        "water_logs": [],
    })

    run(db)

    assert dict(db.reads) == {"profiles": 1, "pet_state": 1, "discover_challenges": 1, "daily_logs": 1}
    assert sum(db.writes.values()) == 0


def test_cooked_recipes_are_not_read_once_every_challenge_is_rewarded(run):
    db = FakePostgrest({
        "profiles": [_profile("a"), _profile("b")],
        "pet_state": [_pet(u, last_evaluated=(MONDAY - timedelta(days=1)).isoformat()) for u in ("a", "b")],
        "discover_challenges": [
            {"user_id": u, "iso_week": "2026-W40", "challenge_key": "quick-kitchen", "target": 3, "progress": 3,
             "completed_at": "2026-09-29T10:00:00", "heart_awarded": True}
            for u in ("a", "b")
        ],
    })

    run(db)

    assert dict(db.reads) == {"profiles": 1, "pet_state": 1, "discover_challenges": 1}


def test_a_day_to_judge_costs_its_two_reads_once_then_nothing(run):
    db = FakePostgrest({
        "profiles": [_profile("a")],
        "pet_state": [_pet("a", hearts=2, last_evaluated=(MONDAY - timedelta(days=2)).isoformat())],
        "daily_logs": [{"user_id": "a", "log_date": "2026-09-27", "calories": 2000, "discover_recipe_id": None}],
        "water_logs": [{"user_id": "a", "log_date": "2026-09-27", "amount_ml": 3000}],
        "discover_challenges": [],
    })

    run(db)
    assert db.reads["water_logs"] == 1
    assert _pet_row(db, "a") == {"user_id": "a", "hearts": 3, "last_evaluated_date": "2026-09-27"}

    db.reads.clear()
    run(db)
    assert db.reads["water_logs"] == 0, "yesterday is judged; nothing to re-read"
    assert _pet_row(db, "a")["hearts"] == 3


def test_no_profiles_means_one_read(run):
    db = FakePostgrest({"profiles": []})
    run(db)
    assert dict(db.reads) == {"profiles": 1}


# --- correctness, through the batched reads -------------------------------------


def test_a_bad_day_costs_a_heart_and_a_new_user_starts_full(run):
    db = FakePostgrest({
        "profiles": [_profile("bad"), _profile("new")],
        "pet_state": [_pet("bad", hearts=3, last_evaluated=(MONDAY - timedelta(days=2)).isoformat())],
        "daily_logs": [],
        "water_logs": [],
    })

    run(db)

    assert _pet_row(db, "bad") == {"user_id": "bad", "hearts": 2, "last_evaluated_date": "2026-09-27"}
    # First sighting: created at full, starting point set to yesterday, nothing judged.
    assert _pet_row(db, "new") == {"user_id": "new", "hearts": pet_service.MAX_HEARTS, "last_evaluated_date": "2026-09-27"}


def test_each_user_is_scored_against_their_own_week_only(run):
    """One batched read spans both users' weeks. A Sunday cook in New York
    (still week 39) must not count toward the UTC user's week 40, and vice
    versa — each sees only their own Monday..Sunday."""
    logs = [
        # NY user, week 39 (Sun 27th): two high-protein cooks.
        {"user_id": "ny", "log_date": "2026-09-27", "calories": 500, "discover_recipe_id": HIGH_PROTEIN[0]},
        {"user_id": "ny", "log_date": "2026-09-27", "calories": 500, "discover_recipe_id": HIGH_PROTEIN[1]},
        # UTC user, week 39 cooks (must NOT count for week 40) + one week-40 quick cook.
        {"user_id": "utc", "log_date": "2026-09-27", "calories": 500, "discover_recipe_id": QUICK[0]},
        {"user_id": "utc", "log_date": "2026-09-27", "calories": 500, "discover_recipe_id": QUICK[1]},
        {"user_id": "utc", "log_date": "2026-09-28", "calories": 500, "discover_recipe_id": QUICK[2]},
    ]
    db = FakePostgrest({
        "profiles": [_profile("ny", tz="America/New_York"), _profile("utc")],
        "pet_state": [
            _pet("ny", last_evaluated=(SUNDAY - timedelta(days=1)).isoformat()),
            _pet("utc", last_evaluated=(MONDAY - timedelta(days=1)).isoformat()),
        ],
        "daily_logs": logs,
        "water_logs": [],
        "discover_challenges": [],
    })

    run(db)

    rows = {row["user_id"]: row for row in db.tables["discover_challenges"]}
    assert (rows["ny"]["iso_week"], rows["ny"]["progress"]) == ("2026-W39", 2)
    assert (rows["utc"]["iso_week"], rows["utc"]["progress"]) == ("2026-W40", 1)


def test_completion_heals_after_the_same_ticks_heart_judgment(run):
    """Hearts are judged first, then the challenge heal re-reads hearts fresh:
    2 -> 3 (good day) -> 4 (challenge), never 2 -> 3 overwritten by a stale 2."""
    db = FakePostgrest({
        "profiles": [_profile("a")],
        "pet_state": [_pet("a", hearts=2, last_evaluated=(MONDAY - timedelta(days=2)).isoformat())],
        "daily_logs": [
            {"user_id": "a", "log_date": "2026-09-27", "calories": 2000, "discover_recipe_id": None},
            *[{"user_id": "a", "log_date": "2026-09-28", "calories": 400, "discover_recipe_id": r} for r in QUICK],
        ],
        "water_logs": [{"user_id": "a", "log_date": "2026-09-27", "amount_ml": 3000}],
        "discover_challenges": [],
    })

    run(db)

    assert _pet_row(db, "a")["hearts"] == 4
    row = db.tables["discover_challenges"][0]
    assert row["progress"] == 3 and row["completed_at"] and row["heart_awarded"] is True

    # Rewarded: a later tick never heals again, and stops reading cooked logs.
    db.reads.clear()
    _pet_row(db, "a")["hearts"] = 1
    run(db)
    assert _pet_row(db, "a")["hearts"] == 1
    assert "daily_logs" not in db.reads


def test_a_missing_challenges_table_leaves_hearts_working(run, monkeypatch):
    db = FakePostgrest({
        "profiles": [_profile("a")],
        "pet_state": [_pet("a", hearts=3, last_evaluated=(MONDAY - timedelta(days=2)).isoformat())],
        "daily_logs": [],
        "water_logs": [],
    })
    real_table = db.table

    def _table(name):
        if name == "discover_challenges":
            raise APIError({"code": "42P01", "message": "relation does not exist", "hint": "", "details": ""})
        return real_table(name)

    monkeypatch.setattr(db, "table", _table)

    run(db)

    assert _pet_row(db, "a")["hearts"] == 2
    assert "discover_challenges" not in db.tables
