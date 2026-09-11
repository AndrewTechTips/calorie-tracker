"""Offline, deterministic retrieval eval for nutrition_db_service.

WHY THIS EXISTS, and why it is NOT test_golden_macros.py
--------------------------------------------------------
test_golden_macros.py measures the whole pipeline end to end against live
providers: real extraction wording, real USDA/Open Food Facts search, real AI
recall. That makes it the only thing that can catch an extraction-side bug,
and also makes it slow, quota-consuming, non-deterministic and opt-in behind
RUN_GOLDEN_EVAL=1. You cannot run it on every commit, and two runs of it can
disagree with each other for reasons that have nothing to do with the code.

This file measures exactly ONE stage of that pipeline — given a set of
candidates from the two databases, does the selection logic
(_score -> CONFIDENCE_THRESHOLD -> implausibility_reason -> _rank) pick the
right one? — and it does so with **zero network calls and zero AI quota**, by
replaying candidate sets that were harvested once from the live APIs and
frozen into tests/data/retrieval_candidates.json.

That split is the point. Retrieval is where the accuracy actually leaks (a
missed match silently becomes an AI guess, which is invisible at the UI layer
— see nutrition_db_service.py's own _PAGE_SIZE comment for a live instance of
exactly this), and retrieval logic is 100% deterministic. Freezing the inputs
turns "did the matcher get better?" from a judgement call into a number that
runs in milliseconds inside the ordinary `pytest` invocation.

WHAT THE FIXTURE IS
-------------------
tests/data/retrieval_candidates.json holds the real, unedited output of
_search_usda() + _search_off() for 50 queries — 2,010 candidates, harvested
2026-09-10 with a real (non-DEMO) USDA key. Names, sources and per-100g
nutrients are exactly what the live services returned. Floats are rounded to
3dp purely to keep the file small; nothing in the selection path is sensitive
at that precision.

Refresh it by re-running the harvest (see _HARVEST_RECIPE below) when you
want to re-measure against today's corpora. Do NOT hand-edit it to make a
case pass — the fixture is evidence, not configuration.

THE THREE METRICS
-----------------
1. GROUNDING RATE — did any candidate survive at all? A query that grounds
   nothing falls through to _ai_recall_per_100g, i.e. to the model's memory.
2. ACCURACY — for a query with a defensible reference value, is the WINNER's
   energy density within tolerance of it? This is the metric that matters
   most and the one a pure recall number hides: a query can ground
   confidently and still be badly wrong (see the canned-tuna case below).
3. SAFETY — a small set of (query, candidate) pairs that must NEVER be
   selected, whatever else changes. These encode failure modes that were
   found the hard way and must not silently reopen.

Baselines below are FLOORS recorded from the current implementation, not
aspirations. They may only ever be raised. If a change moves one down, that
is a regression and the assertion is doing its job; if a change moves one up,
raise the floor in the same commit so the gain is locked in.

PHASE 1 NOTE — WHAT THIS FILE DOES AND DOES NOT MEASURE
--------------------------------------------------------
The frozen fixture holds candidates as the REMOTE USDA/Open Food Facts search
APIs returned them, so these numbers track the remote retrieval path. The
local-corpus path (Settings.nutrition_db_local_corpus) retrieves a different
candidate set and is therefore NOT covered here — its wiring is covered by
tests/test_local_corpus_retrieval.py, and its matching quality was measured
separately, offline, against a real 16,434-row corpus (13,319 USDA + 3,115
Open Food Facts Romania) built by scripts/ingest_nutrition_corpus.py:

    remote only (this fixture)      grounding 91%    accuracy 72%
    local corpus only               grounding 83%    accuracy 70%
    local + remote fallback         grounding 100%   accuracy 78%

Local-ONLY regresses, which is why Settings.nutrition_db_remote_fallback
exists and defaults to True: the corpus carries all of USDA but only the
Romania slice of Open Food Facts, so it misses foods (walnuts, dried dates,
rice flour, canned tuna) that OFF's global index does carry. Reproduce by
running the ingest with --dry-run, pickling the rows, and replaying CASES
through the same gates — the numbers above were produced that way, not
estimated.

That measurement is deliberately NOT wired into this file: it would mean
committing ~25 MB of embeddings as a fixture, and the local path's candidate
quality depends on a corpus that is refreshed on its own schedule.

Run the full report (per-case detail, not just pass/fail):

    cd backend && pytest tests/test_retrieval_eval.py -s -q
"""

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from services import nutrition_db_service as ndb

