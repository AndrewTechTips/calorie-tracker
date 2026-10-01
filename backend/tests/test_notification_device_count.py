"""GET /notifications/preferences reports how many devices the account can
be reached on (device_count), so the frontend can tell "push is on" apart
from "push can actually arrive" — the gap that left 2 of 3 push-enabled
accounts silently receiving nothing (found 2026-10-01)."""
import pytest
from fastapi.testclient import TestClient

import main
import routers.notifications as notifications_router
from auth import get_current_user
from tests.fake_postgrest import FakePostgrest


class _User:
    id = "user-1"


@pytest.fixture
def client():
    main.app.dependency_overrides[get_current_user] = lambda: _User()
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(get_current_user, None)


def _db(devices_for_user=0, devices_for_others=0):
    return FakePostgrest({
        "notification_preferences": [{"user_id": "user-1", "push_enabled": True, "language": "ro"}],
        "push_subscriptions": (
            [{"id": f"mine-{i}", "user_id": "user-1"} for i in range(devices_for_user)]
            + [{"id": f"other-{i}", "user_id": "someone-else"} for i in range(devices_for_others)]
        ),
    })


@pytest.mark.parametrize("mine", [0, 1, 3])
def test_device_count_counts_only_this_users_devices(client, monkeypatch, mine):
    monkeypatch.setattr(notifications_router, "get_supabase", lambda: _db(mine, devices_for_others=4))

    body = client.get("/notifications/preferences").json()

    assert body["device_count"] == mine
    assert body["push_enabled"] is True and body["language"] == "ro"


def test_a_failed_count_is_unknown_not_zero(client, monkeypatch):
    """None, never 0: the frontend announces "nothing can reach you" on 0,
    and a database blip must not make it say that to someone it can reach."""
    db = _db(2)
    real_table = db.table

    def _table(name):
        if name == "push_subscriptions":
            raise RuntimeError("supabase blinked")
        return real_table(name)

    db.table = _table
    monkeypatch.setattr(notifications_router, "get_supabase", lambda: db)

    response = client.get("/notifications/preferences")

    assert response.status_code == 200
    assert response.json()["device_count"] is None


def test_device_count_sent_back_on_save_is_ignored(client, monkeypatch):
    """The frontend keeps device_count out of what it saves, but if a client
    ever echoes it back it must neither fail the request nor reach the row."""
    db = _db(1)
    monkeypatch.setattr(notifications_router, "get_supabase", lambda: db)

    prefs = client.get("/notifications/preferences").json()
    response = client.put("/notifications/preferences", json=prefs)

    assert response.status_code == 200
    saved = db.tables["notification_preferences"][0]
    assert "device_count" not in saved
    assert "device_count" not in response.json()
