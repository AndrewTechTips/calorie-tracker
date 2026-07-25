from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import WaterLogCreate, WaterLogResponse, WaterSummaryResponse
from routers.day import sync_day_state
from services.day_service import effective_cutoff

router = APIRouter(prefix="/water", tags=["water"])


@router.get("/history", response_model=list[WaterLogResponse])
async def list_water_history(
    days: int | None = Query(default=None, ge=1),
    user=Depends(get_current_user),
):
    """Flat list of water entries across the retained window (or a smaller
    slice of it) — used by trends aggregation and data export, as opposed to
    /water/today's single-day summary shape used by the dashboard."""
    retention_days = get_settings().retention_days
    effective_days = min(days, retention_days) if days else retention_days
    cutoff = (datetime.now(timezone.utc) - timedelta(days=effective_days)).isoformat()
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("water_logs")
        .select("*")
        .eq("user_id", user.id)
        .gte("logged_at", cutoff)
        .order("logged_at", desc=True)
        .execute()
    )
    return result.data


@router.get("/today", response_model=WaterSummaryResponse)
async def get_today_water(user=Depends(get_current_user)):
    """'Today' here means the same cutoff /day exposes and lets you move
    forward with 'End day' (routers/day.py) — not always literal midnight,
    so water resets the moment a day is manually ended, same as the
    dashboard's food log does client-side with the same cutoff."""
    supabase = get_supabase()

    profile = await run_in_threadpool(
        lambda: supabase.table("profiles").select("daily_water_ml").eq("id", user.id).maybe_single().execute()
    )
    target_ml = (profile.data or {}).get("daily_water_ml", 3000)

    day_state = await sync_day_state(supabase, user.id)
    cutoff = effective_cutoff(day_state["day_boundary"]).isoformat()

    entries = await run_in_threadpool(
        lambda: supabase.table("water_logs")
        .select("*")
        .eq("user_id", user.id)
        .gte("logged_at", cutoff)
        .order("logged_at", desc=True)
        .execute()
    )

    total_ml = sum(e["amount_ml"] for e in entries.data)
    return {"total_ml": total_ml, "target_ml": target_ml, "entries": entries.data}


@router.post("", response_model=WaterLogResponse, status_code=201)
async def add_water(payload: WaterLogCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {"user_id": user.id, "amount_ml": payload.amount_ml}
    result = await run_in_threadpool(lambda: supabase.table("water_logs").insert(row).execute())
    return result.data[0]


@router.delete("/{entry_id}", status_code=204)
async def delete_water_entry(entry_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("water_logs").delete().eq("id", entry_id).eq("user_id", user.id).execute()
    )
    return None
