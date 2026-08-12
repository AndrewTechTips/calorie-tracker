from fastapi import APIRouter, Depends

from auth import get_current_user
from models import AIUsageSummary
from services import ai_usage_service

router = APIRouter(prefix="/ai-usage", tags=["ai-usage"])


@router.get("", response_model=AIUsageSummary)
async def get_ai_usage(user=Depends(get_current_user)):
    """Per-user, per-feature AI quota snapshot for today (UTC) — powers
    Settings' AI Limits section (frontend/js/aiUsage.js). Every known
    feature (services/ai_usage_service.py's _FEATURE_LIMIT_SETTINGS) is
    always present, even ones this user hasn't touched today (used=0), so
    the frontend never has to special-case a missing entry. A plain read —
    no rate limit override needed beyond the app-wide default in
    rate_limit.py, since this never touches an AI provider itself."""
    features = await ai_usage_service.get_usage_summary(user.id)
    return AIUsageSummary(
        features=features,
        resets_at=ai_usage_service.resets_at(),
        monthly_resets_at=ai_usage_service.monthly_resets_at(),
    )
