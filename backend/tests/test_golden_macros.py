"""Golden-Set macro-accuracy eval for the FULL extraction -> DB-lookup ->
CoT-fallback pipeline (services.gemini_service.estimate_from_description).

This is NOT part of the fast/offline suite the rest of backend/tests/
guarantees (see tests/conftest.py's own comment: fake Supabase/Gemini keys,
NUTRITION_DB_GROUNDING_ENABLED forced off, so a bare `pytest` run never
touches the network). A golden-set eval is the opposite by design: it exists
specifically to catch bugs that ONLY manifest against the real extraction
model's actual word choices and the real USDA/Open Food Facts corpora — a
mocked LLM/DB can never reproduce e.g. the model translating "pisate"
(crushed) into "powder" and silently matching a defatted flour product. That
makes it slow (a real network + LLM round-trip per case), non-deterministic
(the extraction model's phrasing can vary run to run even when the
underlying nutrition_db_service matching logic is 100% deterministic), and
API-quota-consuming — none of which belong in the suite every contributor's
plain `pytest` invocation runs. Gated behind RUN_GOLDEN_EVAL=1 for that
reason; everything else here is a normal pytest module otherwise.

Run it with real provider keys (NOT tests/conftest.py's fake ones) and
grounding actually enabled:

    cd backend
    set -a && source .env && set +a   # loads real GEMINI/GROQ/USDA keys into the shell
    export NUTRITION_DB_GROUNDING_ENABLED=true
    export RUN_GOLDEN_EVAL=1
    pytest tests/test_golden_macros.py -v -s --log-cli-level=INFO

The `-s --log-cli-level=INFO` combination surfaces nutrition_db_service's own
"Grounded %r via %s" / "No confident database match for %r" log lines live,
plus this file's own per-case ingredient breakdown (source, weight, name) —
that trail is what turns a bare pass/fail into an actual root-cause, since
the failure modes this suite hunts for are matching/extraction bugs, not
arithmetic ones (arithmetic already has its own unit coverage in
test_gemini_reconcile.py / test_nutrition_db_service.py).

TOLERANCE (the benchmark's, applied uniformly): +/-3g protein, +/-3g fat,
+/-5g carbs, +/-30 kcal against the hardcoded ground truth below. A few
cases carry an explicit note where the ground truth itself has real-world
recipe variance wider than this band (e.g. a breaded-and-fried preparation)
— the tolerance still applies as specified, but see this file's own
docstring / the eval report for how to read a near-miss there.
"""

import logging
import os
from dataclasses import dataclass

import pytest

from services.gemini_service import estimate_from_description

logger = logging.getLogger("golden_macros")

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_GOLDEN_EVAL") != "1",
    reason=(
        "Opt-in live eval (real Gemini/Groq/USDA/Open Food Facts network "
        "calls, real API quota, non-deterministic extraction wording) — "
        "set RUN_GOLDEN_EVAL=1 and source real provider keys to run; see "
        "this module's own docstring for the full command."
    ),
)


@dataclass(frozen=True)
class GoldenCase:
    id: str
    input_text: str
    kcal: float
    protein: float
    carbs: float
    fats: float
    note: str
    # Per-benchmark defaults (see module docstring) — only ever loosened
    # with an explicit, documented reason (see e.g. FRIED_BREADED below),
    # never tightened, and never loosened just to make a failing case pass.
    kcal_tol: float = 30.0
    protein_tol: float = 3.0
    carbs_tol: float = 5.0
    fats_tol: float = 3.0


