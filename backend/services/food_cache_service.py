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

# Parallel dict, keyed the same as _cache: how many times each entry has
# actually been *reused* (a cache hit in get()), not how many times it was
# written. That's the real "popular across users" signal this module can
# offer — see list_popular() below, which powers GET /foods/popular
# (routers/foods.py) for the frontend's food-name autocomplete. A fresh
# put() always starts a name at 0 hits; it only starts counting once a
# second caller's rename actually reuses it.
_hits: dict[str, int] = {}


def _normalize(food_name: str) -> str:
    return " ".join(food_name.strip().lower().split())


def get(food_name: str) -> dict | None:
    key = _normalize(food_name)
    with _lock:
        value = _cache.get(key)
        if value is not None:
            _hits[key] = _hits.get(key, 0) + 1
        return value


def put(food_name: str, macros_per_100g: dict) -> None:
    key = _normalize(food_name)
    with _lock:
        if key not in _cache and len(_cache) >= _MAX_ENTRIES:
            evicted = next(iter(_cache))
            _cache.pop(evicted)
            _hits.pop(evicted, None)
        _cache[key] = macros_per_100g
        _hits.setdefault(key, 0)


# The food names actually worth suggesting back to users — reused at least
# once across the shared cache, ranked by how often. Deliberately excludes
# never-reused entries (hits == 0): those were only ever looked up by the one
# person who renamed to them, so surfacing them as "popular" would be
# misleading, not helpful.
def list_popular(limit: int = 10) -> list[str]:
    with _lock:
        ranked = sorted(
            (key for key in _cache if _hits.get(key, 0) > 0),
            key=lambda key: _hits[key],
            reverse=True,
        )
        return ranked[:limit]
