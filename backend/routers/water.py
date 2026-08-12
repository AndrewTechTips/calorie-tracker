from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import WaterLogCreate, WaterLogResponse, WaterSummaryResponse
from routers.day import get_day_context

router = APIRouter(prefix="/water", tags=["water"])

# A hard daily ceiling — nothing in the UI previously stopped a mis-tap or a
# runaway custom-amount entry from pushing the total to an absurd number.
# 10 L is generously above any realistic daily intake. Enforced here (not
# just in the frontend) since the frontend's own cap is UX-only and must
# never be the sole source of truth for a stored value.
MAX_DAILY_WATER_ML = 10_000


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
    """'Today' means the user's local calendar date (routers/day.py) — water
    resets the moment real local midnight passes, the same log_date the food
    log dashboard filters by."""
    supabase = get_supabase()

    profile = await run_in_threadpool(
        lambda: supabase.table("profiles").select("daily_water_ml").eq("id", user.id).maybe_single().execute()
    )
    # maybe_single().execute() returns None outright (not an object with
    # .data = None) when zero rows match — must guard before touching .data.
    target_ml = ((profile.data if profile else None) or {}).get("daily_water_ml", 3000)

    day = await get_day_context(supabase, user.id)

    entries = await run_in_threadpool(
        lambda: supabase.table("water_logs")
        .select("*")
        .eq("user_id", user.id)
        .eq("log_date", day["date"].isoformat())
        .order("logged_at", desc=True)
        .execute()
    )

    total_ml = sum(e["amount_ml"] for e in entries.data)
    return {"total_ml": total_ml, "target_ml": target_ml, "entries": entries.data}


@router.post("", response_model=WaterLogResponse, status_code=201)
async def add_water(payload: WaterLogCreate, user=Depends(get_current_user)):
    """Same backdating + day-lock rules as POST /logs — see that endpoint's
    docstring."""
    supabase = get_supabase()
    day = await get_day_context(supabase, user.id)
    retention_days = get_settings().retention_days
    target_date = payload.log_date or day["date"]
    if target_date > day["date"]:
        raise HTTPException(status_code=422, detail="Can't log a future date")
    if target_date < day["date"] - timedelta(days=retention_days - 1):
        raise HTTPException(status_code=422, detail=f"Can't log a date older than {retention_days} days ago")
    if target_date == day["date"] and day["ended"]:
        raise HTTPException(status_code=409, detail="Today has been ended — logging resumes at midnight")

    existing = await run_in_threadpool(
        lambda: supabase.table("water_logs")
        .select("amount_ml")
        .eq("user_id", user.id)
        .eq("log_date", target_date.isoformat())
        .execute()
    )
    day_total = sum(e["amount_ml"] for e in existing.data)
    if day_total + payload.amount_ml > MAX_DAILY_WATER_ML:
        raise HTTPException(
            status_code=409,
            detail=f"Daily water limit of {MAX_DAILY_WATER_ML // 1000} L reached — this would put you over it.",
        )

    row = {"user_id": user.id, "amount_ml": payload.amount_ml, "log_date": target_date.isoformat()}
    result = await run_in_threadpool(lambda: supabase.table("water_logs").insert(row).execute())
    return result.data[0]


@router.delete("/{entry_id}", status_code=204)
async def delete_water_entry(entry_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("water_logs").delete().eq("id", entry_id).eq("user_id", user.id).execute()
    )
    return None
