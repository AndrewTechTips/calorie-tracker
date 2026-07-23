from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import TrendsResponse
from services.trends_service import compute_trends

router = APIRouter(prefix="/trends", tags=["trends"])


@router.get("", response_model=TrendsResponse)
async def get_trends(user=Depends(get_current_user)):
    """Aggregates the existing retained window (daily_logs/water_logs,
    settings.retention_days) into one row per calendar day, plus the current
    adherence streak. Deliberately computed at read time from the same rows
    the dashboard already stores — no separate summary table, so this adds
    zero extra storage (see sql/schema.sql / the retention decision). The
    actual aggregation math lives in services/trends_service.py so it can be
    unit-tested without a Supabase connection."""
    settings = get_settings()
    retention_days = settings.retention_days
    supabase = get_supabase()

    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()

    profile = supabase.table("profiles").select("daily_calories").eq("id", user.id).maybe_single().execute()
    target_calories = (profile.data or {}).get("daily_calories") or 2200

    logs = (
        supabase.table("daily_logs")
        .select("calories,protein,carbs,fats,logged_at")
        .eq("user_id", user.id)
        .gte("logged_at", cutoff)
        .execute()
    )
    water = (
        supabase.table("water_logs")
        .select("amount_ml,logged_at")
        .eq("user_id", user.id)
        .gte("logged_at", cutoff)
        .execute()
    )
    weight = (
        supabase.table("weight_logs")
        .select("weight_kg,logged_at")
        .eq("user_id", user.id)
        .gte("logged_at", cutoff)
        .execute()
    )

    return compute_trends(
        logs.data or [],
        water.data or [],
        weight.data or [],
        retention_days=retention_days,
        target_calories=target_calories,
    )
