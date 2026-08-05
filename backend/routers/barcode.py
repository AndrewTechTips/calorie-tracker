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
# Burst clause alongside the sustained one — same reasoning as
# routers/scan.py's decorators: a route-level limit here replaces (not adds
# to) rate_limit.py's app-wide burst default, and this route proxies every
# call out to the external Open Food Facts API.
@limiter.limit("20/minute;6/10 seconds")
async def lookup_barcode(request: Request, response: Response, code: str, user=Depends(get_current_user)):
    """Looks up a scanned barcode against Open Food Facts and returns it in
    the exact same shape as an AI photo scan, so the frontend can reuse the
    same result-review form for either path.

    `response: Response` is required — found while building routers/
    discover.py that this app's rate_limit.py comment about that requirement
    being scoped to key_func=rate_limit_key routes doesn't hold: any route
    decorated with @limiter.limit(...) needs it, or slowapi's header
    injection crashes on a genuine 2xx response (never on an error path,
    which is exactly why this route's own real success case — a barcode
    that's actually found — was silently broken until this fix, despite
    every *failure* path having been exercised and working fine)."""
    if not _CODE_PATTERN.match(code):
        raise HTTPException(status_code=422, detail="That doesn't look like a valid barcode.")

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
