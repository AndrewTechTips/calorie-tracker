import threading

# In-memory cache of Gemini's text-only per-100g macro answers, keyed by
# normalized food name. Only for the food-rename path in PATCH /logs/{id}
# (see gemini_service.py::estimate_macros_for_food_name) — vision scans are
# never cached, every photo is unique.
#
# A real capacity win, not just a latency one: with 15-20 users sharing one
# key, renames converge on the same common foods, so a hit skips the Gemini
# call entirely. It's also just as accurate, since the cached value is a
# real answer Gemini already gave for that exact name.
#
# Nutrition facts don't change, so entries never expire — only a size cap
# (FIFO eviction) bounds memory growth.
_lock = threading.Lock()
_MAX_ENTRIES = 500
_cache: dict[str, dict] = {}


def _normalize(food_name: str) -> str:
    return " ".join(food_name.strip().lower().split())


def get(food_name: str) -> dict | None:
    key = _normalize(food_name)
    with _lock:
        return _cache.get(key)


def put(food_name: str, macros_per_100g: dict) -> None:
    key = _normalize(food_name)
    with _lock:
        if key not in _cache and len(_cache) >= _MAX_ENTRIES:
            _cache.pop(next(iter(_cache)))
        _cache[key] = macros_per_100g
