"""Diagnostic F7/H1 (plausibility on the AI path) and F8/H3 (personal foods).

Both changes exist to stop the pipeline handing the user a number nobody can
defend: F7 because the model's own recall was the one source no plausibility
gate ever checked, F8 because the one genuinely authoritative source — a
person reading a label — was being captured and then thrown away.
"""

import asyncio

import pytest

from services import custom_food_service, gemini_service
from services.gemini_service import ImplausibleEstimateError
from services.nutrition_db_service import implausibility_reason


# ---------------------------------------------------------------------------
# F7 — the shared validator
# ---------------------------------------------------------------------------
IMPLAUSIBLE = [
    # The reported bug: 150g of fat on a ~300g omelette. Passes Atwater, sits
    # under the calorie-density ceiling, is not a seed/nut/dairy claim — so
    # every pre-existing gate accepted it in silence.
    ("omelette", dict(calories_per_100g=498, protein_per_100g=12, carbs_per_100g=0, fats_per_100g=50),
     "macro_density_out_of_category"),
    # A staple misread as its supplement namesake (the Vitabolic case).
    ("rice powder", dict(calories_per_100g=360, protein_per_100g=80, carbs_per_100g=10, fats_per_100g=1),
     "macro_density_out_of_category"),
    # A Romanian tripe soup is not 60% fat.
    ("ciorba de burta", dict(calories_per_100g=600, protein_per_100g=5, carbs_per_100g=3, fats_per_100g=60),
     "macro_density_out_of_category"),
    # Pre-existing category gates, now reachable from the AI path too.
    ("grilled chicken breast", dict(calories_per_100g=165, protein_per_100g=31, carbs_per_100g=12, fats_per_100g=4),
     "carbs_on_zero_carb_protein"),
    ("ground hemp seeds", dict(calories_per_100g=300, protein_per_100g=33, carbs_per_100g=40, fats_per_100g=10),
     "low_fat_seed_or_nut"),
    ("light cheese", dict(calories_per_100g=280, protein_per_100g=18, carbs_per_100g=2, fats_per_100g=23),
     "high_fat_light_dairy_claim"),
    ("mix de legume", dict(calories_per_100g=423, protein_per_100g=6.6, carbs_per_100g=14, fats_per_100g=0.6),
     "energy_density_vs_atwater"),
    ("whey protein", dict(calories_per_100g=0, protein_per_100g=0, carbs_per_100g=0, fats_per_100g=0),
     "placeholder_zero"),
]

PLAUSIBLE = [
    # Real reference values that must NOT be rejected — a false rejection
    # costs the user an unpriced ingredient, so the envelope has to be
    # generous where the food genuinely is extreme.
    ("omelette", dict(calories_per_100g=190, protein_per_100g=13, carbs_per_100g=3, fats_per_100g=14)),
    ("olive oil", dict(calories_per_100g=900, protein_per_100g=0, carbs_per_100g=0, fats_per_100g=100)),
    ("butter", dict(calories_per_100g=717, protein_per_100g=0.9, carbs_per_100g=0.1, fats_per_100g=81)),
    ("almonds", dict(calories_per_100g=579, protein_per_100g=21, carbs_per_100g=22, fats_per_100g=50)),
    ("peanut butter", dict(calories_per_100g=588, protein_per_100g=25, carbs_per_100g=20, fats_per_100g=50)),
    ("pork belly", dict(calories_per_100g=518, protein_per_100g=9, carbs_per_100g=0, fats_per_100g=53)),
    ("bacon", dict(calories_per_100g=541, protein_per_100g=37, carbs_per_100g=1.4, fats_per_100g=42)),
    ("whey protein isolate", dict(calories_per_100g=380, protein_per_100g=85, carbs_per_100g=3, fats_per_100g=2)),
    ("parmesan", dict(calories_per_100g=392, protein_per_100g=36, carbs_per_100g=3.2, fats_per_100g=26)),
    ("sugar", dict(calories_per_100g=400, protein_per_100g=0, carbs_per_100g=100, fats_per_100g=0)),
    ("rice flour", dict(calories_per_100g=366, protein_per_100g=6, carbs_per_100g=80, fats_per_100g=1.4)),
    ("dried apricots", dict(calories_per_100g=241, protein_per_100g=3.4, carbs_per_100g=63, fats_per_100g=0.5)),
    # Alcohol legitimately exceeds its own Atwater sum — the energy-density
    # gate must keep its existing exemption.
    ("beer", dict(calories_per_100g=43, protein_per_100g=0.5, carbs_per_100g=3.6, fats_per_100g=0)),
    ("cooked white rice", dict(calories_per_100g=130, protein_per_100g=2.7, carbs_per_100g=28, fats_per_100g=0.3)),
]