_HARVEST_RECIPE = """
Regenerate tests/data/retrieval_candidates.json (needs a real USDA_API_KEY,
NOT DEMO_KEY, and NUTRITION_DB_GROUNDING_ENABLED=true):

    import asyncio, json, httpx
    from services import nutrition_db_service as n
    async def main():
        out = {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as c:
            for q in QUERIES:                       # the CASES ids below
                u, o = await asyncio.gather(n._search_usda(q, c), n._search_off(q, c))
                out[q] = [[nm, d.get("source"), [d.get(f) for f in FIELDS]] for nm, d in u + o]
                await asyncio.sleep(0.3)            # be polite to both APIs
        json.dump({"_fields": FIELDS, "queries": out}, open(PATH, "w"), ensure_ascii=False)
    asyncio.run(main())
"""

_FIXTURE = Path(__file__).parent / "data" / "retrieval_candidates.json"


def _load_fixture() -> dict[str, list[tuple[str, dict]]]:
    """Rehydrates the compact on-disk shape back into the (name, data) pairs
    _lookup_uncached works with. The compact form (parallel arrays keyed by
    _fields) exists only to keep 2,010 candidates under 160 KB; nothing else
    depends on it."""
    raw = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    fields = raw["_fields"]
    out: dict[str, list[tuple[str, dict]]] = {}
    for query, rows in raw["queries"].items():
        rehydrated = []
        for name, source, values in rows:
            data = {"food_name": name, "source": source}
            for field, value in zip(fields, values):
                # None means "the source was silent on this nutrient" and must
                # stay None, never 0 — see nutrition_db_service.lookup()'s own
                # docstring on why that distinction is load-bearing.
                if value is not None:
                    data[field] = value
            rehydrated.append((name, data))
        out[query] = rehydrated
    return out


CANDIDATES = _load_fixture()


def select(query: str) -> tuple[str, dict] | None:
    """The exact selection _lookup_uncached performs, minus the two HTTP
    calls. Deliberately reimplemented here rather than monkeypatching the
    searches: this keeps the eval readable as a spec of what selection means,
    and a divergence between this and _lookup_uncached is caught by
    test_select_mirrors_lookup_uncached below."""
    eligible = []
    for name, data in CANDIDATES[query]:
        score = ndb._score(query, name)
        if score < ndb.CONFIDENCE_THRESHOLD:
            continue
        if ndb.implausibility_reason(query, data) is not None:
            continue
        if ndb._is_unidentified_supplement_match(query, name, data.get("source")):
            continue
        eligible.append((score, name, data))
    if not eligible:
        return None
    _, name, data = max(eligible, key=lambda item: item[0] + ndb._rank_bonus(item[2]))
    return name, data


