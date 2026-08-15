from fastapi import APIRouter, Depends

from auth import get_current_user
from services import food_cache_service

router = APIRouter(prefix="/foods", tags=["foods"])


@router.get("/popular")
async def get_popular_foods(user=Depends(get_current_user)):
    """Autocomplete suggestions for the food-name field, sourced from names
    reused across the shared rename cache (services/food_cache_service.py).
    Not user-scoped: this is shared, non-personal data (just food names)."""
    return {"names": food_cache_service.list_popular()}