@pytest.mark.parametrize("food,macros,expected", IMPLAUSIBLE, ids=[c[0] for c in IMPLAUSIBLE])
def test_validator_rejects_implausible_macros(food, macros, expected):
    assert implausibility_reason(food, macros) == expected


@pytest.mark.parametrize("food,macros", PLAUSIBLE, ids=[c[0] for c in PLAUSIBLE])
def test_validator_accepts_real_reference_values(food, macros):
    assert implausibility_reason(food, macros) is None


# ---------------------------------------------------------------------------
# F7 — retry once, then refuse
# ---------------------------------------------------------------------------
_BAD = dict(
    food_name="Omleta", calories_per_100g=498, protein_per_100g=12,
    carbs_per_100g=0, fats_per_100g=50, fiber_per_100g=0, sugar_per_100g=0, sodium_per_100g=0,
)
_GOOD = dict(
    food_name="Omleta", calories_per_100g=190, protein_per_100g=13,
    carbs_per_100g=3, fats_per_100g=14, fiber_per_100g=0, sugar_per_100g=0, sodium_per_100g=0,
)


@pytest.mark.asyncio
async def test_implausible_recall_is_retried_once_and_recovers(monkeypatch):
    calls = []

    async def fake(food_name, *, premium=False, correction_hint=None, temperature=0.1):
        calls.append((correction_hint, temperature))
        return dict(_BAD) if len(calls) == 1 else dict(_GOOD)

    monkeypatch.setattr(gemini_service, "_ai_recall_per_100g_once", fake)

    result = await gemini_service._ai_recall_per_100g("omelette")
    assert result["fats_per_100g"] == 14
    assert len(calls) == 2, "an implausible first answer must be retried exactly once"
    # The retry must tell the model WHAT was wrong and sample differently —
    # re-asking the identical question at temperature 0.1 mostly just
    # re-derives the same rejected number.
    assert calls[0] == (None, 0.1)
    assert calls[1][0] == "macro_density_out_of_category"
    assert calls[1][1] > 0.1


@pytest.mark.asyncio
async def test_persistently_implausible_recall_raises_rather_than_returning_the_number(monkeypatch):
    async def always_bad(food_name, *, premium=False, correction_hint=None, temperature=0.1):
        return dict(_BAD)

    monkeypatch.setattr(gemini_service, "_ai_recall_per_100g_once", always_bad)

    with pytest.raises(ImplausibleEstimateError) as excinfo:
        await gemini_service._ai_recall_per_100g("omelette")
    # The reason travels with the exception so the failure is legible in logs
    # instead of being one more silent degradation.
    assert excinfo.value.reason == "macro_density_out_of_category"


@pytest.mark.asyncio
async def test_plausible_recall_is_not_retried(monkeypatch):
    calls = []

    async def fake(food_name, *, premium=False, correction_hint=None, temperature=0.1):
        calls.append(correction_hint)
        return dict(_GOOD)

    monkeypatch.setattr(gemini_service, "_ai_recall_per_100g_once", fake)
    await gemini_service._ai_recall_per_100g("omelette")
    assert calls == [None], "a good answer must cost exactly one provider call"


@pytest.mark.asyncio
async def test_unpriceable_ingredient_degrades_instead_of_being_priced_wrong(monkeypatch):
    """The whole point of F7: when the only number we can produce is one we
    can prove is wrong, the ingredient comes back UNPRICED. It must not be
    dropped (the total would silently under-count) and it must not be priced
    from the rejected figure."""

    async def refuse(item, custom_foods=None, user_id=None):
        raise ImplausibleEstimateError("Omleta", "macro_density_out_of_category")

    monkeypatch.setattr(gemini_service, "_resolve_ingredient", refuse)

    data = await gemini_service._resolve_and_price_ingredients(
        {
            "food_name": "Omleta",
            "ingredients": [
                {"food_name": "Omleta", "search_name": "omelette", "weight_g": 300, "is_composite": True}
            ],
        }
    )
    assert len(data["ingredients"]) == 1
    item = data["ingredients"][0]
    assert item["food_name"] == "Omleta"
    assert item["weight_g"] == 300.0  # identification survives
    assert item["calories"] == 0
    assert item["macro_source"] is None


