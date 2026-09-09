from fastapi import APIRouter, Depends, HTTPException, Request, Response

from auth import get_current_user, rate_limit_key
from models import CustomFoodResponse, CustomFoodUpdate
from rate_limit import limiter
from services import custom_food_service, food_cache_service

router = APIRouter(prefix="/foods", tags=["foods"])


@router.get("/popular")
async def get_popular_foods(user=Depends(get_current_user)):
    """Autocomplete suggestions for the food-name field, sourced from names
    reused across the shared rename cache (services/food_cache_service.py).
    Not user-scoped: this is shared, non-personal data (just food names)."""
    return {"names": food_cache_service.list_popular()}


# ---------------------------------------------------------------------------
# Custom foods — the user's own saved per-100g nutrition facts.
#
# These exist because a saved food OUTRANKS USDA in the pricing trust order
# (see gemini_service._resolve_ingredient). That makes it the one source in
# the app where a wrong value is worse than no value: it silently misprices
# that food on every future log, while the violet "Your label" chip vouches
# for it. Before these routes there was no way to see a saved figure, let
# alone take one back — a mistyped 760 kcal where 76 was meant would have
# followed the user around forever.
#
# Ownership on every route is enforced the same way as everywhere else in
# this app: the service layer filters `.eq("user_id", user.id)` on the
# service-role client, so a foreign id matches no rows and reads as a 404
# rather than touching someone else's data (see CLAUDE.md's "Two Supabase
# clients, two trust levels").
# ---------------------------------------------------------------------------
@router.get("/custom", response_model=list[CustomFoodResponse])
async def list_custom_foods(user=Depends(get_current_user)):
    """Everything this user has saved, newest-corrected first — the Saved >
    My Foods tab. Returns an empty list (never an error) on a Supabase
    project that hasn't run the custom_foods migration yet, so the tab shows
    its empty state instead of breaking the whole Saved view."""
    return await custom_food_service.list_all(user.id)


@router.patch("/custom/{food_id}", response_model=CustomFoodResponse)
# Tighter than the app-wide default: this writes a reference value that
# affects every future log of that food, so it deserves the same
# deliberate-action ceiling the account routes use. A route-level decorator
# REPLACES rate_limit.py's app-wide defaults rather than adding to them, so
# the burst clause is restated here (see routers/scan.py's own comment).
@limiter.limit("30/minute;6/10 seconds", key_func=rate_limit_key)
# `response: Response` is required on any route using rate_limit_key — see
# rate_limit.py's "SECOND gotcha" comment.
async def update_custom_food(
    request: Request,
    response: Response,
    food_id: str,
    payload: CustomFoodUpdate,
    user=Depends(get_current_user),
):
    """Corrects a saved food's per-100g figures, or renames it.

    Values arrive ALREADY per-100g — the user is editing the reference
    itself, not a portion of it — so unlike the correction path that created
    the row (custom_food_service.save_from_portion) there is no division and
    no minimum-weight rule, only the shared ceilings.
    """
    try:
        updated = await custom_food_service.update_one(
            user.id, food_id, payload.model_dump(exclude_none=True)
        )
    except ValueError as exc:
        # Raised for a value outside its per-100g ceiling, an empty payload,
        # a name with nothing to key on, or a rename that collides with
        # another of this user's own foods. All are ordinary user mistakes
        # with a useful message, not server errors.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="Saved food not found")
    return updated


@router.delete("/custom/{food_id}", status_code=204)
@limiter.limit("30/minute;6/10 seconds", key_func=rate_limit_key)
async def delete_custom_food(
    request: Request,
    response: Response,
    food_id: str,
    user=Depends(get_current_user),
):
    """Forgets a saved food. The next log of it falls back to the normal
    trust order (USDA / Open Food Facts, then an AI estimate) — deleting a
    bad entry always restores strictly better behavior than leaving it."""
    if not await custom_food_service.delete_one(user.id, food_id):
        raise HTTPException(status_code=404, detail="Saved food not found")
    return None