# ---------------------------------------------------------------------------
# Reference values are USDA FoodData Central per-100g figures for the generic
# form the query names, EXCEPT the five Romanian-market items, which have no
# USDA equivalent and are sourced from the typical label values for that
# category on the Romanian market (noted per case). `tol_pct` is the accepted
# band around the reference and is set per case rather than globally, because
# the honest uncertainty genuinely differs: "olive oil" is a physical
# constant, "tofu" spans silken to extra-firm at 3x the energy density.
#
# expect: "match"  — must ground, and must land inside tolerance
#         "miss"   — SHOULD fall through to the AI; grounding it would be the
#                    bug (a formulated supplement has no generic entry, and
#                    the extraction prompt deliberately keeps the brand on it)
#         "report" — measured and printed, never asserted: the query is
#                    genuinely ambiguous about preparation state, so there is
#                    no single defensible reference value to hold it to.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# MACRO REFERENCES (added 2026-09-11) — why calories alone was not enough.
#
# This eval scored a match purely on kcal, and that is how it certified the bug
# that prompted this: "walnuts" grounded to an Open Food Facts row at 701
# kcal/100g against a 654 reference — 7% out, comfortably inside tolerance,
# printed as `ok` — while that same row reported 5.4g of carbohydrate against
# USDA's 13.7. A 61% carbohydrate error passed this file silently, stamped with
# a verified macro_source, because nothing here ever looked at a macro.
#
# Energy is the LEAST sensitive thing to get wrong in retrieval. Two entries
# for the same food land within a few percent on kcal while disagreeing wildly
# on how that energy is composed — which is exactly what a macro tracker exists
# to tell the user apart. A user on a protein or carbohydrate target is misled
# by a row this eval called correct.
#
# WHERE THE NUMBERS COME FROM. Every reference below is read out of the frozen
# fixture itself — the USDA row each case's `note` already names, harvested in
# the same pass as the candidate sets. Nothing here is typed from memory or
# from an outside source, and a case gets macro references only where that
# named row is unambiguously present (name similarity and kcal both agreeing).
# The rest carry None and are measured but not asserted, exactly like the
# `report` cases: a reference nobody can point at is not a reference.
#
# TOLERANCE. Wider than the calorie bands, and deliberately so. Carbohydrate in
# particular is not one quantity measured two ways: USDA publishes carbohydrate
# BY DIFFERENCE (fibre included), while EU labelling (Reg. 1169/2011) publishes
# AVAILABLE carbohydrate (fibre excluded), so a correct European row and a
# correct USDA row for the same food legitimately differ by the fibre content.
# A band tight enough to call that an error would fail honest data. 35% catches
# the walnut case (61% out) with room to spare and does not fire on convention
# differences of the size actually observed.
#
# The absolute floor matters as much as the percentage: a percentage band is
# meaningless near zero, where most real macro values for a given food sit
# (chicken breast carbohydrate, olive oil protein). 3g is below anything a user
# would notice on a single ingredient and keeps 0.0-vs-0.6 from reading as an
# infinite error.
# ---------------------------------------------------------------------------
MACRO_TOL_PCT = 35.0
MACRO_TOL_ABS_G = 3.0
MACRO_FIELDS = ("protein", "carbs", "fats")


@dataclass(frozen=True)
class Case:
    query: str
    expect: str
    kcal: float | None = None
    tol_pct: float = 20.0
    note: str = ""
    # Per-100g reference macros, read from the fixture's own copy of the USDA
    # row `note` names. None means "no defensible reference" — measured and
    # printed, never asserted.
    protein: float | None = None
    carbs: float | None = None
    fats: float | None = None