# ---------------------------------------------------------------------------
# F8 — personal foods
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Orez pudră Vitabolic", "orez pudra vitabolic"),
        ("orez  pudra  vitabolic!", "orez pudra vitabolic"),
        ("OREZ PUDRA VITABOLIC", "orez pudra vitabolic"),
        ("Brânză Făgăraș light", "branza fagaras light"),
        ("", ""),
    ],
)
def test_normalize_name_collapses_the_ways_one_food_gets_typed(raw, expected):
    # Postgres stores whatever this produces and never recomputes it, so a
    # change here silently orphans every saved row.
    assert custom_food_service.normalize_name(raw) == expected


@pytest.mark.asyncio
async def test_save_from_portion_divides_a_portion_down_to_per_100g(monkeypatch):
    """One correction on a 38g scoop has to price every future portion."""
    saved = {}

    class _FakeSupabase:
        def table(self, name):
            assert name == "custom_foods"

            class _T:
                def upsert(self_inner, row, on_conflict=None):
                    saved.update(row)
                    saved["_on_conflict"] = on_conflict

                    class _E:
                        def execute(self_x):
                            return None

                    return _E()

            return _T()

    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: _FakeSupabase())

    ok = await custom_food_service.save_from_portion(
        "user-1", "Orez pudra Vitabolic", 38.0,
        {
            "calories_per_100g": 137, "protein_per_100g": 2.7, "carbs_per_100g": 28.9,
            "fats_per_100g": 0.4, "fiber_per_100g": 0.4, "sugar_per_100g": 0.0, "sodium_per_100g": 1.9,
        },
    )
    assert ok is True
    assert saved["normalized_name"] == "orez pudra vitabolic"
    assert saved["display_name"] == "Orez pudra Vitabolic"
    assert saved["calories_per_100g"] == pytest.approx(360.5, abs=0.5)
    assert saved["carbs_per_100g"] == pytest.approx(76.1, abs=0.5)
    # Must target the unique index, or a re-correction accumulates duplicate
    # rows that race each other on read.
    assert saved["_on_conflict"] == "user_id,normalized_name"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "weight,totals,why",
    [
        (2.0, {"calories_per_100g": 5, "protein_per_100g": 1, "carbs_per_100g": 1, "fats_per_100g": 0},
         "a 2g portion multiplies the user's own rounding by 50"),
        (100.0, {"calories_per_100g": 200, "protein_per_100g": 10},
         "a partial correction has no complete macro set to store"),
        (10.0, {"calories_per_100g": 900, "protein_per_100g": 1, "carbs_per_100g": 1, "fats_per_100g": 1},
         "9000 kcal/100g is outside the schema's own bounds"),
    ],
)
async def test_save_from_portion_declines_what_should_not_become_a_reference_value(weight, totals, why):
    assert await custom_food_service.save_from_portion("user-1", "Something", weight, totals) is False, why


@pytest.mark.asyncio
async def test_missing_table_degrades_to_no_custom_food_rather_than_raising(monkeypatch):
    """An unmigrated project must behave exactly as it did before this
    feature landed, not 500 on every scan."""
    from postgrest.exceptions import APIError

    class _FakeSupabase:
        def table(self, name):
            raise APIError({"code": "PGRST205", "message": "Could not find the table 'public.custom_foods'"})

    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: _FakeSupabase())
    assert await custom_food_service.get("user-1", "anything") is None
    assert await custom_food_service.save_from_portion(
        "user-1", "anything", 100.0,
        {"calories_per_100g": 100, "protein_per_100g": 1, "carbs_per_100g": 1, "fats_per_100g": 1},
    ) is False


