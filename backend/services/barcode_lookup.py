import logging

import httpx
from fastapi import HTTPException

from models import IngredientItem, ScanResult

logger = logging.getLogger("barcode_lookup")

# Shared by routers/barcode.py (single explicit barcode-scan lookup) and
# routers/discover.py (product search, several codes at once) — the actual
# Open Food Facts fetch-and-reshape mechanics live here once, so both call
# sites stay in sync with each other instead of maintaining two copies of
# the same nutriment-field extraction/validation logic.
_OFF_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
_OFF_URL_TEMPLATE = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
UNAVAILABLE_DETAIL = "Barcode lookup service is unavailable right now — try AI photo scan or manual entry instead."


async def query_off_by_code(code: str) -> dict | None:
    """One lookup attempt against Open Food Facts for an already-validated
    numeric code. Returns the product dict on a real match, None on a clean
    "not found" (status != 1) — reserving the raised 503 for genuine
    transport/parsing failures, a different condition from "this particular
    code isn't in the database" that callers may want to handle differently
    (e.g. barcode.py's alternate-code-format retry)."""
    try:
        async with httpx.AsyncClient(timeout=_OFF_TIMEOUT) as client:
            response = await client.get(_OFF_URL_TEMPLATE.format(code=code))
    except httpx.HTTPError:
        logger.warning("Open Food Facts request failed for barcode %s", code)
        raise HTTPException(status_code=503, detail=UNAVAILABLE_DETAIL)

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

    # Fiber isn't in required_fields above: unlike calories/protein/carbs/fat,
    # a lot of otherwise-complete community-entered labels just omit it —
    # rejecting the whole lookup over that one optional field would be worse
    # than showing 0 and letting the user fill it in themselves if they know it.
    fiber_100g = nutriments.get("fiber_100g")

    weight_g = 100.0
    calories = round(float(nutriments["energy-kcal_100g"]), 1)
    protein = round(float(nutriments["proteins_100g"]), 1)
    carbs = round(float(nutriments["carbohydrates_100g"]), 1)
    fats = round(float(nutriments["fat_100g"]), 1)
    fiber = round(float(fiber_100g), 1) if fiber_100g is not None else 0

    confidence_note = "From product label (Open Food Facts), per 100g — adjust weight to your actual portion"
    if matched_via_alternate_code:
        confidence_note += " (matched via a related barcode format)"

    return ScanResult(
        food_name=food_name or "Packaged food",
        weight_g=weight_g,  # per-100g by default — user can adjust to the actual portion before confirming
        calories=calories,
        protein=protein,
        carbs=carbs,
        fats=fats,
        fiber=fiber,
        confidence_note=confidence_note,
        # A barcode lookup is a single packaged product, not a multi-component
        # meal — but it still gets a 1-item ingredients list (matching the
        # product itself) so the same ingredient-editor UI the AI-scan path
        # uses works here too.
        ingredients=[
            IngredientItem(
                food_name=food_name or "Packaged food",
                weight_g=weight_g,
                calories=calories,
                protein=protein,
                carbs=carbs,
                fats=fats,
                fiber=fiber,
            )
        ],
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