# ---------------------------------------------------------------------------
# Ground truth sourcing: USDA FoodData Central reference values (well-
# established, standard per-100g figures) for generic ingredients, scaled by
# hand to each case's stated weight; a couple of these are the exact figures
# this app's own code comments already cite as reference (egg white ~52kcal/
# 11g protein/0g fat — see nutrition_db_service.py's _SAFE_DESCRIPTOR_WORDS
# comment; hemp seeds ~30g protein/~50g fat — see TEXT_EXTRACTION_PROMPT's
# own CRUSHED/GROUND rule). The two Romanian-branded items (Fagaras light
# cheese, Pro Nutrition Pro Whey) are sourced from Open Food Facts / the
# brand's own listed label where a real entry exists — see each case's own
# `note` for the exact source and confidence.
# ---------------------------------------------------------------------------
GOLDEN_SET: list[GoldenCase] = [
    # --- Form/state traps -----------------------------------------------
    GoldenCase(
        id="hemp_seeds_crushed",
        input_text="100g semințe de cânepă pisate",
        kcal=553, protein=31.6, carbs=8.7, fats=48.8,
        note=(
            "USDA 'Seeds, hemp seed, hulled'. 'pisate' = crushed/ground "
            "(coarse mechanical breakup), NOT the same state as 'pudra'/"
            "'faina' (milled powder/flour) — a defatted hemp protein powder "
            "is a nutritionally different manufactured product (~50g "
            "protein/~10g fat/100g). The bug this case reproduces: 33.3g P/"
            "40g C/10g F is defatted hemp flour's profile, not crushed "
            "whole seeds'."
        ),
    ),
    GoldenCase(
        id="rice_powder_branded",
        input_text="100g orez pudră Vitabolic",
        kcal=359, protein=6.9, carbs=80.0, fats=1.3,
        note=(
            "USDA 'Rice flour, white, unenriched' (FDC 169714, cross-"
            "checked across 2 mirrors — no verified public label found for "
            "a 'Vitabolic' rice-powder SKU specifically, so ground truth is "
            "the generic dry-rice-powder/flour reference the extraction "
            "prompt's own state rule says this must resolve to). Must NOT "
            "resolve to cooked rice's ~130kcal/100g."
        ),
    ),
    GoldenCase(
        id="rice_cooked_baseline",
        input_text="200g orez fiert",
        kcal=260, protein=5.4, carbs=56.4, fats=0.6,
        note=(
            "USDA 'Rice, white, long-grain, regular, cooked', x2 for 200g. "
            "Baseline contrast for rice_powder_branded above. KNOWN "
            "RESIDUAL GAP (deferred, not yet fixed): even with USDA "
            "reachable, this consistently grounds via a real but "
            "higher-carb Open Food Facts 'cooked rice' product instead — "
            "ordinary crowdsourced-vs-reference variance, the exact "
            "'Known residual limitation' nutrition_db_service.py's own "
            "module docstring already documents for a bare, ambiguous-"
            "preparation staple query. The operational mitigation there "
            "(a real, non-rate-limited USDA key) is already in place; the "
            "residual gap now is USDA-vs-OFF ranking preference for a "
            "generic staple, not USDA reachability."
        ),
    ),
    GoldenCase(
        id="pasta_dry",
        input_text="50g paste uscate",
        kcal=185.5, protein=6.5, carbs=37.4, fats=0.75,
        note="USDA 'Pasta, dry, unenriched' (~371kcal/100g), x0.5 for 50g. Paired with pasta_cooked below — same rough amount of 'pasta food', opposite stated state.",
    ),
    GoldenCase(
        id="pasta_cooked",
        input_text="150g paste fierte",
        kcal=235.5, protein=8.7, carbs=45.9, fats=1.35,
        note="USDA 'Pasta, cooked, enriched, with added salt' (FDC 169751, ~157kcal/100g), x1.5 for 150g. Not the same food quantity as pasta_dry above (cooked pasta absorbs water and roughly doubles-to-triples in weight) — this is a form-recognition pair, not a mass-equivalence one.",
    ),
    GoldenCase(
        id="apple_juice_liquid",
        input_text="200ml suc de mere",
        kcal=92, protein=0.2, carbs=22.6, fats=0.2,
        note="USDA 'Apple juice, unsweetened' (~46kcal/100ml), x2 for 200ml. Must not match whole-apple's fiber/lower-sugar profile.",
    ),
    # --- Modifier traps ----------------------------------------------------
    GoldenCase(
        id="fagaras_cheese_light",
        input_text="100g brânză Făgăraș light de la Lidl",
        kcal=87, protein=11.6, carbs=3.5, fats=3.0,
        note=(
            "Open Food Facts, real verified label: 'Branza Fagaras light - "
            "Pilos - 200 grame' (barcode 20127442), the actual Lidl "
            "Romania 3%-fat SKU this input names. KNOWN RESIDUAL GAP "
            "(deferred, not yet fixed): Open Food Facts carries several "
            "anonymous, brand-less 'Light cheese' entries beyond the one "
            "_is_implausible_high_fat_for_light_dairy_claim rejects (23g "
            "fat/100g) — this still lands on a different, still-wrong "
            "anonymous entry (~7-8g fat) instead of the real Pilos SKU "
            "above. Root cause: none of these carry any real product "
            "identity to verify against, the same shape "
            "_is_unidentified_supplement_match already solves for "
            "formulated supplements specifically — generalizing that gate "
            "beyond supplements to dairy/light claims is a reasonable "
            "follow-up, deliberately NOT done here without further live "
            "verification against more examples first (shipping an "
            "unverified generalization here would repeat exactly the "
            "mistake nutrition_db_service.py's own module docstring "
            "already warns against for the analogous USDA case)."
        ),
    ),
    GoldenCase(
        id="fagaras_cheese_regular",
        input_text="100g brânză Făgăraș",
        kcal=190, protein=13, carbs=3, fats=14,
        kcal_tol=45, protein_tol=4, fats_tol=6,  # loosened: no single verified label for "regular" (unqualified) Fagaras-style cheese — see note
        note=(
            "ESTIMATE, not a verified label (no OFF entry found for an "
            "unqualified 'regular' Fagaras cheese specifically) — reasoned "
            "from a typical ~15% fat fresh Romanian brined/cottage-style "
            "cheese, using the verified 3%-fat 'light' SKU above as the "
            "low anchor. The point of this pair isn't hitting this exact "
            "number, it's confirming 'light' and unqualified resolve to "
            "MEANINGFULLY DIFFERENT (not identical) fat content — a light-"
            "modifier bug would most likely show up as both cases landing "
            "on the same (usually the light) figure, not as this specific "
            "case missing its tolerance band alone. KNOWN RESIDUAL GAP: a "
            "live run occasionally lands on the same wrong anonymous "
            "'Light cheese' match fagaras_cheese_light's own gap describes, "
            "for the single bare query 'branza fagaras' (search_name and "
            "food_name deduped to one query here, since neither carries a "
            "'light' modifier to tell them apart) — repeated direct "
            "reproduction of that EXACT query (8+ requests, sequential and "
            "concurrent) always returned the correct 'Branza fagaras' "
            "match, so this reads as low-frequency flakiness in Open Food "
            "Facts' own search ranking for the SAME query across separate "
            "requests minutes apart, not a reproducible defect in this "
            "app's matching/transliteration logic — noted rather than "
            "chased further, since a fix can't be verified against a "
            "failure that won't reliably reproduce on demand."
        ),
    ),
    # --- Supplements ---------------------------------------------------
    GoldenCase(
        id="whey_pro_nutrition",
        input_text="38g Proteina Pro Whey Pro Nutrition ciocolata",
        kcal=144.4, protein=28.5, carbs=3.0, fats=2.3,
        kcal_tol=40, protein_tol=6, carbs_tol=5, fats_tol=4,  # loosened: ground truth itself is a reasoned estimate, not a verified label — see note
        note=(
            "ESTIMATE, not a verified label. Live lookup found pronutrition.ro's "
            "own product page (direct fetch 403-blocked; scraped snippet "
            "figures were internally inconsistent — implied >100g protein "
            "per 100g of product, a physical impossibility, so discarded "
            "rather than trusted). Ground truth here is instead a standard "
            "whey-concentrate/isolate-blend reference (~380kcal/75g "
            "protein/8g carb/6g fat per 100g, scaled to the 38g serving) — "
            "exactly the 'generic equivalent' TEXT_ONLY_MACRO_PROMPT's own "
            "reasoning scratchpad is built to fall back to for an "
            "unverifiable branded product. This case is really testing "
            "that the brand STAYS in search_name and the bare-category OFF "
            "entry gets rejected (_is_unidentified_supplement_match), not "
            "that the AI recalls this exact SKU's real label."
        ),
    ),
    # --- Normal meals -------------------------------------------------
    GoldenCase(
        id="chicken_breast_grilled",
        input_text="150g piept de pui la grătar",
        kcal=247.5, protein=46.5, carbs=0, fats=5.4,
        note=(
            "USDA 'Chicken, breast, meat only, cooked, grilled/roasted' "
            "(~165kcal/100g), x1.5 for 150g. KNOWN RESIDUAL GAP (deferred, "
            "not yet fixed): even with USDA reachable, its own actual "
            "chicken-breast entries are all named with a verbose 'grilled "
            "with/without sauce, skin eaten/not eaten' qualifier — 'sauce'/"
            "'eaten'/'without'/'not' aren't in _SAFE_DESCRIPTOR_WORDS, so "
            "every USDA candidate fails the allowlist gate against a bare "
            "'grilled chicken breast' query, and this falls to a real but "
            "lower-calorie crowdsourced Open Food Facts match instead. "
            "Deliberately NOT allowlisting those words outright: 'skin' is "
            "already allowlisted, so doing the same for 'eaten'/'sauce' "
            "would make the WITH-sauce/WITH-skin variants pass too, and "
            "since none of them would then out-score each other (the query "
            "says nothing about sauce/skin either way), USDA's own result "
            "ordering — which live-verified puts the with-sauce/skin-eaten "
            "variant FIRST, not the plain one this app actually wants — "
            "would likely win by list-order tiebreak. That would trade a "
            "moderate, bounded gap (a real but different crowdsourced "
            "number) for a worse one (silently adding sauce/skin fat a "
            "bare query never asked for). Fixing this properly needs a "
            "negation-aware distinction ('skin eaten' vs 'skin NOT eaten'), "
            "not a blanket allowlist addition — left for a future pass "
            "rather than shipped half-verified."
        ),
    ),
    GoldenCase(
        id="oats_with_milk",
        input_text="100g ovăz cu 200ml lapte 1.5%",
        kcal=475, protein=22.9, carbs=75.0, fats=9.8,
        note="100g USDA 'Oats, rolled, raw' (389kcal/16.9P/66.3C/6.9F) + 200ml Open Food Facts 'Lapte Zuzu 1.5%' (43kcal/3.01P/4.36C/1.45F per 100ml, a real Romanian-market product) — two-ingredient extraction + summation case.",
    ),
    GoldenCase(
        id="banana_implicit_portion",
        input_text="o banana",
        kcal=105, protein=1.3, carbs=27, fats=0.4,
        note="No weight stated — tests portion-size inference against this app's own documented anchor (TEXT_EXTRACTION_PROMPT point 2: 'a medium banana is ~118g'). USDA raw banana ~89kcal/100g x 118g.",
    ),
    GoldenCase(
        id="peanut_butter",
        input_text="30g unt de arahide",
        kcal=176.4, protein=7.5, carbs=6.0, fats=15.0,
        note="USDA 'Peanut butter, smooth, no salt added' (~588kcal/100g), x0.3 for 30g. High-fat-density sanity check.",
    ),
    GoldenCase(
        id="beer_alcohol_calories",
        input_text="500ml bere",
        kcal=215, protein=2.5, carbs=18.0, fats=0,
        note=(
            "USDA 'Alcoholic beverage, beer, regular' (~43kcal/100ml), x5 "
            "for 500ml. Deliberately checks the pipeline does NOT apply "
            "_reconcile_calories' undercount correction here: the Atwater "
            "sum of the macros alone (2.5*4 + 18*4 = 82kcal) is far below "
            "the true 215kcal because alcohol itself isn't a tracked macro "
            "— that gap is real and must survive, not get 'corrected' down."
        ),
    ),
    GoldenCase(
        id="egg_white",
        input_text="100g albuș de ou",
        kcal=52, protein=10.9, carbs=0.7, fats=0.2,
        note="USDA 'Egg, white, raw, fresh' — the exact figure nutrition_db_service.py's own _SAFE_DESCRIPTOR_WORDS comment already cites as the historical bug this app fixed (~52kcal/11g protein/0g fat, previously confused with whole egg).",
    ),
    GoldenCase(
        id="egg_whole_boiled",
        input_text="2 ouă întregi fierte",
        kcal=155, protein=12.6, carbs=1.1, fats=10.6,
        note="USDA 'Egg, whole, cooked, hard-boiled', ~100g for 2 medium eggs. Contrast pair for egg_white above — must NOT collapse to the egg-white figure just because both are 'egg'.",
    ),
    GoldenCase(
        id="chicken_breaded_fried",
        input_text="100g piept de pui pane, prăjit",
        kcal=260, protein=21, carbs=13, fats=15,
        kcal_tol=45, protein_tol=8, carbs_tol=8, fats_tol=5,  # loosened: real breaded/fried recipes vary meaningfully more than the strict default band (coating thickness, oil absorption) — see note
        note=(
            "USDA-order-of-magnitude reference for breaded, fried chicken "
            "breast. Tolerance loosened beyond the benchmark default "
            "because breading/frying is inherently higher-variance than a "
            "plain ingredient (coating thickness, oil absorption) — a near-"
            "miss here should be read qualitatively (right order of "
            "magnitude vs a plain-grilled-chicken answer), not graded like "
            "a single-ingredient case. Also checks CLOSED-WORLD + fried-"
            "state handling: 'pane'+'prajit' are explicit stated prep, so "
            "added carbs/fat here are legitimate, not hallucinated."
        ),
    ),
    GoldenCase(
        id="explicit_user_stated_override",
        input_text=(
            "300g piept de pui cu exact 45g proteine, 0g carbohidrați, "
            "5g grăsimi si 220 kcal"
        ),
        kcal=220, protein=45, carbs=0, fats=5,
        note="Fully explicit-stated macros must pass through verbatim (MACRO_SOURCE_USER_STATED), never re-derived from a chicken-breast DB/AI lookup — these stated numbers are deliberately NOT what 300g of real chicken breast would compute to, so a pass here is unambiguous proof the explicit-value trust order actually wins.",
    ),
]


