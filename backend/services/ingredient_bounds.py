"""Deterministic nutrition math shared by every path that builds an
IngredientItem — the AI scan/describe pipeline (services/gemini_service.py)
and the Open Food Facts barcode lookup (services/barcode_lookup.py).

Two jobs, in this order:

  1. CONSISTENCY (reconcile_macro_mass / reconcile_calories) — do these
     figures describe a physically possible food? Macro mass can't exceed the
     food's own weight; calories can't fall below what those macros imply, or
     exceed pure fat's energy density.
  2. MAGNITUDE (clamp_ingredient) — are these figures inside the bounds
     models.py's IngredientItem actually declares? This is the one that keeps
     a bad figure from becoming a 500, and it is not optional anywhere: a
     route returning a ScanResult has that model validated during FastAPI's
     *serialization* step, after the handler returned and outside its
     try/except, so an over-range figure can't be caught, worded, or
     compensated for by the route that produced it.

This lives in its own module rather than in gemini_service because none of it
is AI-specific — it's arithmetic about food — and because barcode_lookup is a
keyless HTTP module that has no business importing the AI provider stack to
get at a clamp. gemini_service re-binds these under its own historical
private names, so its call sites and tests are unchanged.
"""

import logging
import math

from models import (
    MAX_INGREDIENT_CALORIES,
    MAX_INGREDIENT_FIBER_G,
    MAX_INGREDIENT_MACRO_G,
    MAX_INGREDIENT_NAME_CHARS,
    MAX_INGREDIENT_SODIUM_MG,
    MAX_INGREDIENT_WEIGHT_G,
)

# Kept as "gemini_service" deliberately: these functions' warning lines (an
# over-weight macro sum, an under-counted calorie figure) have been logged
# under that name since they were written, and anything grepping server logs
# for them should keep working across this move.
logger = logging.getLogger("gemini_service")


# ---------------------------------------------------------------------------
# Calorie/macro consistency safety net. Applied to every ingredient the real
# scan/describe pipeline produces (_resolve_ingredient), regardless of
# whether its macros came from a database match, an explicit user-stated
# value, or TEXT_ONLY_MACRO_PROMPT's AI-recall last resort — a database or
# user-typed figure can still be internally inconsistent (a crowdsourced
# Open Food Facts entry, a typo in a stated gram amount), and a small/
# free-tier model asked to self-check its own arithmetic (TEXT_ONLY_MACRO_
# PROMPT, MEAL_SUGGESTION_PROMPT) can still occasionally emit a calorie
# figure that doesn't match its own stated protein/carbs/fats — this catches
# that whole class of error deterministically instead of trusting any single
# source blindly.
#
# Deliberately ASYMMETRIC: only corrects calories that are LOWER than the
# Atwater-formula minimum (protein_g*4 + carbs_g*4 + fats_g*9), never higher.
# Real food calories can legitimately exceed that sum (alcohol contributes
# ~7 kcal/g and isn't tracked as any of these three macros; sugar alcohols/
# fiber can shift things the other way too) — but they can never fall BELOW
# it, since protein/carbs/fats are already counted at their standard energy
# values. So an under-count relative to the model's own stated macros is
# never legitimate and is safe to correct; an over-count might be a genuinely
# correct answer for a food this simple macro set can't fully represent, and
# forcibly lowering it would trade a rare model error for a guaranteed wrong
# answer on every alcoholic drink. Tolerance is deliberately wider than the
# ~5% the prompt itself asks the model to hit, so this only ever fires on a
# genuinely broken response, not routine rounding.
#
# The optional `weight_g` argument adds a SEPARATE, symmetric ceiling on top
# of the asymmetric undercount fix above: no real food exceeds ~9 kcal/g —
# pure fat's own energy density, the single most calorie-dense macro this app
# tracks (even alcohol, the "legitimate overcount" case the asymmetry above
# protects, is less dense at ~7 kcal/g). Unlike the undercount case, there is
# no legitimate reason for calories to exceed weight_g * ~9 — a value that
# does is unambiguously broken (e.g. an 8g-fat/5g-weight response, which
# reconcile_macro_mass above already corrects to 5g fat, but whose
# originally-reported 72 kcal figure would otherwise survive unchanged, since
# it doesn't trip the undercount check at all). Only applied when the caller
# passes weight_g — calls that don't (none currently) skip this ceiling
# entirely rather than risk a spurious cap with no weight to check against.
# ---------------------------------------------------------------------------
CALORIE_UNDERCOUNT_ABS_TOLERANCE = 50.0  # kcal
CALORIE_UNDERCOUNT_REL_TOLERANCE = 0.15  # 15% of the expected minimum
CALORIE_DENSITY_CEILING = 9.2  # kcal/g — pure fat (~9) plus a small rounding buffer