CASES: list[Case] = [
    # --- generic whole foods, English -------------------------------------
    Case("chicken breast", "match", 165, 20, "USDA breast, meat only, cooked, roasted"),
    Case("raw chicken breast", "match", 120, 25, "USDA breast, meat only, raw"),
    Case("cooked white rice", "match", 130, 20, "USDA rice, white, long-grain, enriched, cooked", protein=2.36, carbs=28.7, fats=0.19),
    Case("white rice", "match", 130, 25, "bare staple; prompt rule defaults to the cooked form"),
    Case("cooked pasta", "match", 158, 20, "USDA pasta, cooked, enriched", protein=5.8, carbs=30.6, fats=0.93),
    Case("boiled potato", "match", 87, 25, "USDA potatoes, boiled without skin, without salt", protein=1.71, carbs=20.0, fats=0.1),
    Case("sweet potato", "match", 86, 30, "USDA sweet potato, raw; boiled is ~76"),
    Case("cooked lentils", "match", 116, 20, "USDA lentils, mature seeds, cooked, boiled", protein=9.02, carbs=19.5, fats=0.38),
    Case("cooked quinoa", "match", 120, 20, "USDA quinoa, cooked", protein=4.4, carbs=21.3, fats=1.92),
    Case("broccoli", "match", 34, 25, "USDA broccoli, raw", protein=2.57, carbs=6.27, fats=0.34),
    Case("banana", "match", 89, 20, "USDA bananas, raw", protein=1.09, carbs=22.8, fats=0.33),
    Case("apple", "match", 52, 25, "USDA apples, raw, with skin"),
    Case("avocado", "match", 160, 20, "USDA avocados, raw, all commercial varieties", protein=2.0, carbs=8.53, fats=14.7),
    Case("dried dates", "match", 282, 25, "USDA dates, deglet noor; medjool is ~277", protein=2.45, carbs=75.0, fats=0.39),
    Case("almonds", "match", 579, 15, "USDA nuts, almonds", protein=21.2, carbs=21.6, fats=49.9),
    Case("walnuts", "match", 654, 15, "USDA nuts, walnuts, english", protein=15.2, carbs=13.7, fats=65.2),
    Case("hemp seeds", "match", 553, 15, "USDA seeds, hemp seed, hulled", protein=31.6, carbs=8.67, fats=48.8),
    Case("peanut butter", "match", 588, 15, "USDA peanut butter, smooth style"),
    Case("olive oil", "match", 884, 10, "USDA oil, olive, salad or cooking — a physical constant", protein=0.0, carbs=0.0, fats=100.0),
    Case("butter", "match", 717, 15, "USDA butter, salted", protein=0.85, carbs=0.06, fats=81.1),
    Case("whole milk", "match", 61, 15, "USDA milk, whole, 3.25% milkfat", protein=3.27, carbs=4.63, fats=3.2),
    Case("skimmed milk", "match", 34, 20, "USDA milk, nonfat/skim", protein=3.43, carbs=4.92, fats=0.08),
    Case("greek yogurt", "match", 59, 25, "USDA yogurt, Greek, plain, nonfat", protein=10.3, carbs=3.64, fats=0.37),
    Case("cottage cheese", "match", 84, 25, "USDA cheese, cottage, lowfat 2%", protein=11.0, carbs=4.31, fats=2.3),
    Case("cheddar cheese", "match", 403, 15, "USDA cheese, cheddar", protein=23.3, carbs=2.44, fats=34.0),
    Case("feta cheese", "match", 264, 15, "USDA cheese, feta", protein=14.2, carbs=3.88, fats=21.5),
    Case("egg white", "match", 52, 15, "USDA egg, white, raw, fresh", protein=10.9, carbs=0.73, fats=0.17),
    Case("scrambled eggs", "match", 149, 20, "USDA egg, whole, cooked, scrambled", protein=9.99, carbs=1.61, fats=11.0),
    Case("whole wheat bread", "match", 247, 20, "USDA bread, whole-wheat, commercially prepared", protein=12.4, carbs=42.7, fats=3.5),
    Case("rice flour", "match", 366, 20, "USDA rice flour, white, unenriched", protein=5.95, carbs=80.1, fats=1.42),
    Case("orange juice", "match", 45, 25, "USDA orange juice, raw", protein=0.77, carbs=10.17, fats=0.34),
    Case("dark chocolate", "match", 550, 20, "USDA chocolate, dark, 45-59% cacao", protein=4.88, carbs=61.2, fats=31.3),
    Case("tofu", "match", 76, 45, "USDA tofu, raw, firm — genuinely spans silken (55) to extra-firm"),
    # --- fish: the category the matcher historically lost entirely ---------
    Case("salmon", "match", 206, 25, "USDA fish, salmon, Atlantic, farmed, cooked, dry heat", protein=20.4, carbs=0.0, fats=13.4),
    Case("salmon fillet", "match", 206, 25, "same reference as bare salmon"),
    Case("canned tuna", "match", 116, 30, "USDA tuna, light, canned in water, drained"),
    Case("tuna in water", "match", 116, 30, "same reference as canned tuna"),
    # --- Romanian-language queries ----------------------------------------
    Case("lapte", "match", 62, 20, "Romanian: milk. Typical RO retail 3.5% label"),
    Case("branza de vaci", "match", 98, 30, "Romanian: cow's cheese / soft curd cheese"),
    Case("iaurt grecesc", "match", 85, 40, "Romanian: Greek yogurt; RO market spans 0% to 10% fat"),
    Case("telemea", "match", 260, 30, "Romanian brined white cheese, typical label"),
    Case("cascaval", "match", 330, 25, "Romanian semi-hard cheese, typical label"),
    Case("smantana", "match", 200, 35, "Romanian sour cream; 12% to 25% fat on shelf"),
    Case("paine integrala", "match", 250, 25, "Romanian: wholemeal bread"),
    Case("piept de pui", "match", 165, 30, "Romanian: chicken breast, cooked"),
    Case("ulei de masline", "match", 884, 10, "Romanian: olive oil"),
    # --- must NOT ground ---------------------------------------------------
    Case(
        "whey protein powder", "miss", None, 0,
        "A formulated supplement's macros are its own brand's recipe. "
        "VISION_EXTRACTION_PROMPT deliberately keeps the brand on these so a "
        "generic match CANNOT happen; falling through to the AI is correct.",
    ),
    # --- genuinely ambiguous: measured, not asserted -----------------------
    Case(
        "oats", "report", None, 0,
        "Bare dry-staple noun. 379 kcal dry vs ~71 cooked — a 5x spread with "
        "no cue in the query. _is_missing_cooked_state currently rejects the "
        "dry entries, which is defensible, but there is no single right answer "
        "to assert against.",
    ),
    Case(
        "light cheese", "report", None, 0,
        "'Light' is a relative label claim, not a food. Real products carrying "
        "it span roughly 150-250 kcal/100g.",
    ),
]

