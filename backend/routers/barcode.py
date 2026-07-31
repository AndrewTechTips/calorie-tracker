import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user
from models import IngredientItem, ScanResult
from rate_limit import limiter

logger = logging.getLogger("barcode")

router = APIRouter(prefix="/scan/barcode", tags=["barcode"])

# Open Food Facts is a free, keyless public API — no quota tracking needed
# here (unlike Gemini in services/quota_service.py), this is a completely
# separate, unlimited external dependency. Still rate-limited defensively so
# one client can't hammer it through our backend.
_OFF_TIMEOUT = httpx.Timeout(8.0, connect=5.0)
_OFF_URL_TEMPLATE = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
_UNAVAILABLE_DETAIL = "Barcode lookup service is unavailable right now — try AI photo scan or manual entry instead."

# Barcodes (EAN-13/UPC-A/EAN-8/etc.) are purely numeric. Validating this
# up front means the path parameter can only ever be used as a lookup key
# against a fixed URL template — never free-form input reaching an external
# request.
_CODE_PATTERN = re.compile(r"^[0-9]{6,14}$")


async def _query_off(code: str) -> dict | None:
    """One lookup attempt against Open Food Facts for an already-validated
    numeric code. Returns the product dict on a real match, None on a clean
    "not found" (status != 1) — reserving the raised 503 for genuine
    transport/parsing failures, which are a different condition from "this
    particular code isn't in the database" and shouldn't be retried with an
    alternate code."""
    try:
        async with httpx.AsyncClient(timeout=_OFF_TIMEOUT) as client:
            response = await client.get(_OFF_URL_TEMPLATE.format(code=code))
    except httpx.HTTPError:
        logger.warning("Open Food Facts request failed for barcode %s", code)
        raise HTTPException(status_code=503, detail=_UNAVAILABLE_DETAIL)

    if response.status_code != 200:
        logger.warning("Open Food Facts returned HTTP %s for barcode %s", response.status_code, code)
        raise HTTPException(status_code=503, detail=_UNAVAILABLE_DETAIL)

    try:
        data = response.json()
    except ValueError:
        logger.warning("Open Food Facts returned non-JSON for barcode %s", code)
        raise HTTPException(status_code=503, detail=_UNAVAILABLE_DETAIL)

    if data.get("status") != 1:
        return None
    return data.get("product") or {}


# A scanner (or the product's own label) can report a code in the "wrong"
# format relative to what's actually stored on Open Food Facts — most
# commonly UPC-A (12 digits) vs. its EAN-13 form (13 digits, zero-padded).
# These two forms encode the identical product, so trying the other one is a
# safe, well-understood fallback rather than a fuzzy guess — not a text
# search (there's no name to search by from a bare barcode scan).
def _alternate_codes(code: str) -> list[str]:
    if len(code) == 12:
        return ["0" + code]
    if len(code) == 13 and code.startswith("0"):
        return [code[1:]]
    return []


@router.get("/{code}", response_model=ScanResult)
@limiter.limit("20/minute")
async def lookup_barcode(request: Request, code: str, user=Depends(get_current_user)):
    """Looks up a scanned barcode against Open Food Facts and returns it in
    the exact same shape as an AI photo scan, so the frontend can reuse the
    same result-review form for either path."""
    if not _CODE_PATTERN.match(code):
        raise HTTPException(status_code=422, detail="That doesn't look like a valid barcode.")

    product = await _query_off(code)
    matched_code = code
    if product is None:
        for alt in _alternate_codes(code):
            product = await _query_off(alt)
            if product is not None:
                matched_code = alt
                break

    if product is None:
        raise HTTPException(
            status_code=404,
            detail="No product found for that barcode. Try AI photo scan or manual entry instead.",
        )

    nutriments = product.get("nutriments") or {}

    # Nutriments are always per-100g on Open Food Facts. Some products have
    # incomplete label data entered by the community — treat that the same
    # way an unrecognizable AI scan is treated, rather than returning zeros.
    required_fields = ("energy-kcal_100g", "proteins_100g", "carbohydrates_100g", "fat_100g")
    if any(nutriments.get(field) is None for field in required_fields):
        raise HTTPException(
            status_code=422,
            detail="That product doesn't have complete nutrition data on file. Try AI photo scan or manual entry instead.",
        )

    food_name = (product.get("product_name") or product.get("generic_name") or "Packaged food").strip()[:200]

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
    if matched_code != code:
        # The scanned code itself wasn't on file, but its UPC-A/EAN-13
        # equivalent was — say so, since the matched product's name might not
        # obviously correspond to what was just scanned.
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
        # uses works here too, instead of barcode results being the one path
        # with no editable breakdown.
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
    )