# ---------------------------------------------------------------------------
# Physical-mass consistency safety net — applied deterministically to every
# ingredient the real scan/describe pipeline resolves (_resolve_ingredient),
# regardless of macro source, plus a second layer behind TEXT_ONLY_MACRO_
# PROMPT/MEAL_SUGGESTION_PROMPT's own "verify weight_g >= protein_g +
# carbs_g + fats_g" instruction for their AI-recalled figures. protein_g +
# carbs_g + fats_g are mass components OF the food — their sum can never
# exceed the food's own total weight (the remainder is water/ash/other bulk, never
# negative) — so unlike reconcile_calories above this has no legitimate
# exception (nothing analogous to alcohol's extra, untracked calories exists
# for mass). Bug report: 5g of cooking oil coming back as 8g of fat.
#
# Scales protein/carbs/fats down proportionally (never a hard clamp on one
# field) so the corrected macros keep the model's own relative ratio between
# them rather than arbitrarily zeroing whichever field is summed last.
# MACRO_MASS_TOLERANCE gives a little room for legitimate independent
# per-field rounding before this fires.
# ---------------------------------------------------------------------------
MACRO_MASS_TOLERANCE = 1.03


def reconcile_macro_mass(weight_g: float, protein: float, carbs: float, fats: float) -> tuple[float, float, float]:
    total = protein + carbs + fats
    if weight_g > 0 and total > weight_g * MACRO_MASS_TOLERANCE:
        logger.warning(
            "Macro mass exceeded ingredient weight — correcting protein=%.1fg carbs=%.1fg fats=%.1fg "
            "(sum=%.1fg) down to fit weight_g=%.1fg",
            protein,
            carbs,
            fats,
            total,
            weight_g,
        )
        scale = weight_g / total
        return protein * scale, carbs * scale, fats * scale
    return protein, carbs, fats


def reconcile_calories(
    calories: float,
    protein: float,
    carbs: float,
    fats: float,
    weight_g: float | None = None,
    fiber: float = 0.0,
) -> float:
    """Raises `calories` to the Atwater floor when it sits implausibly below
    the macros it claims to describe, then caps it at a physical density
    ceiling.

    FIBER IS EXCLUDED FROM THE FLOOR (2026-09-17), and that is a correction of
    a real overcount rather than a refinement. Both USDA and EU labelling
    publish carbohydrate *by difference*, i.e. fibre is counted INSIDE the
    carbs figure — but fibre is largely not metabolised (EU Reg. 1169/2011
    assigns it 2 kcal/g; the indigestible fraction yields none). A flat
    carbs*4 floor therefore charges 4 kcal/g for grams that deliver almost
    none, and on a high-fibre food it overrides a CORRECT lower figure with an
    inflated one.

    Measured live on real wheat bran (`50g tarate de grau Pirifan`): the model
    returned 108 kcal, which is 216/100g and exactly USDA's own value. The
    naive floor computed 179 (358/100g) off 32.3g of carbs, 27g of which are
    fibre, and overwrote it — a 66% overcount, logged as if it were fixing a
    model error. Excluding fibre puts the floor at 158, comfortably under the
    correct 179... and under the model's correct 108's own tolerance band, so
    nothing fires and the right number survives.

    This is the same arithmetic CLAUDE.md already documents for the barcode
    path, which skips reconciliation entirely (`clamp_ingredient(...,
    reconcile=False)`) precisely because running it over a real printed label
    inflated correct high-fibre and sugar-free products by 30-58%. That
    reasoning was always equally true of an AI-produced figure; it only became
    load-bearing once the model became the primary source of macros rather
    than a fallback behind a database.

    `fiber` defaults to 0.0 so every caller that has no fibre figure to hand
    keeps the previous, stricter floor — the change can only ever lower the
    floor, never raise it, so it cannot introduce a new overcount anywhere.

    Deliberately NOT extended to sugar alcohols (also ~2 kcal/g): nothing in
    this pipeline tracks polyols as a field, so there is no number to subtract.
    A sugar-free product can still be over-floored here; the barcode path,
    where those products actually arrive with real labels, already skips this
    entirely."""
    # max(0, ...) because fibre is reported inside carbs, but a model can
    # round the two independently and hand back fibre marginally above the
    # carbs it is part of — which must never make the floor negative.
    digestible_carbs = max(carbs - fiber, 0.0)
    expected_minimum = protein * 4 + digestible_carbs * 4 + fats * 9
    tolerance = max(CALORIE_UNDERCOUNT_ABS_TOLERANCE, expected_minimum * CALORIE_UNDERCOUNT_REL_TOLERANCE)
    if calories < expected_minimum - tolerance:
        logger.warning(
            "Gemini under-counted calories relative to its own macros — correcting %.1f -> %.1f "
            "(protein=%.1fg carbs=%.1fg fats=%.1fg)",
            calories,
            expected_minimum,
            protein,
            carbs,
            fats,
        )
        calories = expected_minimum

    if weight_g is not None and weight_g > 0:
        ceiling = weight_g * CALORIE_DENSITY_CEILING
        if calories > ceiling:
            logger.warning(
                "Calories exceeded physical density ceiling — correcting %.1f -> %.1f (weight_g=%.1f)",
                calories,
                ceiling,
                weight_g,
            )
            calories = ceiling

    # Calories are always a whole integer (matches the top-level meal circle
    # UI and IngredientItem.calories/ScanResult.calories's int type) — unlike
    # protein/carbs/fats/fiber, which keep 1-decimal precision throughout
    # this file. A fractional value here (e.g. a 40g portion of a 68 kcal/100g
    # food reconciling to 27.2) used to reach the frontend's ingredient-row
    # calories input as-is, which has step="1" — the browser's own numeric
    # step validation then silently blocked form submission.
    return float(round(calories))