_CASES_BY_QUERY = {c.query: c for c in CASES}
assert len(_CASES_BY_QUERY) == len(CASES), "duplicate query in CASES"


# ---------------------------------------------------------------------------
# Pairs that must never be chosen. Each one is a real failure mode, not a
# hypothetical: the first three were observed in this fixture's own harvest.
# ---------------------------------------------------------------------------
MUST_NOT_SELECT: list[tuple[str, str, str]] = [
    ("banana", "Banana chips",
     "Fried/dried at ~5x the energy density of the fruit. The canonical "
     "form-change trap _FORM_CHANGING_WORDS exists for."),
    ("banana", "Bananas, dehydrated, or banana powder",
     "Same trap, powder form."),
    ("chicken breast", "Chicken breast tenders, breaded, uncooked",
     "Breaded product, not the plain cut."),
    ("olive oil", "Mayonnaise, reduced fat,  with olive oil",
     "An emulsion that merely contains the ingredient. Note the real "
     "double space — this is the live USDA description, unedited."),
    ("salmon", "Fish oil, salmon",
     "902 kcal/100g of oil rendered FROM the food, not the food."),
    ("salmon", "Salmon salad",
     "Mayonnaise-based composite dish."),
    ("apple", "Apple, dried",
     "~4x the energy density of the raw fruit."),
    ("whole milk", "Cheese, mozzarella, whole milk",
     "'whole milk' here is a modifier on a completely different food."),
    ("peanut butter", "Peanut butter sandwich, with regular peanut butter, on white bread",
     "Composite dish containing the ingredient."),
    ("broccoli", "Fried broccoli",
     "Preparation change that multiplies the fat content."),
    ("oats", "Oat milk",
     "A beverage made from the grain, not the grain."),
    ("cottage cheese", "Cheese, cottage cheese, with gelatin dessert",
     "Dessert product."),
    # --- guards for the 2026-09-11 category-prefix / origin-qualifier rules --
    # These two exist because that change deliberately LOOSENED the allowlist
    # gate for USDA's "<Category>, <food>, <qualifier>" names. Each is the
    # nearest miss to the row the change was written to admit
    # ("Nuts, walnuts, english"), so together they pin how far the loosening
    # is allowed to reach.
    ("walnuts", "Oil, walnut",
     "884 kcal/100g of oil pressed FROM the food. A leading segment naming a "
     "derived product is not a category — _USDA_DERIVED_PRODUCT_HEADS."),
    ("walnuts", "Nuts, walnuts, glazed",
     "Correct category prefix, but 'glazed' is a sugar coating, not an origin "
     "— 500 kcal/100g against 654 and 47.6g carbs against 13.7. Only a closed "
     "set of origin adjectives may survive as a single leftover token."),
]


