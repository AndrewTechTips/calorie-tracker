from services import coach_cache_service

KINDS = ["weekendEffect", "proteinConsistency"]


def _reset():
    coach_cache_service._cache.clear()


def test_miss_then_hit():
    _reset()
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) is None
    coach_cache_service.put_recap_caption("user-1", "en", "Weekends drove the week.", KINDS)
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) == "Weekends drove the week."


def test_kind_signature_is_order_insensitive():
    _reset()
    coach_cache_service.put_recap_caption("user-1", "en", "cap", ["a", "b"])
    assert coach_cache_service.get_recap_caption("user-1", "en", ["b", "a"]) == "cap"


def test_changed_top_kinds_is_a_miss():
    _reset()
    coach_cache_service.put_recap_caption("user-1", "en", "cap", ["a", "b"])
    # The week's story changed — the cached caption was about a different set
    # of insights, so it must regenerate rather than sit atop the wrong cards.
    assert coach_cache_service.get_recap_caption("user-1", "en", ["a", "c"]) is None


def test_keys_are_per_user():
    _reset()
    coach_cache_service.put_recap_caption("user-1", "en", "cap 1", KINDS)
    coach_cache_service.put_recap_caption("user-2", "en", "cap 2", KINDS)
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) == "cap 1"
    assert coach_cache_service.get_recap_caption("user-2", "en", KINDS) == "cap 2"


def test_keys_are_per_language():
    _reset()
    coach_cache_service.put_recap_caption("user-1", "en", "Great week", KINDS)
    assert coach_cache_service.get_recap_caption("user-1", "ro", KINDS) is None
    coach_cache_service.put_recap_caption("user-1", "ro", "Săptămână bună", KINDS)
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) == "Great week"
    assert coach_cache_service.get_recap_caption("user-1", "ro", KINDS) == "Săptămână bună"


def test_expires_after_ttl(monkeypatch):
    _reset()
    fake_now = [1_000_000.0]
    monkeypatch.setattr(coach_cache_service.time, "time", lambda: fake_now[0])

    coach_cache_service.put_recap_caption("user-1", "en", "cap", KINDS)
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) == "cap"

    fake_now[0] += coach_cache_service.TTL_SECONDS - 1
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) == "cap"

    fake_now[0] += 2
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) is None


def test_put_resets_the_ttl_clock():
    _reset()
    coach_cache_service.put_recap_caption("user-1", "en", "first", KINDS)
    coach_cache_service.put_recap_caption("user-1", "en", "updated", KINDS)
    assert coach_cache_service.get_recap_caption("user-1", "en", KINDS) == "updated"


# --- the chat-stats snapshot cache (unchanged, kept here for coverage) ---
def test_stats_cache_miss_then_hit_then_expire(monkeypatch):
    coach_cache_service._stats_cache.clear()
    fake_now = [500.0]
    monkeypatch.setattr(coach_cache_service.time, "time", lambda: fake_now[0])
    assert coach_cache_service.get_stats("u") is None
    coach_cache_service.put_stats("u", {"streak": 4})
    assert coach_cache_service.get_stats("u") == {"streak": 4}
    fake_now[0] += coach_cache_service.STATS_TTL_SECONDS + 1
    assert coach_cache_service.get_stats("u") is None
