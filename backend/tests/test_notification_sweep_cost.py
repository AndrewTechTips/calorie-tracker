"""The notification sweep must stay cheap without changing a single decision.

Measured 2026-10-01: ~434 Supabase requests an hour, around the clock, ~82%
of the project's traffic and the main driver of its Log Ingestion quota —
from this sweep reading a profile, today's food and today's water for every
push-enabled user on every 2-minute tick, including users with no device to
send to. The rewrite skips unreachable users, batches the profile read, asks
each eligibility function the most-permissive question before querying,
remembers answers that settle a nudge for the day, and backs off failed
sends.

Two kinds of test here:
  * cost — which tables a tick actually reads, in the situations that used
    to read them for nothing;
  * equivalence — across every hour of a day and every data state, the new
    sweep sends exactly what the eligibility functions decide when handed
    the real data. Being cheaper is only worth anything if this holds.
"""

from datetime import datetime, timedelta, timezone
from itertools import product
from types import SimpleNamespace

import pytest

from services import notification_scheduler as sched
from services import notification_service as ns
from tests.fake_supabase import FakeSupabase

WEDNESDAY = datetime(2026, 7, 22)  # not the recap's Sunday


def _prefs(user_id="user-1", **overrides):
    prefs = {
        "user_id": user_id,
        "language": "en",
        "quiet_hours_start": "22:00",
        "quiet_hours_end": "08:00",
        "reminder_mode": "fixed",
        "daily_reminder_time": "19:00",
        "last_daily_reminder_sent_at": None,
        "smart_nudges_enabled": True,
        "weekly_recap_enabled": True,
        "last_food_nudge_sent": None,
        "last_water_nudge_sent": None,
        "last_discover_pick_sent": None,
        "last_weekly_recap_sent": None,
    }
    prefs.update(overrides)
    return prefs


def _client(prefs_rows, *, devices=None, food_calories=None, water_ml=0, target_calories=2000, water_target=3000):
    """`devices`: user ids that have a push_subscriptions row (default: all).
    `food_calories`: list of today's logged calorie amounts ([] = nothing)."""
    user_ids = [p["user_id"] for p in prefs_rows]
    devices = user_ids if devices is None else devices
    food_calories = food_calories or []
    return FakeSupabase(
        rows={
            "notification_preferences": prefs_rows,
            "push_subscriptions": [{"user_id": u} for u in devices],
            "profiles": [
                {"id": u, "timezone": "UTC", "daily_calories": target_calories, "daily_water_ml": water_target}
                for u in user_ids
            ],
            "daily_logs": [{"id": f"log-{i}", "calories": c, "log_date": "x"} for i, c in enumerate(food_calories)],
            "water_logs": [{"amount_ml": water_ml}] if water_ml else [],
        }
    )


@pytest.fixture
def sweep(monkeypatch):
    sent = []
    clock = {"now": WEDNESDAY.replace(hour=15)}
    deliver = {"ok": True}
    sched._reset_sweep_memory()

    monkeypatch.setattr(sched, "get_settings", lambda: SimpleNamespace(vapid_configured=True, retention_days=7))
    monkeypatch.setattr(sched, "local_now", lambda _tz: clock["now"])

    def _send_to_user(user_id, payload):
        sent.append((user_id, payload["tag"]))
        return 1 if deliver["ok"] else 0

    monkeypatch.setattr(sched, "send_to_user", _send_to_user)

    def run(client, hour=None, minute=0, day=WEDNESDAY):
        if hour is not None:
            clock["now"] = day.replace(hour=hour, minute=minute)
        monkeypatch.setattr(sched, "get_supabase", lambda: client)
        sched.check_and_send_notifications()
        return client.calls

    yield SimpleNamespace(run=run, sent=sent, deliver=deliver)
    sched._reset_sweep_memory()


def _reads(calls, table):
    return calls.count(table)


# --- cost ---------------------------------------------------------------------


def test_users_without_a_device_cost_nothing_beyond_the_two_shared_reads(sweep):
    client = _client([_prefs("a"), _prefs("b")], devices=[])

    calls = sweep.run(client, hour=15)

    assert calls == ["notification_preferences", "push_subscriptions"]
    assert sweep.sent == []


def test_profiles_and_devices_are_read_once_per_tick_whatever_the_user_count(sweep):
    users = [_prefs(f"user-{i}") for i in range(6)]
    calls = sweep.run(_client(users), hour=3)

    assert _reads(calls, "profiles") == 1
    assert _reads(calls, "push_subscriptions") == 1


def test_a_night_tick_reads_no_logs_at_all(sweep):
    """03:00 local: inside default quiet hours and outside every nudge window.
    This was ~3 reads per user per tick, all night."""
    calls = sweep.run(_client([_prefs("a"), _prefs("b"), _prefs("c")]), hour=3)

    assert calls == ["notification_preferences", "push_subscriptions", "profiles"]
    assert sweep.sent == []


def test_a_morning_tick_reads_no_logs(sweep):
    calls = sweep.run(_client([_prefs()]), hour=10)
    assert _reads(calls, "daily_logs") == 0
    assert _reads(calls, "water_logs") == 0


def test_a_nudge_already_sent_today_is_not_re_queried(sweep):
    today = WEDNESDAY.date().isoformat()
    prefs = _prefs(last_food_nudge_sent=today, last_water_nudge_sent=today)

    calls = sweep.run(_client([prefs]), hour=16)

    assert _reads(calls, "daily_logs") == 0
    assert _reads(calls, "water_logs") == 0


