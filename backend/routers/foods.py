from fastapi import APIRouter, Depends

from auth import get_current_user
from services import food_cache_service

router = APIRouter(prefix="/foods", tags=["foods"])


@router.get("/popular")
async def get_popular_foods(user=Depends(get_current_user)):
    """Read-only, in-memory list of food names that have actually been reused
    across the shared rename cache (services/food_cache_service.py) — powers
    the manual-entry/scan-result name field's autocomplete suggestions
    (frontend/js/app.js::syncFoodNameOptions) alongside a user's own saved
    meals and recent logs. Not user-scoped by design: this is shared, global
    data with no personal information in it (just food names), same
    reasoning as quota_service.py's shared, not-per-user Gemini vision-pool
    tracking."""
    return {"names": food_cache_service.list_popular()}