# ---------------------------------------------------------------------------
# BASELINES — floors recorded 2026-09-10 against the implementation at the
# time. Raise them when a change earns it; never lower them to make a build
# pass. `pytest -s` prints the live figures next to these.
# ---------------------------------------------------------------------------
# Measured 2026-09-10 against the frozen fixture: grounding 42/46 (91.3%),
# accuracy 33/46 (71.7%). The floors sit a hair under each so ordinary float
# arithmetic cannot flake the build, and no lower — they are a record of where
# the matcher actually is, not a target it has yet to reach.
#
# The gap between the two is the finding worth staring at: retrieval grounds
# 91% of these queries but only 72% land on a defensible number, so roughly
# one grounded answer in five is confidently wrong AND stamped with a verified
# macro_source. See the OFF-BY rows in the report for the current offenders.
BASELINE_GROUNDING_RATE = 0.91   # share of "match" cases that ground at all
BASELINE_ACCURACY_RATE = 0.71    # share of "match" cases inside tolerance
# Share of macro-referenced cases whose protein/carbs/fats all land in band.
# Recorded 2026-09-11 when the macro assertions were added. Like the two above,
# this may only ever be raised.
BASELINE_MACRO_RATE = 0.88       # measured 24/27 (88.9%) on 2026-09-11


def _macro_verdict(case: Case, data: dict) -> tuple[str | None, list[str]]:
    """Compare a selected row's macros against the case's references.

    Returns (verdict, offenders) where verdict is None when the case carries no
    macro reference at all. A field is out of band only when it misses BOTH the
    relative and the absolute tolerance — see MACRO_TOL_PCT's comment for why
    the pair is needed rather than either alone."""
    offenders = []
    checked = False
    for field in MACRO_FIELDS:
        reference = getattr(case, field)
        if reference is None:
            continue
        checked = True
        actual = data.get(f"{field}_per_100g")
        if actual is None:
            offenders.append(f"{field}=absent")
            continue
        delta = abs(actual - reference)
        if delta <= MACRO_TOL_ABS_G:
            continue
        if reference > 0 and (delta / reference * 100) <= MACRO_TOL_PCT:
            continue
        offenders.append(f"{field} {actual:.1f} vs {reference:.1f}")
    if not checked:
        return None, []
    return ("macro-ok" if not offenders else "MACRO-OFF"), offenders


def _evaluate() -> dict:
    grounded = missed = accurate = inaccurate = 0
    macro_ok = macro_off = 0
    macro_offenders: list[tuple[str, list[str]]] = []
    rows = []
    for case in CASES:
        result = select(case.query)
        if case.expect == "miss":
            rows.append((case, result, "ok-miss" if result is None else "LEAKED", None, []))
            continue
        if result is None:
            if case.expect == "match":
                missed += 1
                rows.append((case, None, "MISS", None, []))
            else:
                # A "report" case grounding nothing is an observation, not a
                # failure — there was no reference value to hold it to.
                rows.append((case, None, "report", None, []))
            continue
        if case.expect == "match":
            grounded += 1
        name, data = result
        macro_state, offenders = _macro_verdict(case, data)
        if macro_state == "macro-ok":
            macro_ok += 1
        elif macro_state == "MACRO-OFF":
            macro_off += 1
            macro_offenders.append((case.query, offenders))
        if case.kcal is None:
            rows.append((case, result, "report", macro_state, offenders))
            continue
        delta_pct = abs(data["calories_per_100g"] - case.kcal) / case.kcal * 100
        if delta_pct <= case.tol_pct:
            accurate += 1
            rows.append((case, result, "ok", macro_state, offenders))
        else:
            inaccurate += 1
            rows.append((case, result, "OFF-BY", macro_state, offenders))

    match_cases = [c for c in CASES if c.expect == "match"]
    return {
        "rows": rows,
        "match_total": len(match_cases),
        "grounded": grounded,
        "missed": missed,
        "accurate": accurate,
        "inaccurate": inaccurate,
        "grounding_rate": grounded / len(match_cases),
        "accuracy_rate": accurate / len(match_cases),
        "macro_ok": macro_ok,
        "macro_off": macro_off,
        "macro_checked": macro_ok + macro_off,
        # Denominator is cases that actually carry a reference, not all 46 —
        # a case with no reference is unmeasured, not passing.
        "macro_rate": macro_ok / (macro_ok + macro_off) if (macro_ok + macro_off) else 1.0,
        "macro_offenders": macro_offenders,
    }


