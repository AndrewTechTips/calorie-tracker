"""The notification sweep must survive Supabase being slow or unreachable.

Live failure this guards (2026-09-13): a Supabase 504 answered
`{"message": "Gateway Timeout"}`, which carries none of PostgREST's own error
fields, so postgrest-py's `APIErrorFromJSON` parse blew up with
`ValidationError: 3 validation errors` instead of raising the APIError the
caller expects. It happened on the sweep's FIRST query — the
notification_preferences select, the one thing outside any try/except — so a
single transient blip ended that tick's reminders for every user at once.

Nothing here asserts on wording; the contract is behavioural: the sweep never
raises, one user's failure never reaches the next user, and one notification
kind's failure never withholds that user's other kinds. The classifier those
rest on is tested in test_db_tolerance.py.
"""

from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from postgrest.exceptions import APIError

from services import notification_scheduler as sched
from tests.fake_supabase import GATEWAY_TIMEOUT_BODY, FakeSupabase, validation_error_like_postgrest

# 15:30 on a Wednesday, local: inside both nudge windows (14:00/15:00 ->
# 22:00) and not the recap's Sunday, so one fixed `now` exercises several
# independent kinds at once. Quiet hours are switched off per-user below
# (start == end), so this is stable whatever time the suite runs at.
FIXED_NOW = datetime(2026, 7, 22, 15, 30)


def _prefs(user_id="user-1", **overrides):
    prefs = {
        "user_id": user_id,
        "language": "en",
        "quiet_hours_start": "00:00",  # start == end -> quiet hours off
        "quiet_hours_end": "00:00",
        "reminder_mode": "interval",  # fires whenever last_sent_at is null
        "reminder_interval_hours": 4,
        "last_daily_reminder_sent_at": None,
        "smart_nudges_enabled": True,
        "weekly_recap_enabled": True,
    }
    prefs.update(overrides)
    return prefs


def _client(prefs_rows, failures=None):
    return FakeSupabase(
        rows={
            "notification_preferences": prefs_rows,
            "profiles": {"timezone": "UTC", "daily_calories": 2000, "daily_water_ml": 3000},
            "daily_logs": [],
            "water_logs": [],
        },
        failures=failures,
    )


@pytest.fixture
def sweep(monkeypatch):
    """Runs the real sweep against a FakeSupabase, with push sends captured
    instead of performed. Returns (run, sent) — `run(client)` executes one
    sweep, `sent` collects (user_id, kind) for every notification sent."""
    sent = []

    monkeypatch.setattr(sched, "get_settings", lambda: SimpleNamespace(vapid_configured=True, retention_days=7))
    monkeypatch.setattr(sched, "local_now", lambda _tz: FIXED_NOW)
    monkeypatch.setattr(sched, "send_to_user", lambda user_id, payload: sent.append((user_id, payload["tag"])) or 1)

    def run(client):
        monkeypatch.setattr(sched, "get_supabase", lambda: client)
        sched.check_and_send_notifications()

    return run, sent


# --- the query that used to take the whole sweep down ----------------------


@pytest.mark.parametrize(
    "error",
    [
        validation_error_like_postgrest(),
        APIError(GATEWAY_TIMEOUT_BODY),  # same 504, converted by a newer postgrest
        APIError({"message": "JSON could not be generated", "code": 504, "hint": "", "details": ""}),
        httpx.ReadTimeout("timed out"),
    ],
    ids=["raw-validation-error", "api-error", "postgrest-fallback-message", "transport-timeout"],
)
def test_a_transient_failure_loading_preferences_skips_the_sweep_quietly(sweep, caplog, error):
    run, sent = sweep
    client = _client([_prefs()], failures={"notification_preferences": [error]})

    with caplog.at_level("WARNING", logger="notification_scheduler"):
        run(client)  # must not raise — APScheduler is the only thing watching

    assert sent == []
    assert [record.levelname for record in caplog.records] == ["WARNING"]
    assert "\n" not in caplog.records[0].getMessage()  # one clean line, not a repr dump


def test_a_real_bug_loading_preferences_still_gets_its_traceback(sweep, caplog):
    run, _sent = sweep
    missing_column = APIError({"code": "42703", "message": "column does not exist", "hint": "", "details": ""})
    client = _client([_prefs()], failures={"notification_preferences": [missing_column]})

    with caplog.at_level("WARNING", logger="notification_scheduler"):
        run(client)

    assert [record.levelname for record in caplog.records] == ["ERROR"]
    assert caplog.records[0].exc_info is not None


# --- isolation between users ----------------------------------------------


def test_one_users_timeout_does_not_stop_the_next_user(sweep, caplog):
    run, sent = sweep
    # The profile read is the one per-user query with no in-user fallback:
    # fail it for the first user only, and the second must still be served.
    client = _client(
        [_prefs("user-1"), _prefs("user-2")],
        failures={"profiles": [validation_error_like_postgrest()]},
    )

    with caplog.at_level("WARNING", logger="notification_scheduler"):
        run(client)

    assert ("user-2", "daily_reminder") in sent
    assert {user_id for user_id, _kind in sent} == {"user-2"}
    assert [record.levelname for record in caplog.records] == ["WARNING"]


# --- isolation between notification kinds ---------------------------------


def test_one_kinds_timeout_does_not_withhold_the_users_other_kinds(sweep, caplog):
    run, sent = sweep
    # water_logs is only read by the water nudge; the daily reminder (no
    # query at all) and the food nudge (daily_logs) must still go out.
    client = _client([_prefs()], failures={"water_logs": [validation_error_like_postgrest()]})

    with caplog.at_level("WARNING", logger="notification_scheduler"):
        run(client)

    kinds = {kind for _user_id, kind in sent}
    assert "daily_reminder" in kinds
    assert "food_nudge" in kinds
    assert "water_nudge" not in kinds
    assert [record.levelname for record in caplog.records] == ["WARNING"]


def test_a_send_that_fails_to_be_recorded_does_not_abort_the_rest(sweep, caplog):
    run, sent = sweep
    # _mark_sent writes back to notification_preferences. Let the initial
    # select through, then fail the daily reminder's own UPDATE.
    client = _client(
        [_prefs()],
        failures={"notification_preferences": [None, validation_error_like_postgrest()]},
    )

    with caplog.at_level("WARNING", logger="notification_scheduler"):
        run(client)

    assert "food_nudge" in {kind for _user_id, kind in sent}
