"""Coverage for the Phase 1 local-corpus retrieval path.

Everything here is offline and deterministic — the Supabase RPC and the
embedding model are both stubbed. What is under test is the WIRING, not the
matching quality: matching quality is what tests/test_retrieval_eval.py
measures, against 2,010 frozen real candidates, and neither file duplicates
the other.

The specific things this file exists to hold still, because each one is a way
the migration could go quietly wrong in production rather than loudly wrong in
CI:

  * the local path and the remote path must run the IDENTICAL gates, so
    switching sources cannot change which candidate wins;
  * the remote fallback must fire when the local corpus grounds nothing, and
    must NOT fire when it grounds something;
  * custom foods must never reach the shared cross-user cache;
  * every failure mode of the new dependency (no fastembed, no RPC, no table,
    a failed embedding) must degrade to a normal miss, never to an exception,
    because lookup() promises its callers it never raises.
"""

import asyncio

import pytest

from services import nutrition_db_service


class _Settings:
    nutrition_db_grounding_enabled = True
    nutrition_db_local_corpus = True
    nutrition_db_remote_fallback = True
    nutrition_db_match_count = 40
    usda_api_key = "test-key"


def _reset(monkeypatch, **overrides):
    nutrition_db_service._cache.clear()
    settings = _Settings()
    for key, value in overrides.items():
        setattr(settings, key, value)
    monkeypatch.setattr(nutrition_db_service, "get_settings", lambda: settings)
    return settings


def _rpc_row(name, source="usda", **macros):
    row = {
        "food_name": name,
        "source": source,
        "calories_per_100g": 165.0,
        "protein_per_100g": 31.0,
        "carbs_per_100g": 0.0,
        "fats_per_100g": 3.6,
        "fiber_per_100g": None,
        "sugar_per_100g": None,
        "sodium_per_100g": None,
    }
    row.update(macros)
    return row


def _stub_rpc(monkeypatch, rows, capture=None):
    """Stands in for supabase.rpc(...).execute(). `capture` collects the
    params each call was made with, so a test can assert on what was actually
    sent (notably p_user_id)."""

    class _Response:
        def __init__(self, data):
            self.data = data

    class _RPC:
        def __init__(self, params):
            self._params = params

        def execute(self):
            if capture is not None:
                capture.append(self._params)
            return _Response(rows(self._params) if callable(rows) else rows)

    class _Client:
        def rpc(self, name, params):
            assert name == "match_nutrition_corpus"
            return _RPC(params)

    monkeypatch.setitem(
        __import__("sys").modules,
        "database",
        type("m", (), {"get_supabase": staticmethod(lambda: _Client())}),
    )


def _stub_embedding(monkeypatch, vector=None, available=True):
    monkeypatch.setattr(nutrition_db_service.corpus_embedding, "is_available", lambda: available)
    monkeypatch.setattr(
        nutrition_db_service.corpus_embedding,
        "embed_query",
        lambda text: vector if vector is not None else [0.0] * 384,
    )


# ---------------------------------------------------------------------------
# The gates are the gates, whatever the source
# ---------------------------------------------------------------------------
async def test_local_candidates_go_through_the_same_gates_as_remote(monkeypatch):
    """The whole safety argument for Phase 1 is that only RETRIEVAL changed.
    A form-changed product retrieved locally must be rejected exactly as it
    would have been coming back from the API."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [
        _rpc_row("Banana chips", calories_per_100g=519.0, protein_per_100g=2.3,
                 carbs_per_100g=58.4, fats_per_100g=33.6),
        _rpc_row("Bananas, raw", calories_per_100g=89.0, protein_per_100g=1.1,
                 carbs_per_100g=22.8, fats_per_100g=0.3),
    ])
    monkeypatch.setattr(nutrition_db_service, "_search_remote", _fail_if_called)

    result = await nutrition_db_service.lookup("banana")
    assert result is not None
    assert result["food_name"] == "Bananas, raw", "the form-change trap must still be rejected"


async def _fail_if_called(*args, **kwargs):
    raise AssertionError("the remote search should not have been reached")


async def test_rows_missing_a_required_macro_are_dropped(monkeypatch):
    _reset(monkeypatch, nutrition_db_remote_fallback=False)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [_rpc_row("Bananas, raw", calories_per_100g=None)])

    assert await nutrition_db_service.lookup("banana") is None


async def test_absent_micros_stay_none_and_are_not_coerced_to_zero(monkeypatch):
    """lookup()'s contract: a source being SILENT on fiber/sugar/sodium is
    distinct from it reporting zero, and gemini_service._fill_missing_micros
    keys off exactly that. A 0 here would be a fabricated verified-looking
    figure."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [_rpc_row("Bananas, raw", calories_per_100g=89.0,
                                     protein_per_100g=1.1, carbs_per_100g=22.8,
                                     fats_per_100g=0.3, fiber_per_100g=2.6)])

    result = await nutrition_db_service.lookup("banana")
    assert result["fiber_per_100g"] == 2.6
    assert result.get("sugar_per_100g") is None
    assert result.get("sodium_per_100g") is None