# ---------------------------------------------------------------------------
# Absolute-magnitude safety net — the last thing every resolved ingredient
# passes through before it becomes part of a ScanResult.
#
# The two reconcilers above only enforce figures being consistent WITH EACH
# OTHER (macro mass against weight, calories against macros). Neither caps how
# large any single figure may be, and on the photo-scan path two inputs can
# carry an arbitrarily large one all the way through:
#
#   - weight_g, which Stage 1 estimates from the image and which
#     _resolve_ingredient only ever floors at 0, never ceilings; and
#   - the explicit_* values, which Stage 1 lifts verbatim out of the user's
#     own context_text (see VISION_EXTRACTION_PROMPT's EXPLICIT_VALUES rule)
#     and which _resolve_ingredient trusts above every other source by
#     design — a number a person actually typed is ground truth, so nothing
#     downstream second-guesses its magnitude.
#
# That pairing is why this is reachable most easily on the image + context
# flow specifically: a photo on its own rarely yields an absurd figure, but
# "the whole tray, about 5 kg, 30000 kcal" typed into the context box is taken
# at face value on purpose. IngredientItem (models.py) declares hard bounds on
# all of it, and those bounds are checked during FastAPI's response
# serialization — after the handler returns, outside its try/except — so one
# over-range figure became a generic 500 that routers/scan.py could neither
# word helpfully nor refund the spent scan for. See MAX_INGREDIENT_* in
# models.py for the full note.
#
# Clamping to the edge of the range, rather than raising, is the right
# degradation here for the same reason _unpriced_ingredient keeps a row it
# couldn't price: the scan still lands the user in the review form, which is
# where an implausible figure gets corrected anyway. Refusing the whole scan
# over one bad number would throw away every other correctly-priced
# ingredient alongside it.
#
# Ordering is deliberate. weight_g is clamped FIRST, then the two existing
# reconcilers re-run against the clamped weight, so the result stays
# internally coherent (macros still fit the weight, calories still fit the
# macros) instead of merely being field-by-field in range — clamping a 50kg
# weight to 10kg while leaving its 46000 kcal untouched would satisfy neither
# reconciler. The calorie ceiling is then applied LAST, because
# reconcile_calories' undercount branch can legitimately raise calories back
# up to match the macros. At the very edge of the range (a 10kg ingredient
# whose macros are each clamped to 2000g) that final ceiling can leave
# calories below the macro-derived minimum; that is accepted, and preferable
# to scaling the macros down to agree with it, which would invent figures for
# a meal that is already nonsense at that magnitude.
# ---------------------------------------------------------------------------
def clamp_number(value, ceiling: float) -> float:
    """A finite float in [0, ceiling]. Anything that isn't a real number —
    None, a string a model emitted where a number belonged, NaN/inf — becomes
    0.0 rather than propagating: NaN in particular compares False against
    every bound, so it fails Pydantic's `le=` check as surely as a huge
    number does, while silently surviving a plain min()/max() clamp."""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return min(max(number, 0.0), float(ceiling))


