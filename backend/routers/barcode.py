import logging
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from auth import get_current_user
from models import ScanResult
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


@router.get("/{code}", response_model=ScanResult)
@limiter.limit("20/minute")
async def lookup_barcode(request: Request, code: str, user=Depends(get_current_user)):
    """Looks up a scanned barcode against Open Food Facts and returns it in
    the exact same shape as an AI photo scan, so the frontend can reuse the
    same result-review form for either path."""
    if not _CODE_PATTERN.match(code):
        raise HTTPException(status_code=422, detail="That doesn't look like a valid barcode.")

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
        raise HTTPException(
            status_code=404,
            detail="No product found for that barcode. Try AI photo scan or manual entry instead.",
        )

    product = data.get("product") or {}
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

    return ScanResult(
        food_name=food_name or "Packaged food",
        weight_g=100.0,  # per-100g by default — user can adjust to the actual portion before confirming
        calories=round(float(nutriments["energy-kcal_100g"]), 1),
        protein=round(float(nutriments["proteins_100g"]), 1),
        carbs=round(float(nutriments["carbohydrates_100g"]), 1),
        fats=round(float(nutriments["fat_100g"]), 1),
        fiber=round(float(fiber_100g), 1) if fiber_100g is not None else 0,
        confidence_note="From product label (Open Food Facts), per 100g — adjust weight to your actual portion",
    )
