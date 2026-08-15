from fastapi import APIRouter, Depends

from auth import get_current_user
from models import AIUsageSummary
from services import ai_usage_service

router = APIRouter(prefix="/ai-usage", tags=["ai-usage"])


@router.get("", response_model=AIUsageSummary)
async def get_ai_usage(user=Depends(get_current_user)):
    """Per-user, per-feature AI quota snapshot for today — powers Settings'
    AI Limits section. Every known feature is always present (used=0 if
    untouched), so the frontend never special-cases a missing entry."""
    features = await ai_usage_service.get_usage_summary(user.id)
    return AIUsageSummary(features=features)