# ---------------------------------------------------------------------------
# Fallback behaviour
# ---------------------------------------------------------------------------
async def test_remote_fallback_fires_when_local_grounds_nothing(monkeypatch):
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [])
    called = []

    async def fake_remote(food_name):
        called.append(food_name)
        return [("Walnuts", {"food_name": "Walnuts", "source": "openfoodfacts",
                             "calories_per_100g": 654.0, "protein_per_100g": 15.2,
                             "carbs_per_100g": 13.7, "fats_per_100g": 65.2})]

    monkeypatch.setattr(nutrition_db_service, "_search_remote", fake_remote)

    result = await nutrition_db_service.lookup("walnuts")
    assert called == ["walnuts"]
    assert result["food_name"] == "Walnuts"


async def test_remote_fallback_does_not_fire_when_local_grounds(monkeypatch):
    """The point of the local corpus is to keep the request off the network.
    If the fallback fired on a successful local match it would spend the
    external quota anyway and the migration would buy nothing."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [_rpc_row("Bananas, raw", calories_per_100g=89.0,
                                     protein_per_100g=1.1, carbs_per_100g=22.8, fats_per_100g=0.3)])
    monkeypatch.setattr(nutrition_db_service, "_search_remote", _fail_if_called)

    assert (await nutrition_db_service.lookup("banana")) is not None


async def test_fallback_can_be_switched_off(monkeypatch):
    _reset(monkeypatch, nutrition_db_remote_fallback=False)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [])
    monkeypatch.setattr(nutrition_db_service, "_search_remote", _fail_if_called)

    assert await nutrition_db_service.lookup("walnuts") is None


async def test_local_corpus_off_uses_the_remote_path_only(monkeypatch):
    """The flag defaults to False, so this is the behaviour every existing
    deployment keeps until the migration is applied and the flag flipped."""
    _reset(monkeypatch, nutrition_db_local_corpus=False)
    called = []

    async def fake_remote(food_name):
        called.append(food_name)
        return []

    monkeypatch.setattr(nutrition_db_service, "_search_remote", fake_remote)
    monkeypatch.setattr(nutrition_db_service, "_search_local", _fail_if_called)

    await nutrition_db_service.lookup("banana")
    assert called == ["banana"]


# ---------------------------------------------------------------------------
# Failure modes — every one must degrade, never raise
# ---------------------------------------------------------------------------
async def test_rpc_failure_degrades_to_a_miss(monkeypatch):
    _reset(monkeypatch, nutrition_db_remote_fallback=False)
    _stub_embedding(monkeypatch)

    class _Client:
        def rpc(self, name, params):
            raise RuntimeError("relation \"nutrition_corpus\" does not exist")

    monkeypatch.setitem(
        __import__("sys").modules,
        "database",
        type("m", (), {"get_supabase": staticmethod(lambda: _Client())}),
    )

    assert await nutrition_db_service.lookup("banana") is None


async def test_missing_fastembed_still_queries_by_text(monkeypatch):
    """A deployment without the embedding model must still get the full-text
    half of the hybrid search, with a null vector telling the RPC to skip its
    vector CTE."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch, available=False)
    captured = []
    _stub_rpc(monkeypatch, [_rpc_row("Bananas, raw", calories_per_100g=89.0,
                                     protein_per_100g=1.1, carbs_per_100g=22.8, fats_per_100g=0.3)],
              capture=captured)
    monkeypatch.setattr(nutrition_db_service, "_search_remote", _fail_if_called)

    result = await nutrition_db_service.lookup("banana")
    assert result is not None
    assert captured[0]["p_query_embedding"] is None
    assert captured[0]["p_query_text"] == "banana"


