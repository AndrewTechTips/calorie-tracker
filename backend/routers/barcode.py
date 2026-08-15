import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from auth import get_current_user
from models import ScanResult
from rate_limit import limiter
from services.barcode_lookup import query_off_by_code, reshape_off_product

logger = logging.getLogger("barcode")

router = APIRouter(prefix="/scan/barcode", tags=["barcode"])

# Barcodes (EAN-13/UPC-A/EAN-8/etc.) are purely numeric. Validating this
# up front means the path parameter can only ever be used as a lookup key
# against a fixed URL template — never free-form input reaching an external
# request.
_CODE_PATTERN = re.compile(r"^[0-9]{6,14}$")


# A scanner (or the product's own label) can report a code in the "wrong"
# format relative to what's actually stored on Open Food Facts — most
# commonly UPC-A (12 digits) vs. its EAN-13 form (13 digits, zero-padded), or
# a 14-digit GTIN-14 (some POS/warehouse-style scanners zero-pad every code
# to 14 regardless of the product's actual symbology) vs. its unpadded
# EAN-13/UPC-A form. These all encode the identical product, so trying the
# other form(s) is a safe, well-understood fallback rather than a fuzzy guess
# — not a text search (there's no name to search by from a bare barcode
# scan). Zero-cost hit-rate lever: no extra external service, just a couple
# more lookups against the same API before giving up.
def _alternate_codes(code: str) -> list[str]:
    candidates: list[str] = []
    if len(code) == 14 and code.startswith("0"):
        candidates.append(code[1:])  # -> EAN-13
        if code.startswith("00"):
            candidates.append(code[2:])  # -> UPC-A
    if len(code) == 12:
        candidates.append("0" + code)  # -> EAN-13
    if len(code) == 13 and code.startswith("0"):
        candidates.append(code[1:])  # -> UPC-A
    return candidates


@router.get("/{code}", response_model=ScanResult)
# Burst clause alongside the sustained one — same reasoning as
# routers/scan.py's decorators: a route-level limit here replaces (not adds
# to) rate_limit.py's app-wide burst default, and this route proxies every
# call out to the external Open Food Facts API.
@limiter.limit("20/minute;6/10 seconds")
async def lookup_barcode(request: Request, response: Response, code: str, user=Depends(get_current_user)):
    """Looks up a scanned barcode against Open Food Facts and returns it in
    the exact same shape as an AI photo scan, so the frontend can reuse the
    same result-review form for either path.

    `response: Response` is required by every @limiter.limit(...) route —
    see rate_limit.py's "SECOND gotcha" comment. Without it, this route's
    real success case (a barcode that's actually found) 500'd despite every
    *failure* path working fine, since only the 2xx path triggers it."""
    if not _CODE_PATTERN.match(code):
        # 400, not 422: this is a malformed/unreadable code (e.g. a
        # misdetected non-numeric symbology), a different condition from a
        # well-formed code whose product is merely missing nutrition data
        # (422 below) — the frontend's barcodeErrorMessage() branches on this
        # status to show "couldn't read that clearly" vs. "no nutrition data
        # on file", so the two need distinct codes, not just distinct text.
        raise HTTPException(status_code=400, detail="That doesn't look like a valid barcode.")

    product = await query_off_by_code(code)
    matched_code = code
    if product is None:
        for alt in _alternate_codes(code):
            product = await query_off_by_code(alt)
            if product is not None:
                matched_code = alt
                break

    if product is None:
        raise HTTPException(
            status_code=404,
            detail="No product found for that barcode. Try AI photo scan or manual entry instead.",
        )

    result = reshape_off_product(product, matched_via_alternate_code=matched_code != code)
    if result is None:
        # Nutriments are always per-100g on Open Food Facts. Some products
        # have incomplete label data entered by the community — treat that
        # the same way an unrecognizable AI scan is treated, rather than
        # returning zeros.
        raise HTTPException(
            status_code=422,
            detail="That product doesn't have complete nutrition data on file. Try AI photo scan or manual entry instead.",
        )
    return result