@pytest.mark.asyncio
async def test_custom_food_outranks_usda_in_the_pricing_trust_order(monkeypatch):
    """The user read the label. Everything below that line is a guess."""
    prefetched = {
        "orez pudra vitabolic": {
            "food_name": "Orez pudra Vitabolic", "source": "user_custom",
            "calories_per_100g": 360, "protein_per_100g": 7, "carbs_per_100g": 76,
            "fats_per_100g": 1, "fiber_per_100g": 1, "sugar_per_100g": 0, "sodium_per_100g": 2,
        }
    }

    async def must_not_be_called(*args, **kwargs):
        raise AssertionError("public database consulted despite a custom food existing")

    monkeypatch.setattr(gemini_service.nutrition_db_service, "lookup_best", must_not_be_called)

    priced = await gemini_service._resolve_ingredient(
        {"food_name": "Orez pudra Vitabolic", "search_name": "rice flour", "weight_g": 38, "is_composite": False},
        prefetched,
    )
    assert priced["macro_source"] == "user_custom"
    # 76g carbs per 100g scaled to the logged 38g — the user's label figure,
    # not the ~85g a generic rice-flour estimate produces (Diagnostic H3).
    assert priced["carbs"] == pytest.approx(28.9, abs=0.2)


@pytest.mark.asyncio
async def test_custom_food_matches_on_search_name_too(monkeypatch):
    """Both names are checked against the prefetched map, so a food saved
    under its English generic name still matches a Romanian display name."""
    prefetched = {"rice flour": {
        "food_name": "Rice flour", "source": "user_custom",
        "calories_per_100g": 360, "protein_per_100g": 7, "carbs_per_100g": 76,
        "fats_per_100g": 1, "fiber_per_100g": 0, "sugar_per_100g": 0, "sodium_per_100g": 0,
    }}

    async def must_not_be_called(*args, **kwargs):
        raise AssertionError("public database consulted despite a custom food existing")

    monkeypatch.setattr(gemini_service.nutrition_db_service, "lookup_best", must_not_be_called)

    priced = await gemini_service._resolve_ingredient(
        {"food_name": "Faina de orez", "search_name": "Rice Flour", "weight_g": 100, "is_composite": False},
        prefetched,
    )
    assert priced["macro_source"] == "user_custom"


@pytest.mark.asyncio
async def test_pricing_never_queries_custom_foods_per_ingredient(monkeypatch):
    """Phase 3.1's whole point: after the single prefetch, per-ingredient
    custom lookups are pure dict hits. A regression that reintroduces a
    query inside _resolve_ingredient is an N+1 that only shows up under a
    multi-ingredient meal, which is exactly when it hurts most."""
    async def must_not_be_called(*args, **kwargs):
        raise AssertionError("per-ingredient custom_foods query — the N+1 is back")

    monkeypatch.setattr(gemini_service.custom_food_service, "get", must_not_be_called)

    captured = {}

    async def fake_get_many(user_id, names):
        captured["user_id"] = user_id
        captured["names"] = list(names)
        return {}

    async def fake_lookup(names):
        return {
            "food_name": "x", "source": "usda", "calories_per_100g": 100,
            "protein_per_100g": 1, "carbs_per_100g": 1, "fats_per_100g": 1,
            "fiber_per_100g": 0, "sugar_per_100g": 0, "sodium_per_100g": 0,
        }

    monkeypatch.setattr(gemini_service.custom_food_service, "get_many", fake_get_many)
    monkeypatch.setattr(gemini_service.nutrition_db_service, "lookup_best", fake_lookup)

    await gemini_service._resolve_and_price_ingredients(
        {
            "food_name": "Plate",
            "ingredients": [
                {"food_name": f"Food {i}", "search_name": f"food {i}", "weight_g": 50, "is_composite": False}
                for i in range(6)
            ],
        },
        user_id="user-1",
    )
    # Exactly one prefetch, carrying both names of all six ingredients —
    # not 6 calls, and not 12.
    assert captured["user_id"] == "user-1"
    assert len(captured["names"]) == 12


