from services import food_cache_service


def _reset():
    food_cache_service._cache.clear()


def test_miss_then_hit():
    _reset()
    assert food_cache_service.get("chicken breast") is None
    food_cache_service.put("chicken breast", {"calories_per_100g": 165})
    assert food_cache_service.get("chicken breast") == {"calories_per_100g": 165}


def test_lookup_is_case_and_whitespace_insensitive():
    _reset()
    food_cache_service.put("  Chicken   Breast ", {"calories_per_100g": 165})
    assert food_cache_service.get("chicken breast") == {"calories_per_100g": 165}
    assert food_cache_service.get("CHICKEN BREAST") == {"calories_per_100g": 165}


def test_evicts_oldest_entry_once_full(monkeypatch):
    _reset()
    monkeypatch.setattr(food_cache_service, "_MAX_ENTRIES", 2)
    food_cache_service.put("rice", {"calories_per_100g": 130})
    food_cache_service.put("banana", {"calories_per_100g": 89})
    assert food_cache_service.get("rice") is not None

    food_cache_service.put("egg", {"calories_per_100g": 155})
    assert len(food_cache_service._cache) == 2
    assert food_cache_service.get("rice") is None  # oldest, evicted
    assert food_cache_service.get("banana") is not None
    assert food_cache_service.get("egg") is not None
