from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from database import get_supabase
from models import WeightLogCreate, WeightLogResponse

router = APIRouter(prefix="/weight", tags=["weight"])


@router.get("", response_model=list[WeightLogResponse])
async def list_weight_logs(
    days: int | None = Query(default=None, ge=1),
    user=Depends(get_current_user),
):
    """Body weight is kept indefinitely (see sql/schema.sql), so unlike
    /logs and /water/history there's no retention window to clamp against —
    `days` here just narrows the query for callers that want a shorter
    slice (e.g. a 30-day chart) instead of every entry ever logged."""
    supabase = get_supabase()
    query = supabase.table("weight_logs").select("*").eq("user_id", user.id)
    if days:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        query = query.gte("logged_at", cutoff)
    result = query.order("logged_at", desc=True).execute()
    return result.data


@router.post("", response_model=WeightLogResponse, status_code=201)
async def add_weight_log(payload: WeightLogCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {"user_id": user.id, "weight_kg": payload.weight_kg}
    result = supabase.table("weight_logs").insert(row).execute()
    return result.data[0]


@router.delete("/{entry_id}", status_code=204)
async def delete_weight_log(entry_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    supabase.table("weight_logs").delete().eq("id", entry_id).eq("user_id", user.id).execute()
    return None