@pytest.mark.asyncio
async def test_prefetch_is_skipped_entirely_without_a_user(monkeypatch):
    """Background/unauthenticated callers pass no user_id — they must not
    query the personal table at all, rather than querying it with None."""
    async def must_not_be_called(*args, **kwargs):
        raise AssertionError("custom foods queried without a user")

    monkeypatch.setattr(gemini_service.custom_food_service, "get_many", must_not_be_called)
    monkeypatch.setattr(gemini_service.custom_food_service, "get", must_not_be_called)

    async def fake_lookup(names):
        return None

    async def fake_ai(name, weight, *, skip_database=False, user_id=None, custom_foods=None):
        return {
            "food_name": name, "weight_g": weight, "calories": 100, "protein": 1.0,
            "carbs": 1.0, "fats": 1.0, "fiber": 0.0, "sugar": 0.0, "sodium": 0.0,
            "macro_source": "ai_estimate",
        }

    monkeypatch.setattr(gemini_service.nutrition_db_service, "lookup_best", fake_lookup)
    monkeypatch.setattr(gemini_service, "estimate_macros_for_food_name", fake_ai)

    data = await gemini_service._resolve_and_price_ingredients(
        {"food_name": "Rice", "ingredients": [
            {"food_name": "Rice", "search_name": "rice", "weight_g": 100, "is_composite": False}
        ]}
    )
    assert data["ingredients"][0]["macro_source"] == "ai_estimate"


@pytest.mark.asyncio
async def test_custom_food_is_never_written_into_the_shared_name_cache(monkeypatch):
    """food_cache_service is keyed by food name ALONE and shared across every
    user. Writing a personal figure into it would serve one user's label to
    everyone else logging the same name — so the custom-food branch must
    return before that cache is touched at all."""
    from services import food_cache_service

    async def fake_custom(user_id, name):
        return {
            "food_name": "My protein", "source": "user_custom",
            "calories_per_100g": 400, "protein_per_100g": 80, "carbs_per_100g": 5,
            "fats_per_100g": 5, "fiber_per_100g": 0, "sugar_per_100g": 0, "sodium_per_100g": 0,
        }

    def must_not_be_called(*args, **kwargs):
        raise AssertionError("a per-user figure was written into the shared cache")

    monkeypatch.setattr(gemini_service.custom_food_service, "get", fake_custom)
    monkeypatch.setattr(food_cache_service, "put", must_not_be_called)

    result = await gemini_service.estimate_macros_for_food_name("My protein", 50, user_id="user-1")
    assert result["macro_source"] == "user_custom"
    assert result["protein"] == pytest.approx(40.0, abs=0.1)




# ---------------------------------------------------------------------------
# The response contract the UI depends on
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "source", ["user_custom", "usda", "openfoodfacts", "ai_estimate", "user_stated", None]
)
def test_every_macro_source_the_pipeline_can_emit_validates(source):
    """_resolve_ingredient can stamp any of these onto an ingredient, and
    ScanResult validates each one against IngredientItem's Literal. A value
    the pipeline produces but the model rejects turns a good scan into a 500
    — and "user_custom" was exactly that for one release: it only fires for
    users who have saved a correction, i.e. the most engaged ones."""
    from models import IngredientItem

    item = IngredientItem(
        food_name="X", weight_g=100, calories=100, protein=1, carbs=1, fats=1, macro_source=source
    )
    assert item.macro_source == source


def test_correction_response_carries_the_custom_food_signal():
    """The toast the user sees is driven by this field, not by the frontend
    re-deriving save_from_portion's rules."""
    from datetime import datetime, timezone

    from models import DailyLogResponse

    row = DailyLogResponse(
        id="1", food_name="X", weight_g=100, calories=100, protein=1, carbs=1, fats=1,
        source="manual", log_date="2026-09-09", logged_at=datetime.now(timezone.utc),
    )
    assert row.custom_food_saved is False, "must default off — most edits save nothing"
    assert "custom_food_saved" in DailyLogResponse.model_fields


# ---------------------------------------------------------------------------
# Phase 3.1 — the bulk primitive itself
# ---------------------------------------------------------------------------
class _RecordingSupabase:
    """Captures the .in_() key lists a lookup actually issues, so a test can
    assert on query COUNT and SHAPE, not just the returned value."""

    def __init__(self, rows=None):
        self.calls = []
        self._rows = rows or []

    def table(self, name):
        outer = self

        class _T:
            def select(self_inner, *_a):
                return self_inner

            def eq(self_inner, field, value):
                outer.calls.append({"eq": (field, value)})
                return self_inner

            def in_(self_inner, field, keys):
                outer.calls[-1]["in_"] = (field, list(keys))
                return self_inner

            def execute(self_inner):
                class _R:
                    data = outer._rows

                return _R()

        return _T()