def test_report(capsys):
    """Not a pass/fail gate — the human-readable baseline. Run with -s to see
    it; the assertions below are what actually guard the numbers."""
    result = _evaluate()
    lines = ["", "=" * 96, "RETRIEVAL EVAL — offline, deterministic, no network", "=" * 96]
    for case, selected, verdict, macro_state, offenders in result["rows"]:
        if selected is None:
            lines.append(f"  {verdict:<8} {case.query:<22} —  (fell through to AI recall)")
            continue
        name, data = selected
        ref = f"ref {case.kcal:>4.0f}" if case.kcal is not None else "ref   — "
        macro = {"macro-ok": " macros ok", "MACRO-OFF": " MACRO-OFF", None: ""}[macro_state]
        lines.append(
            f"  {verdict:<8} {case.query:<22} {data['calories_per_100g']:>6.0f} kcal  "
            f"{ref}  [{(data.get('source') or '?')[:4]}] {name[:36]:<36}{macro}"
        )
        if offenders:
            lines.append(f"  {'':<8} {'':<22} -> {'; '.join(offenders)}")
    lines += [
        "-" * 96,
        f"  grounding {result['grounded']}/{result['match_total']} "
        f"({result['grounding_rate']:.0%}, floor {BASELINE_GROUNDING_RATE:.0%})   "
        f"accuracy {result['accurate']}/{result['match_total']} "
        f"({result['accuracy_rate']:.0%}, floor {BASELINE_ACCURACY_RATE:.0%})   "
        f"missed {result['missed']}   off-by {result['inaccurate']}",
        f"  macros    {result['macro_ok']}/{result['macro_checked']} "
        f"({result['macro_rate']:.0%}, floor {BASELINE_MACRO_RATE:.0%}) within "
        f"{MACRO_TOL_PCT:.0f}% or {MACRO_TOL_ABS_G:.0f}g on protein/carbs/fats",
        "=" * 96,
    ]
    with capsys.disabled():
        print("\n".join(lines))


def test_grounding_rate_has_not_regressed():
    """A query that grounds nothing becomes an AI guess — invisible at the UI
    layer, since the result still renders as a normal logged food. This is the
    metric that most directly tracks 'how often are we falling back to the
    model's memory'."""
    result = _evaluate()
    assert result["grounding_rate"] >= BASELINE_GROUNDING_RATE, (
        f"grounding rate fell to {result['grounding_rate']:.0%} "
        f"(floor {BASELINE_GROUNDING_RATE:.0%}). Newly missing: "
        + ", ".join(c.query for c, sel, v, _m, _o in result["rows"] if v == "MISS")
    )


def test_accuracy_rate_has_not_regressed():
    """Grounding is necessary but not sufficient: a confident match on the
    wrong entry is worse than a miss, because it is stamped with a verified
    macro_source and presented to the user as fact."""
    result = _evaluate()
    assert result["accuracy_rate"] >= BASELINE_ACCURACY_RATE, (
        f"accuracy rate fell to {result['accuracy_rate']:.0%} "
        f"(floor {BASELINE_ACCURACY_RATE:.0%}). Out of tolerance: "
        + ", ".join(c.query for c, sel, v, _m, _o in result["rows"] if v == "OFF-BY")
    )