def clamp_ingredient(item: dict, *, fallback_name: str = "Food", reconcile: bool = True) -> dict:
    """Force one resolved ingredient inside IngredientItem's declared bounds.

    `fallback_name` covers the other way this same crash was reachable:
    food_name carries `min_length=1`, and _resolve_ingredient's own
    `(item.get("food_name") or "Food").strip()` yields an empty string for a
    whitespace-only name (a non-empty string is truthy, so `or` never fires),
    which fails validation exactly as loudly as an over-range number.

    `reconcile=False` clamps magnitude ONLY, skipping the two consistency
    passes. Set it for a source whose figures are a real printed label rather
    than somebody's estimate — barcode_lookup's Open Food Facts products.
    Two reasons, and the first is the important one:

      - reconcile_calories' undercount branch would silently REWRITE correct
        label data. Its 4/4/9 Atwater floor assumes every gram of carbohydrate
        is metabolised, which is exactly untrue of the two things food
        manufacturers most like to put on a label: fibre and sugar alcohols.
        A genuine high-fibre cereal printing 250 kcal/100g against 10p/60c/5f
        gets "corrected" up to 325, and a sugar-free sweet printing 240
        against 95g of carbohydrate up to 380 — a 30-58% overcount applied to
        the single most trustworthy number in the whole app. An AI-recalled
        figure has no such claim on being right and is worth reconciling; a
        label does.
      - Nothing is lost by skipping it there. The reconcilers exist here to
        restore coherence after weight_g is clamped, and a barcode result's
        weight is a fixed per-100g basis that can never be out of range in
        the first place — so every field is independently in-bounds on its
        own, which is all response validation asks for."""
    name = str(item.get("food_name") or "").strip()[:MAX_INGREDIENT_NAME_CHARS]
    if not name:
        name = str(fallback_name or "Food").strip()[:MAX_INGREDIENT_NAME_CHARS] or "Food"

    weight_g = clamp_number(item.get("weight_g"), MAX_INGREDIENT_WEIGHT_G)
    protein = clamp_number(item.get("protein"), MAX_INGREDIENT_MACRO_G)
    carbs = clamp_number(item.get("carbs"), MAX_INGREDIENT_MACRO_G)
    fats = clamp_number(item.get("fats"), MAX_INGREDIENT_MACRO_G)
    calories = clamp_number(item.get("calories"), MAX_INGREDIENT_CALORIES)

    if reconcile:
        protein, carbs, fats = reconcile_macro_mass(weight_g, protein, carbs, fats)
        calories = reconcile_calories(
            calories, protein, carbs, fats, weight_g=weight_g,
            # Clamped the same way the macros above are, so a junk fibre figure
            # cannot subtract an unbounded amount from the floor and disarm it.
            fiber=clamp_number(item.get("fiber"), MAX_INGREDIENT_MACRO_G),
        )

    clamped = dict(item)
    clamped.update(
        {
            "food_name": name,
            "weight_g": round(weight_g, 1),
            # See the ordering note above: re-ceilinged after the reconcilers,
            # which can raise it. Still a whole integer, as everywhere else.
            "calories": float(round(min(calories, float(MAX_INGREDIENT_CALORIES)))),
            "protein": round(protein, 1),
            "carbs": round(carbs, 1),
            "fats": round(fats, 1),
            "fiber": round(clamp_number(item.get("fiber"), MAX_INGREDIENT_FIBER_G), 1),
            "sugar": round(clamp_number(item.get("sugar"), MAX_INGREDIENT_MACRO_G), 1),
            # Milligrams, not grams — a genuinely reachable overflow on its
            # own, independent of any absurd weight: nothing reconciles sodium
            # against anything, and a salt-heavy per-100g figure scaled up to a
            # large portion clears 20000mg without the rest of the ingredient
            # looking unusual at all.
            "sodium": round(clamp_number(item.get("sodium"), MAX_INGREDIENT_SODIUM_MG), 1),
        }
    )
    return clamped