def _row(name, **over):
    base = dict(
        normalized_name=name, display_name=name.title(),
        calories_per_100g=360, protein_per_100g=7, carbs_per_100g=76,
        fats_per_100g=1, fiber_per_100g=1, sugar_per_100g=0, sodium_per_100g=2,
    )
    base.update(over)
    return base


@pytest.mark.asyncio
async def test_get_many_issues_one_query_and_dedupes_normalized_keys(monkeypatch):
    fake = _RecordingSupabase([_row("orez pudra vitabolic")])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    found = await custom_food_service.get_many(
        "user-1",
        # 6 names, but only 3 distinct keys after normalization: casing,
        # diacritics and punctuation all collapse.
        ["Orez pudră Vitabolic", "orez pudra vitabolic!", "OREZ  PUDRA VITABOLIC",
         "Rice flour", "rice flour", "Chicken breast"],
    )

    assert len(fake.calls) == 1, "must be a single round trip, not one per name"
    field, keys = fake.calls[0]["in_"]
    assert field == "normalized_name"
    assert keys == ["chicken breast", "orez pudra vitabolic", "rice flour"]
    # Always scoped to the caller's own user — the eq() precedes the in_().
    assert fake.calls[0]["eq"] == ("user_id", "user-1")
    assert found["orez pudra vitabolic"]["source"] == "user_custom"
    assert found["orez pudra vitabolic"]["carbs_per_100g"] == 76


@pytest.mark.asyncio
async def test_get_many_skips_the_query_entirely_when_nothing_normalizes(monkeypatch):
    """Emoji-only and whitespace names produce no key; issuing an in_() with
    an empty list would be a pointless round trip (and PostgREST treats it
    as a match-nothing filter anyway)."""
    fake = _RecordingSupabase()
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    assert await custom_food_service.get_many("user-1", ["🍕", "   ", "", "!!!"]) == {}
    assert await custom_food_service.get_many("user-1", []) == {}
    assert fake.calls == []


@pytest.mark.asyncio
async def test_get_many_chunks_a_pathologically_large_key_set(monkeypatch):
    """The cap exists so a future max_ingredients raise can't build a URL
    long enough for a gateway to reject. Chunks run concurrently, so this
    costs no extra wall time."""
    fake = _RecordingSupabase()
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    await custom_food_service.get_many("user-1", [f"food number {i}" for i in range(120)])

    assert len(fake.calls) == 3  # 120 keys / 50 per query
    assert sum(len(c["in_"][1]) for c in fake.calls) == 120


@pytest.mark.asyncio
async def test_get_many_degrades_to_empty_on_a_missing_table(monkeypatch):
    from postgrest.exceptions import APIError

    class _Broken:
        def table(self, name):
            raise APIError({"code": "PGRST205", "message": "Could not find the table"})

    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: _Broken())
    assert await custom_food_service.get_many("user-1", ["rice"]) == {}


def test_lookup_in_normalizes_so_callers_cannot_forget_to(monkeypatch):
    prefetched = {"orez pudra vitabolic": {"source": "user_custom"}}
    assert custom_food_service.lookup_in(prefetched, "Orez pudră Vitabolic!") is not None
    assert custom_food_service.lookup_in(prefetched, "something else") is None
    assert custom_food_service.lookup_in(None, "anything") is None
    assert custom_food_service.lookup_in({}, "anything") is None


# ---------------------------------------------------------------------------
# Phase 3.2 — the management routes' service layer
# ---------------------------------------------------------------------------
class _CrudSupabase:
    """Records the filters a write actually applied, so a test can prove
    ownership scoping rather than trusting it."""

    def __init__(self, returned=None, raises=None):
        self.filters = []
        self.payload = None
        self._returned = returned if returned is not None else []
        self._raises = raises

    def table(self, name):
        outer = self

        class _T:
            def select(self_inner, *_a):
                return self_inner

            def update(self_inner, row):
                outer.payload = row
                return self_inner

            def delete(self_inner):
                return self_inner

            def order(self_inner, *_a, **_k):
                return self_inner

            def eq(self_inner, field, value):
                outer.filters.append((field, value))
                return self_inner

            def execute(self_inner):
                if outer._raises:
                    raise outer._raises

                class _R:
                    data = outer._returned

                return _R()

        return _T()