def test_macro_accuracy_has_not_regressed():
    """Calories are the least sensitive thing retrieval can get wrong.

    A row can land within 7% on energy and still be 61% out on carbohydrate —
    that is the walnut case this assertion was written for, which this file
    printed as `ok` for a full day before anyone looked at a macro. A macro
    tracker's whole job is telling those apart, so grounding has to be held to
    the composition as well as the total."""
    result = _evaluate()
    assert result["macro_rate"] >= BASELINE_MACRO_RATE, (
        f"macro accuracy fell to {result['macro_rate']:.0%} "
        f"(floor {BASELINE_MACRO_RATE:.0%}). Out of band: "
        + "; ".join(f"{q} [{', '.join(o)}]" for q, o in result["macro_offenders"])
    )


@pytest.mark.parametrize("query,candidate_name,why", MUST_NOT_SELECT,
                         ids=[f"{q}!={c[:28]}" for q, c, _ in MUST_NOT_SELECT])
def test_must_not_select(query, candidate_name, why):
    """Precision guards. Each of these is a form/preparation change or a
    composite dish that merely contains the queried food, and every one is
    present in the frozen candidate set for that query — so this is a real
    test of the gates, not a vacuous one."""
    present = any(name == candidate_name for name, _ in CANDIDATES[query])
    assert present, (
        f"{candidate_name!r} is no longer in the harvested candidates for "
        f"{query!r} — this guard has gone vacuous. Re-harvest the fixture, "
        f"then either restore a real trap for this case or drop it."
    )
    score = ndb._score(query, candidate_name)
    assert score < ndb.CONFIDENCE_THRESHOLD, (
        f"{query!r} matched {candidate_name!r} at {score:.2f} "
        f"(threshold {ndb.CONFIDENCE_THRESHOLD}). {why}"
    )


def test_supplements_do_not_ground_generically():
    """The extraction prompt keeps the brand on a formulated supplement
    precisely so it CANNOT match a generic entry — a whey blend's macro ratio
    is its own recipe. Leaking one here would mean a user's protein powder got
    priced from some unrelated product."""
    for case in CASES:
        if case.expect != "miss":
            continue
        assert select(case.query) is None, (
            f"{case.query!r} grounded when it should have fallen through: {case.note}"
        )


def test_select_mirrors_lookup_uncached():
    """Guards the one real risk in this file: that `select()` above drifts
    from the production path it claims to replay. Runs the real
    _lookup_uncached with its two network searches stubbed out to serve the
    frozen fixture, and requires identical winners across every query."""
    import asyncio
    from unittest.mock import patch

    async def fake_usda(query, client):
        return [(n, d) for n, d in CANDIDATES[query] if d.get("source") == "usda"]

    async def fake_off(query, client):
        return [(n, d) for n, d in CANDIDATES[query] if d.get("source") == "openfoodfacts"]

    async def run():
        with patch.object(ndb, "_search_usda", fake_usda), patch.object(ndb, "_search_off", fake_off):
            for query in CANDIDATES:
                mine = select(query)
                theirs = await ndb._lookup_uncached(query)
                if mine is None:
                    assert theirs is None, f"{query}: select() missed but _lookup_uncached matched"
                else:
                    assert theirs is not None, f"{query}: select() matched but _lookup_uncached missed"
                    assert theirs["calories_per_100g"] == mine[1]["calories_per_100g"], (
                        f"{query}: select() and _lookup_uncached disagree on the winner"
                    )

    asyncio.run(run())


def test_fixture_is_intact():
    """Cheap structural guard so a truncated or hand-edited fixture fails
    loudly here rather than silently shrinking every metric above."""
    assert len(CANDIDATES) == 50, f"expected 50 harvested queries, got {len(CANDIDATES)}"
    total = sum(len(v) for v in CANDIDATES.values())
    assert total == 2010, f"expected 2010 harvested candidates, got {total}"
    for query in _CASES_BY_QUERY:
        assert query in CANDIDATES, f"case {query!r} has no harvested candidates"