def _diff(actual: float, expected: float, tol: float) -> str | None:
    delta = actual - expected
    if abs(delta) > tol:
        sign = "+" if delta > 0 else ""
        return f"{actual:g} vs expected {expected:g} (±{tol:g}) — off by {sign}{delta:.1f}"
    return None


@pytest.mark.parametrize("case", GOLDEN_SET, ids=lambda c: c.id)
async def test_golden_macro_accuracy(case: GoldenCase):
    result = await estimate_from_description(case.input_text)

    ingredient_trace = [
        f"    - {i['food_name']!r}: {i['weight_g']:g}g, "
        f"{i['calories']:g}kcal/{i['protein']:g}P/{i['carbs']:g}C/{i['fats']:g}F "
        f"[source={i.get('macro_source')}]"
        for i in result.get("ingredients", [])
    ]
    logger.info(
        "%s (%r) -> total %gkcal/%gP/%gC/%gF; ingredients:\n%s",
        case.id, case.input_text, result["calories"], result["protein"],
        result["carbs"], result["fats"], "\n".join(ingredient_trace),
    )

    failures = [
        f"calories: {msg}" for msg in [_diff(result["calories"], case.kcal, case.kcal_tol)] if msg
    ] + [
        f"protein: {msg}" for msg in [_diff(result["protein"], case.protein, case.protein_tol)] if msg
    ] + [
        f"carbs: {msg}" for msg in [_diff(result["carbs"], case.carbs, case.carbs_tol)] if msg
    ] + [
        f"fats: {msg}" for msg in [_diff(result["fats"], case.fats, case.fats_tol)] if msg
    ]

    assert not failures, (
        f"\n{case.id} ({case.input_text!r}) — {case.note}\n"
        + "\n".join(f"  FAIL {f}" for f in failures)
        + "\n  ingredients:\n" + "\n".join(ingredient_trace)
    )