@pytest.mark.asyncio
async def test_update_one_scopes_the_write_to_the_owner(monkeypatch):
    """A foreign id must match no rows rather than editing someone else's
    saved food. The .eq("user_id") is the only thing enforcing that on a
    service-role client, which bypasses RLS."""
    fake = _CrudSupabase(returned=[_row("orez pudra")])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    await custom_food_service.update_one("user-1", "food-9", {"calories_per_100g": 76})

    assert ("id", "food-9") in fake.filters
    assert ("user_id", "user-1") in fake.filters, "write was not scoped to the owner"
    assert fake.payload["calories_per_100g"] == 76


@pytest.mark.asyncio
async def test_update_one_rejects_a_value_outside_its_per_100g_ceiling(monkeypatch):
    """The typo this whole screen exists to fix: 760 where 76 was meant. A
    saved food outranks USDA, so a bad value here is worse than no entry."""
    fake = _CrudSupabase(returned=[_row("x")])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    with pytest.raises(ValueError):
        await custom_food_service.update_one("user-1", "f1", {"carbs_per_100g": 760})
    with pytest.raises(ValueError):
        await custom_food_service.update_one("user-1", "f1", {"calories_per_100g": 5000})
    assert fake.payload is None, "nothing may reach the database once a value is refused"


@pytest.mark.asyncio
async def test_renaming_moves_the_lookup_key_with_the_label(monkeypatch):
    """display_name is what the user sees; normalized_name is the identity
    the pricing pipeline matches on. If a rename moved only the label, the
    entry would still price the OLD name and look correct in the list —
    a silent divergence with no visible symptom."""
    fake = _CrudSupabase(returned=[_row("branza fagaras light")])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    await custom_food_service.update_one("user-1", "f1", {"display_name": "Brânză Făgăraș light"})

    assert fake.payload["display_name"] == "Brânză Făgăraș light"
    assert fake.payload["normalized_name"] == "branza fagaras light"


@pytest.mark.asyncio
async def test_update_one_refuses_an_empty_or_unkeyable_payload(monkeypatch):
    fake = _CrudSupabase(returned=[])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    with pytest.raises(ValueError):
        await custom_food_service.update_one("user-1", "f1", {})
    with pytest.raises(ValueError):
        await custom_food_service.update_one("user-1", "f1", {"display_name": "🍕"})


@pytest.mark.asyncio
async def test_duplicate_rename_surfaces_as_a_user_error_not_a_500(monkeypatch):
    from postgrest.exceptions import APIError

    fake = _CrudSupabase(raises=APIError({"code": "23505", "message": "duplicate key"}))
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: fake)

    with pytest.raises(ValueError, match="already have"):
        await custom_food_service.update_one("user-1", "f1", {"display_name": "Rice"})


@pytest.mark.asyncio
async def test_delete_one_scopes_to_the_owner_and_reports_a_miss(monkeypatch):
    hit = _CrudSupabase(returned=[_row("x")])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: hit)
    assert await custom_food_service.delete_one("user-1", "f1") is True
    assert ("user_id", "user-1") in hit.filters

    # No row deleted -> False, which the router turns into a 404 rather than
    # a silent success that would tell the user something was removed.
    miss = _CrudSupabase(returned=[])
    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: miss)
    assert await custom_food_service.delete_one("user-1", "someone-elses-id") is False


@pytest.mark.asyncio
async def test_list_all_degrades_to_empty_on_an_unmigrated_project(monkeypatch):
    from postgrest.exceptions import APIError

    class _Broken:
        def table(self, name):
            raise APIError({"code": "PGRST205", "message": "Could not find the table"})

    monkeypatch.setattr(custom_food_service, "get_supabase", lambda: _Broken())
    assert await custom_food_service.list_all("user-1") == []