def test_logged_food_settles_the_food_nudge_for_the_rest_of_that_day(sweep):
    client = _client([_prefs()], food_calories=[400])
    first = sweep.run(client, hour=14, minute=0)
    assert _reads(first, "daily_logs") == 1
    assert ("user-1", "food_nudge") not in sweep.sent

    client.calls.clear()
    later = sweep.run(client, hour=14, minute=2)
    assert _reads(later, "daily_logs") == 0, "settled — no reason to read it again today"

    client.calls.clear()
    next_day = sweep.run(client, hour=14, day=WEDNESDAY + timedelta(days=1))
    assert _reads(next_day, "daily_logs") == 1, "a new day starts unsettled"


def test_water_below_target_is_re_checked_but_a_met_target_is_settled(sweep):
    partly = _client([_prefs(last_water_nudge_sent=None)], water_ml=1000)
    sweep.deliver["ok"] = False  # keep the nudge unsent so it stays eligible
    sweep.run(partly, hour=15)
    sweep.deliver["ok"] = True
    sched._RETRY_AFTER.clear()
    partly.calls.clear()
    sweep.run(partly, hour=15, minute=2)
    assert _reads(partly.calls, "water_logs") == 1, "not settled: more water could still be logged"

    sched._reset_sweep_memory()
    met = _client([_prefs()], water_ml=3500)
    sweep.run(met, hour=15)
    met.calls.clear()
    sweep.run(met, hour=15, minute=2)
    assert _reads(met.calls, "water_logs") == 0


def test_too_little_budget_left_settles_the_discover_pick(sweep):
    client = _client(
        [_prefs(last_food_nudge_sent=WEDNESDAY.date().isoformat())],
        food_calories=[1900],
        water_ml=3500,
    )
    sweep.run(client, hour=17, minute=30)
    assert ("user-1", "discover_pick") not in sweep.sent
    client.calls.clear()
    sweep.run(client, hour=17, minute=32)
    assert _reads(client.calls, "daily_logs") == 0


def test_a_failed_send_is_not_retried_on_every_tick(sweep):
    sweep.deliver["ok"] = False
    client = _client([_prefs(daily_reminder_time="14:00")], food_calories=[300], water_ml=3500)

    sweep.run(client, hour=14)
    assert sweep.sent == [("user-1", "daily_reminder")]

    sweep.run(client, hour=14, minute=2)
    assert sweep.sent == [("user-1", "daily_reminder")], "backing off, not hammering the push service"

    # Once the backoff has elapsed it is tried again, and a success clears it.
    sched._RETRY_AFTER[("user-1", "daily_reminder")] = datetime.now(timezone.utc) - timedelta(seconds=1)
    sweep.deliver["ok"] = True
    sweep.run(client, hour=14, minute=4)
    assert sweep.sent.count(("user-1", "daily_reminder")) == 2
    assert ("user-1", "daily_reminder") not in sched._RETRY_AFTER


def test_the_retry_backoff_is_thirty_minutes():
    assert sched._SEND_RETRY_BACKOFF == timedelta(minutes=30)


# --- equivalence ----------------------------------------------------------------


def _expected_kinds(now, prefs, *, food_calories, water_ml, target_calories=2000, water_target=3000):
    """What the eligibility functions decide when handed the REAL data —
    i.e. what the sweep did before it learned to skip queries."""
    quiet_start = ns.parse_hhmm(prefs["quiet_hours_start"], None)
    quiet_end = ns.parse_hhmm(prefs["quiet_hours_end"], None)
    today = now.date().isoformat()
    kinds = set()
    if ns.should_send_daily_reminder(
        enabled=True, mode=prefs["reminder_mode"], reminder_time=ns.parse_hhmm(prefs["daily_reminder_time"], None),
        interval_hours=4, now=now, quiet_start=quiet_start, quiet_end=quiet_end, last_sent_at=None,
    ):
        kinds.add("daily_reminder")
    common = dict(enabled=True, now=now, quiet_start=quiet_start, quiet_end=quiet_end)
    if ns.should_send_food_nudge(
        **common, already_sent_today=prefs["last_food_nudge_sent"] == today, has_logged_food_today=bool(food_calories)
    ):
        kinds.add("food_nudge")
    if ns.should_send_water_nudge(
        **common, already_sent_today=prefs["last_water_nudge_sent"] == today,
        water_ml=water_ml, water_target_ml=water_target,
    ):
        kinds.add("water_nudge")
    if ns.should_send_discover_pick(
        **common, already_sent_today=prefs["last_discover_pick_sent"] == today,
        calories_remaining=target_calories - sum(food_calories),
    ):
        kinds.add("discover_pick")
    return kinds


@pytest.mark.parametrize(
    "hour, food_calories, water_ml, quiet",
    list(product(range(24), [[], [500], [1900]], [0, 1200, 3500], ["22:00-08:00", "00:00-00:00"])),
)
def test_the_sweep_sends_exactly_what_the_eligibility_functions_decide(sweep, hour, food_calories, water_ml, quiet):
    start, end = quiet.split("-")
    prefs = _prefs(quiet_hours_start=start, quiet_hours_end=end)
    client = _client([prefs], food_calories=food_calories, water_ml=water_ml)

    sweep.run(client, hour=hour, minute=30)

    now = WEDNESDAY.replace(hour=hour, minute=30)
    expected = _expected_kinds(now, prefs, food_calories=food_calories, water_ml=water_ml)
    assert {kind for _user, kind in sweep.sent} == expected
