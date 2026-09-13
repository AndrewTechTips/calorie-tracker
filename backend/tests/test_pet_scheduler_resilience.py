"""The pet sweep must survive Supabase being slow or unreachable.

Same failure class as tests/test_notification_scheduler_resilience.py, same
exposure: sweep()'s top-level `profiles` select sat outside any try/except, so
one transient 504 cost EVERY user that tick's heart judgment AND their weekly
Discover challenge check.

The extra thing asserted here, which the notification sweep has no equivalent
of: _process_user banks its result in a single write at the END of a
multi-day catch-up loop, so a failure partway through must leave NOTHING
written. Swallowing an error inside that loop would deduct a heart for a day
whose logs were never actually read — a silent, user-visible wrong answer,
where an abort is merely a 30-minute delay.
"""

from datetime import date

import pytest
from postgrest.exceptions import APIError

from services import pet_scheduler as sched
from services import pet_service
from tests.fake_supabase import GATEWAY_TIMEOUT_BODY, FakeSupabase, validation_error_like_postgrest

TODAY = date(2026, 7, 22)  # a Wednesday
TWO_DAYS_AGO = date(2026, 7, 20)


def _profile(user_id="user-1"):
    return {"id": user_id, "timezone": "UTC", "daily_calories": 2000, "daily_water_ml": 3000}


def _client(profiles, failures=None, last_evaluated=TWO_DAYS_AGO):
    """A client whose pet_state is one full day behind, so _process_user has
    exactly one past day to judge and therefore a real write to make."""
    return FakeSupabase(
        rows={
            "profiles": profiles,
            "pet_state": {"hearts": pet_service.MAX_HEARTS, "last_evaluated_date": last_evaluated.isoformat()},
            "daily_logs": [],
            "water_logs": [],
            "discover_challenges": [],
        },
        failures=failures,
    )


@pytest.fixture
def sweep(monkeypatch):
    monkeypatch.setattr(sched, "local_today", lambda _tz: TODAY)

    def run(client):
        monkeypatch.setattr(sched, "get_supabase", lambda: client)
        sched.sweep()

    return run


def test_a_healthy_sweep_judges_the_day_and_scores_the_challenge(sweep):
    """The baseline the failure cases are measured against — without this,
    'nothing was written' below would pass for the wrong reason."""
    client = _client([_profile()])
    sweep(client)

    assert client.written("pet_state", "update")  # yesterday judged, hearts banked
    assert client.written("discover_challenges", "insert")  # this week's challenge scored


# --- the query that used to take the whole sweep down ----------------------


@pytest.mark.parametrize(
    "error",
    [
        validation_error_like_postgrest(),
        APIError(GATEWAY_TIMEOUT_BODY),
        APIError({"message": "JSON could not be generated", "code": 504, "hint": "", "details": ""}),
    ],
    ids=["raw-validation-error", "api-error", "postgrest-fallback-message"],
)
def test_a_transient_failure_loading_profiles_skips_the_sweep_quietly(sweep, caplog, error):
    client = _client([_profile()], failures={"profiles": [error]})

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)  # must not raise

    assert client.writes == []
    assert [record.levelname for record in caplog.records] == ["WARNING"]
    assert "\n" not in caplog.records[0].getMessage()


def test_a_real_bug_loading_profiles_still_gets_its_traceback(sweep, caplog):
    missing_table = APIError({"code": "42P01", "message": "relation does not exist", "hint": "", "details": ""})
    client = _client([_profile()], failures={"profiles": [missing_table]})

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)

    assert [record.levelname for record in caplog.records] == ["ERROR"]
    assert caplog.records[0].exc_info is not None


# --- isolation between users ----------------------------------------------


def test_one_users_timeout_does_not_stop_the_next_users_hearts(sweep, caplog):
    # pet_state is read first for every user: fail only the first read.
    client = _client(
        [_profile("user-1"), _profile("user-2")],
        failures={"pet_state": [validation_error_like_postgrest()]},
    )

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)

    assert len(client.written("pet_state", "update")) == 1  # user-2's, not user-1's
    assert [record.levelname for record in caplog.records] == ["WARNING"]


def test_one_users_challenge_timeout_does_not_stop_the_next_user(sweep, caplog):
    client = _client(
        [_profile("user-1"), _profile("user-2")],
        failures={"discover_challenges": [validation_error_like_postgrest()]},
    )

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)

    assert len(client.written("pet_state", "update")) == 2  # both users still judged
    assert len(client.written("discover_challenges", "insert")) == 1


# --- isolation between the two concerns, for one user ---------------------


def test_a_hearts_failure_does_not_withhold_that_users_challenge(sweep, caplog):
    client = _client([_profile()], failures={"pet_state": [validation_error_like_postgrest()]})

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)

    assert client.written("discover_challenges", "insert")


def test_a_challenge_failure_does_not_withhold_that_users_hearts(sweep, caplog):
    client = _client([_profile()], failures={"discover_challenges": [validation_error_like_postgrest()]})

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)

    assert client.written("pet_state", "update")


# --- the partial-write guarantee ------------------------------------------


def test_a_failure_mid_judgment_banks_nothing(sweep, caplog):
    """water_logs is read per judged day, inside the catch-up loop. Failing it
    must abort the user outright: no hearts value and no advanced
    last_evaluated_date may be written off a day that was never fully read,
    because last_evaluated_date is what stops that day being re-judged."""
    client = _client(
        [_profile()],
        failures={"water_logs": [validation_error_like_postgrest()]},
        last_evaluated=date(2026, 7, 17),  # several days behind -> a real catch-up walk
    )

    with caplog.at_level("WARNING", logger="pet_scheduler"):
        sweep(client)

    assert client.written("pet_state") == []
    assert [record.levelname for record in caplog.records] == ["WARNING"]