# ---------------------------------------------------------------------------
# Composite dishes vs the category gates (regression from the pre-release QA)
# ---------------------------------------------------------------------------
COMPOSITE_DISHES = [
    # Every one of these was UNPRICEABLE — the category gates read a meat or
    # nut word out of a whole dish name and rejected correct macros twice,
    # which raised ImplausibleEstimateError and logged the meal at 0 kcal.
    ("potato and pork stew", dict(calories_per_100g=110, protein_per_100g=5, carbs_per_100g=10, fats_per_100g=5)),
    ("chicken soup with noodles", dict(calories_per_100g=60, protein_per_100g=4, carbs_per_100g=6, fats_per_100g=2)),
    ("pilaf with chicken", dict(calories_per_100g=150, protein_per_100g=9, carbs_per_100g=18, fats_per_100g=4)),
    ("sarmale pork cabbage rolls", dict(calories_per_100g=140, protein_per_100g=7, carbs_per_100g=9, fats_per_100g=8)),
    ("beef and vegetable stew", dict(calories_per_100g=120, protein_per_100g=8, carbs_per_100g=8, fats_per_100g=6)),
    ("tuna pasta salad", dict(calories_per_100g=170, protein_per_100g=9, carbs_per_100g=20, fats_per_100g=6)),
    ("egg fried rice", dict(calories_per_100g=165, protein_per_100g=6, carbs_per_100g=22, fats_per_100g=5)),
    ("chicken with peanut sauce", dict(calories_per_100g=180, protein_per_100g=15, carbs_per_100g=6, fats_per_100g=11)),
]


@pytest.mark.parametrize("dish,macros", COMPOSITE_DISHES, ids=[c[0] for c in COMPOSITE_DISHES])
def test_composite_dishes_are_not_rejected_by_single_food_category_gates(dish, macros):
    assert implausibility_reason(dish, macros, is_composite=True) is None


@pytest.mark.parametrize("dish,macros", COMPOSITE_DISHES, ids=[c[0] for c in COMPOSITE_DISHES])
def test_the_same_dishes_would_still_trip_the_gates_if_judged_as_one_food(dish, macros):
    """Proves the flag is what changed the outcome, not a weakened gate —
    these all still fail when the name is claimed to identify a single food."""
    if "peanut" in dish or any(w in dish for w in ("pork", "chicken", "beef", "tuna", "egg", "salmon")):
        assert implausibility_reason(dish, macros, is_composite=False) is not None


def test_universal_guards_still_apply_to_composites():
    """The category gates are skipped for a composite; the physical ones are
    not. An omelette recalled at 50g fat/100g — the failure this validator
    was built for — must still be refused even though it is composite."""
    assert implausibility_reason(
        "omelette", dict(calories_per_100g=498, protein_per_100g=12, carbs_per_100g=0, fats_per_100g=50),
        is_composite=True,
    ) == "macro_density_out_of_category"
    assert implausibility_reason(
        "stew", dict(calories_per_100g=0, protein_per_100g=0, carbs_per_100g=0, fats_per_100g=0),
        is_composite=True,
    ) == "placeholder_zero"
    assert implausibility_reason(
        "mix de legume", dict(calories_per_100g=423, protein_per_100g=6.6, carbs_per_100g=14, fats_per_100g=0.6),
        is_composite=True,
    ) == "energy_density_vs_atwater"


@pytest.mark.asyncio
async def test_composite_recall_passes_the_flag_through(monkeypatch):
    """The flag has to reach the validator from estimate_macros_for_food_name's
    skip_database, or the fix never fires in the real pipeline."""
    seen = {}

    async def fake_once(food_name, *, premium=False, correction_hint=None, temperature=0.1):
        return dict(
            food_name=food_name, calories_per_100g=110, protein_per_100g=5,
            carbs_per_100g=10, fats_per_100g=5, fiber_per_100g=0, sugar_per_100g=0, sodium_per_100g=0,
        )

    real = implausibility_reason

    def spy(name, macros, *, is_composite=False):
        seen["is_composite"] = is_composite
        return real(name, macros, is_composite=is_composite)

    monkeypatch.setattr(gemini_service, "_ai_recall_per_100g_once", fake_once)
    monkeypatch.setattr(gemini_service.nutrition_db_service, "implausibility_reason", spy)

    out = await gemini_service._ai_recall_per_100g("potato and pork stew", is_composite=True)
    assert seen["is_composite"] is True
    assert out["calories_per_100g"] == 110