async def test_failed_embedding_still_queries_by_text(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(nutrition_db_service.corpus_embedding, "is_available", lambda: True)
    monkeypatch.setattr(nutrition_db_service.corpus_embedding, "embed_query", lambda text: None)
    captured = []
    _stub_rpc(monkeypatch, [_rpc_row("Bananas, raw", calories_per_100g=89.0,
                                     protein_per_100g=1.1, carbs_per_100g=22.8, fats_per_100g=0.3)],
              capture=captured)
    monkeypatch.setattr(nutrition_db_service, "_search_remote", _fail_if_called)

    assert await nutrition_db_service.lookup("banana") is not None
    assert captured[0]["p_query_embedding"] is None


# ---------------------------------------------------------------------------
# Cross-user isolation — the one genuinely dangerous thing here
# ---------------------------------------------------------------------------
async def test_corpus_lookup_never_sends_a_user_id(monkeypatch):
    """lookup()'s result is memoized in a module-level dict shared by every
    user this process serves. If a user-scoped row could reach that cache, the
    next user to look up the same food name would be served someone else's
    saved food. The corpus query must therefore always be user-independent."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    captured = []
    _stub_rpc(monkeypatch, [], capture=captured)
    monkeypatch.setattr(nutrition_db_service, "_search_remote", _fail_if_called)

    await nutrition_db_service.lookup("banana")
    assert captured and captured[0]["p_user_id"] is None


async def test_fuzzy_custom_lookup_is_scoped_to_the_caller(monkeypatch):
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    captured = []
    _stub_rpc(monkeypatch, [
        _rpc_row("Piept de pui la gratar", source="custom", calories_per_100g=165.0,
                 protein_per_100g=31.0, carbs_per_100g=0.0, fats_per_100g=3.6),
    ], capture=captured)

    result = await nutrition_db_service.lookup_custom_fuzzy("user-abc", ["piept de pui gratar"])
    assert result is not None
    assert result["source"] == "custom"
    assert all(params["p_user_id"] == "user-abc" for params in captured)


async def test_fuzzy_custom_lookup_does_not_populate_the_shared_cache(monkeypatch):
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [
        _rpc_row("Piept de pui la gratar", source="custom", calories_per_100g=165.0,
                 protein_per_100g=31.0, carbs_per_100g=0.0, fats_per_100g=3.6),
    ])

    await nutrition_db_service.lookup_custom_fuzzy("user-abc", ["piept de pui la gratar"])
    assert nutrition_db_service._cache == {}, "a user's own food must never enter the shared cache"


async def test_fuzzy_custom_lookup_ignores_non_custom_rows(monkeypatch):
    """The RPC returns corpus rows alongside custom ones. This function is
    only about the user's own foods — a corpus row leaking out of it would
    bypass the trust ordering in _resolve_ingredient and be treated as a
    label the user read themselves."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [
        _rpc_row("Chicken, broilers or fryers, breast, meat only, cooked, roasted", source="usda"),
    ])

    assert await nutrition_db_service.lookup_custom_fuzzy("user-abc", ["chicken breast"]) is None


async def test_fuzzy_custom_lookup_still_requires_a_real_name_match(monkeypatch):
    """Highest trust tier is about whose number it is, not about whether the
    name matches. An unrelated saved food must not be handed back just because
    it was the only custom row the RPC returned."""
    _reset(monkeypatch)
    _stub_embedding(monkeypatch)
    _stub_rpc(monkeypatch, [
        _rpc_row("Ciocolata neagra", source="custom", calories_per_100g=550.0,
                 protein_per_100g=7.0, carbs_per_100g=45.0, fats_per_100g=35.0),
    ])

    assert await nutrition_db_service.lookup_custom_fuzzy("user-abc", ["piept de pui"]) is None


async def test_fuzzy_custom_lookup_noops_without_the_migration(monkeypatch):
    _reset(monkeypatch, nutrition_db_local_corpus=False)
    monkeypatch.setattr(nutrition_db_service, "_search_local", _fail_if_called)

    assert await nutrition_db_service.lookup_custom_fuzzy("user-abc", ["anything"]) is None


async def test_fuzzy_custom_lookup_noops_without_a_user(monkeypatch):
    _reset(monkeypatch)
    monkeypatch.setattr(nutrition_db_service, "_search_local", _fail_if_called)

    assert await nutrition_db_service.lookup_custom_fuzzy("", ["anything"]) is None
