from services import coach_cache_service


def _reset():
    coach_cache_service._cache.clear()


def test_miss_then_hit():
    _reset()
    assert coach_cache_service.get("user-1", "en") is None
    coach_cache_service.put("user-1", "en", "Great week!")
    assert coach_cache_service.get("user-1", "en") == "Great week!"


def test_keys_are_per_user():
    _reset()
    coach_cache_service.put("user-1", "en", "Recap for user 1")
    coach_cache_service.put("user-2", "en", "Recap for user 2")
    assert coach_cache_service.get("user-1", "en") == "Recap for user 1"
    assert coach_cache_service.get("user-2", "en") == "Recap for user 2"


def test_keys_are_per_language():
    _reset()
    coach_cache_service.put("user-1", "en", "Great week!")
    # A different language for the same user is a genuine cache miss, not a
    # stale-language hit — this is the whole reason language is part of the
    # key (see the module's own docstring).
    assert coach_cache_service.get("user-1", "ro") is None
    coach_cache_service.put("user-1", "ro", "Săptămână excelentă!")
    assert coach_cache_service.get("user-1", "en") == "Great week!"
    assert coach_cache_service.get("user-1", "ro") == "Săptămână excelentă!"


def test_expires_after_ttl(monkeypatch):
    _reset()
    fake_now = [1_000_000.0]
    monkeypatch.setattr(coach_cache_service.time, "time", lambda: fake_now[0])

    coach_cache_service.put("user-1", "en", "Great week!")
    assert coach_cache_service.get("user-1", "en") == "Great week!"

    fake_now[0] += coach_cache_service.TTL_SECONDS - 1
    assert coach_cache_service.get("user-1", "en") == "Great week!"  # just under a week — still fresh

    fake_now[0] += 2
    assert coach_cache_service.get("user-1", "en") is None  # past a week — expired


def test_put_resets_the_ttl_clock():
    _reset()
    coach_cache_service.put("user-1", "en", "First recap")
    coach_cache_service.put("user-1", "en", "Updated recap")
    assert coach_cache_service.get("user-1", "en") == "Updated recap"
