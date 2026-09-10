import logging
import math

import httpx
from fastapi import HTTPException

from models import MAX_INGREDIENT_NAME_CHARS, IngredientItem, ScanResult
from services.ingredient_bounds import clamp_ingredient

logger = logging.getLogger("barcode_lookup")

# Shared by routers/barcode.py (single explicit barcode-scan lookup) and
# routers/discover.py (product search, several codes at once) — the actual
# Open Food Facts fetch-and-reshape mechanics live here once, so both call
# sites stay in sync with each other instead of maintaining two copies of
# the same nutriment-field extraction/validation logic.
_OFF_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
_OFF_URL_TEMPLATE = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
# Open Food Facts documents that unidentified traffic (no descriptive
# User-Agent) is liable to be throttled or blocked as suspected abuse —
# nutrition_db_service.py's own OFF search already sets one of these; this
# module's direct-lookup path had been calling the same API without it,
# which is a plausible source of the exact failure this header fixes: a
# well-formed, genuinely-listed barcode occasionally coming back as a
# transport failure (503, below) instead of a real match, misreading as
# "the service is down" when the product would otherwise have been found.
_OFF_HEADERS = {"User-Agent": "IronLog/1.0 (barcode-scan; contact via app)"}
UNAVAILABLE_DETAIL = "Barcode lookup service is unavailable right now — try AI photo scan or manual entry instead."


async def query_off_by_code(code: str) -> dict | None:
    """One lookup attempt against Open Food Facts for an already-validated
    numeric code. Returns the product dict on a real match, None on a clean
    "not found" — either shape OFF uses for that (a 200 response with
    {"status": 0}, or a plain HTTP 404, see the 404 branch below for why
    both need to land here) — reserving the raised 503 for genuine
    transport/parsing failures, a different condition from "this particular
    code isn't in the database" that callers may want to handle differently
    (e.g. barcode.py's alternate-code-format retry)."""
    try:
        async with httpx.AsyncClient(timeout=_OFF_TIMEOUT, headers=_OFF_HEADERS) as client:
            response = await client.get(_OFF_URL_TEMPLATE.format(code=code))
    except httpx.TimeoutException:
        # Logged distinctly from the generic HTTPError case below — same 503
        # to the caller (the user-facing action is identical either way: wait
        # a moment or use Photo/Describe), but worth telling apart in server
        # logs when diagnosing whether OFF itself is slow/down vs. some other
        # transport failure (DNS, connection reset, etc).
        logger.warning("Open Food Facts request timed out for barcode %s", code)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)
    except httpx.HTTPError:
        logger.warning("Open Food Facts request failed for barcode %s", code)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)

    # Live-verified against the real API (not documented anywhere obvious):
    # Open Food Facts does NOT uniformly answer "not found" with HTTP 200 +
    # {"status": 0}. A structurally-invalid code (fails checksum, wrong
    # length) gets that 200/status-0 shape — handled below via `data.get(
    # "status") != 1`. But a well-formed, checksum-valid barcode that's
    # simply absent from their database — the single most common outcome of
    # scanning an ordinary product, and the exact case a user hits when a
    # real item just isn't catalogued yet — comes back as a genuine HTTP 404
    # instead. Before this was handled here, that 404 fell into the `!= 200`
    # branch below and raised the same 503 "service unavailable" as a real
    # transport failure, which is precisely the reported bug: a plain
    # "this product isn't in our database" scan read as "the whole barcode
    # feature is broken" instead of the correct, actionable "try Photo/
    # Describe" message. Treating 404 as a clean not-found (returning None,
    # same as the status-0 case) routes it to barcode.py's real 404 handling
    # instead.
    if response.status_code == 404:
        return None

    if response.status_code != 200:
        logger.warning("Open Food Facts returned HTTP %s for barcode %s", response.status_code, code)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)

    try:
        data = response.json()
    except ValueError:
        logger.warning("Open Food Facts returned non-JSON for barcode %s", code)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)

    if data.get("status") != 1:
        return None
    return data.get("product") or {}


