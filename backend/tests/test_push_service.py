from services.push_service import dedupe_subscriptions

# dedupe_subscriptions is the single send-time choke point that guarantees
# ONE notification per device even if push_subscriptions briefly holds more
# than one row for a device — the defense-in-depth layer behind the DB's own
# (user_id, device_id) partial unique index. See the duplicate-notification
# fix in routers/notifications.py + sql/schema.sql.


def _sub(endpoint, device_id=None, last_seen_at="2026-01-01T00:00:00+00:00"):
    return {
        "endpoint": endpoint,
        "device_id": device_id,
        "last_seen_at": last_seen_at,
        "p256dh": "k",
        "auth_key": "a",
    }


def test_passes_through_distinct_devices_untouched():
    subs = [_sub("https://push/a", "dev-1"), _sub("https://push/b", "dev-2")]
    assert dedupe_subscriptions(subs) == subs


def test_collapses_rotation_orphan_keeping_most_recently_seen():
    stale = _sub("https://push/old", "dev-1", last_seen_at="2026-01-01T00:00:00+00:00")
    fresh = _sub("https://push/new", "dev-1", last_seen_at="2026-06-01T00:00:00+00:00")
    result = dedupe_subscriptions([stale, fresh])
    assert result == [fresh]


def test_rotation_orphan_collapsed_regardless_of_input_order():
    fresh = _sub("https://push/new", "dev-1", last_seen_at="2026-06-01T00:00:00+00:00")
    stale = _sub("https://push/old", "dev-1", last_seen_at="2026-01-01T00:00:00+00:00")
    assert dedupe_subscriptions([fresh, stale]) == [fresh]


def test_legacy_rows_without_device_id_deduped_by_endpoint():
    a1 = _sub("https://push/a")
    a2 = _sub("https://push/a")
    b = _sub("https://push/b")
    result = dedupe_subscriptions([a1, a2, b])
    assert len(result) == 2
    assert {s["endpoint"] for s in result} == {"https://push/a", "https://push/b"}


def test_device_id_row_wins_over_legacy_row_sharing_its_endpoint():
    legacy = _sub("https://push/a")  # no device_id
    with_device = _sub("https://push/a", "dev-1")
    result = dedupe_subscriptions([legacy, with_device])
    assert result == [with_device]


def test_empty_input():
    assert dedupe_subscriptions([]) == []
