from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from database import get_supabase
from models import WaterLogCreate, WaterLogResponse, WaterSummaryResponse

router = APIRouter(prefix="/water", tags=["water"])


def _today_start_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


@router.get("/today", response_model=WaterSummaryResponse)
async def get_today_water(user=Depends(get_current_user)):
    supabase = get_supabase()

    profile = supabase.table("profiles").select("daily_water_ml").eq("id", user.id).maybe_single().execute()
    target_ml = (profile.data or {}).get("daily_water_ml", 3000)

    entries = (
        supabase.table("water_logs")
        .select("*")
        .eq("user_id", user.id)
        .gte("logged_at", _today_start_iso())
        .order("logged_at", desc=True)
        .execute()
    )

    total_ml = sum(e["amount_ml"] for e in entries.data)
    return {"total_ml": total_ml, "target_ml": target_ml, "entries": entries.data}


@router.post("", response_model=WaterLogResponse, status_code=201)
async def add_water(payload: WaterLogCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {"user_id": user.id, "amount_ml": payload.amount_ml}
    result = supabase.table("water_logs").insert(row).execute()
    return result.data[0]


@router.delete("/{entry_id}", status_code=204)
async def delete_water_entry(entry_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    supabase.table("water_logs").delete().eq("id", entry_id).eq("user_id", user.id).execute()
    return None