def _as_float(value) -> float | None:
    """A finite float, or None for anything that isn't one.

    Open Food Facts nutriments are community-entered and arrive as whatever
    was typed: numbers, numeric strings ("250"), empty strings, "n/a", and
    occasionally NaN. A bare float() on those raises ValueError/TypeError
    from inside reshape_off_product, which no caller wraps — so a single
    badly-typed field in one crowdsourced product used to be a 500 for the
    user who happened to scan it."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def reshape_off_product(product: dict, *, matched_via_alternate_code: bool = False) -> ScanResult | None:
    """None when the product exists but is missing required nutrition
    fields (a lot of community-entered labels are incomplete) — callers
    decide what that means for them: barcode.py's single explicit lookup
    raises its own specific 422 for it, discover.py's search just skips
    that product and shows the rest of the results."""
    nutriments = product.get("nutriments") or {}
    required_fields = ("energy-kcal_100g", "proteins_100g", "carbohydrates_100g", "fat_100g")
    if any(nutriments.get(field) is None for field in required_fields):
        return None

    food_name = (product.get("product_name") or product.get("generic_name") or "Packaged food").strip()[:200]
    image_url = (product.get("image_front_url") or product.get("image_url") or "").strip()[:500] or None
    brand = (product.get("brands") or "").strip()[:200] or None

    # Fiber/sugar/sodium aren't in required_fields above: unlike calories/
    # protein/carbs/fat, a lot of otherwise-complete community-entered labels
    # just omit one or more of these — rejecting the whole lookup over an
    # optional field would be worse than showing 0 and letting the user fill
    # it in themselves if they know it.
    fiber_100g = nutriments.get("fiber_100g")
    sugar_100g = nutriments.get("sugars_100g")
    # Open Food Facts reports sodium_100g in GRAMS (it's derived from
    # salt_100g / 2.5) — this app's own sodium unit is milligrams (see
    # backend/models.py's IngredientItem.sodium), so this is the one field
    # here that needs a unit conversion, not just a plain float read.
    sodium_100g_grams = nutriments.get("sodium_100g")

    weight_g = 100.0
    # Every nutriment below goes through _as_float rather than a bare
    # float(): these are community-entered values, and the required_fields
    # check above only proves a key is present, never that it holds a number.
    # A required field that isn't parseable is treated as ABSENT — returning
    # None here, which both call sites already handle as "this product's
    # nutrition data is incomplete" (barcode.py's 422, discover.py skipping
    # the row). That is the correct reading: "n/a" in the fat field is
    # missing data wearing a string, not a product worth showing zeros for.
    calories = _as_float(nutriments["energy-kcal_100g"])
    protein = _as_float(nutriments["proteins_100g"])
    carbs = _as_float(nutriments["carbohydrates_100g"])
    fats = _as_float(nutriments["fat_100g"])
    if None in (calories, protein, carbs, fats):
        logger.warning(
            "Open Food Facts product %r has non-numeric values in a required nutriment field — "
            "treating as incomplete data",
            product.get("code") or product.get("product_name"),
        )
        return None

    # Whole integer — matches IngredientItem.calories/ScanResult.calories's
    # int type and the top-level meal circle UI; unlike protein/carbs/fats
    # below, which keep 1-decimal precision.
    calories = round(calories)
    protein = round(protein, 1)
    carbs = round(carbs, 1)
    fats = round(fats, 1)
    # The optional three degrade to 0 on an unparseable value for the same
    # reason they degrade to 0 when absent (see their comment above) — a
    # junk fibre figure isn't worth rejecting an otherwise-complete label.
    fiber = round(_as_float(fiber_100g) or 0, 1)
    sugar = round(_as_float(sugar_100g) or 0, 1)
    sodium = round((_as_float(sodium_100g_grams) or 0) * 1000, 1)

    confidence_note = "From product label (Open Food Facts), per 100g — adjust weight to your actual portion"
    if matched_via_alternate_code:
        confidence_note += " (matched via a related barcode format)"

    # Same magnitude enforcement the AI pipeline applies to every ingredient
    # it produces (services/ingredient_bounds.py) — a barcode result reaches
    # the client as the identical IngredientItem shape, so an out-of-range
    # figure fails validation here identically. It is genuinely reachable
    # from real crowdsourced data, not a theoretical edge: salt and soy sauce
    # carry 20000mg+ of sodium per 100g on a perfectly accurate label, and
    # a kJ figure typed into the kcal field clears the calorie ceiling on its
    # own. Unlike the AI path this one clamps magnitude ONLY (reconcile=False)
    # — see clamp_ingredient's own docstring for why re-deriving calories
    # from Atwater would corrupt a correct high-fibre or sugar-alcohol label.
    #
    # This is also where the long-product-name crash is fixed. The [:200]
    # truncation above is right for ScanResult.food_name, which is bounded by
    # what DailyLogCreate.food_name will accept when the user confirms the
    # log (200) — but IngredientItem.food_name stops at 100, and Open Food
    # Facts product names routinely run longer than that ("Chocolat noir 70%
    # cacao bio équitable tablette de dégustation origine Pérou..."). Every
    # such product was a hard 500. The two names deliberately keep their own
    # ceilings rather than both collapsing to 100: the header keeps the
    # fuller name the user actually saves, the breakdown row below it is
    # truncated to what its own model permits.
    ingredient = clamp_ingredient(
        {
            "food_name": food_name[:MAX_INGREDIENT_NAME_CHARS],
            "weight_g": weight_g,
            "calories": calories,
            "protein": protein,
            "carbs": carbs,
            "fats": fats,
            "fiber": fiber,
            "sugar": sugar,
            "sodium": sodium,
        },
        fallback_name="Packaged food",
        reconcile=False,
    )

    return ScanResult(
        food_name=food_name or "Packaged food",
        weight_g=weight_g,  # per-100g by default — user can adjust to the actual portion before confirming
        # Read back off the clamped ingredient, not from the raw figures
        # above, so the "top-level == sum of its ingredients" contract the AI
        # pipeline guarantees holds on this path too — otherwise a clamped
        # ingredient would visibly disagree with the meal circle above it.
        calories=ingredient["calories"],
        protein=ingredient["protein"],
        carbs=ingredient["carbs"],
        fats=ingredient["fats"],
        fiber=ingredient["fiber"],
        sugar=ingredient["sugar"],
        sodium=ingredient["sodium"],
        confidence_note=confidence_note,
        # A barcode lookup is a single packaged product, not a multi-component
        # meal — but it still gets a 1-item ingredients list (matching the
        # product itself) so the same ingredient-editor UI the AI-scan path
        # uses works here too.
        ingredients=[IngredientItem(**ingredient)],
        image_url=image_url,
        brand=brand,
    )


async def fetch_product_by_code(code: str) -> ScanResult | None:
    """Convenience wrapper for callers (routers/discover.py's product
    search) that just want "give me a usable result or nothing" without
    barcode.py's alternate-code-retry/specific-error-message nuance —
    returns None for not-found *or* incomplete-data, never raises for those
    two cases (still raises HTTPException(503) for a genuine transport
    failure, same as query_off_by_code)."""
    product = await query_off_by_code(code)
    if product is None:
        return None
    return reshape_off_product(product)
