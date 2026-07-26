from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import MeasurementCreate, MeasurementResponse, MeasurementUpdate

router = APIRouter(prefix="/measurements", tags=["measurements"])


@router.get("", response_model=list[MeasurementResponse])
async def list_measurements(user=Depends(get_current_user)):
    """Kept indefinitely (see sql/schema.sql) — no retention window to clamp
    against. There's no per-name filter param: a user's own measurement
    history is small enough that the frontend just fetches everything once
    and groups/filters it client-side instead of a second round trip."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("body_measurements")
        .select("*")
        .eq("user_id", user.id)
        .order("logged_at", desc=True)
        .execute()
    )
    return result.data


@router.post("", response_model=MeasurementResponse, status_code=201)
async def add_measurement(payload: MeasurementCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {
        "user_id": user.id,
        "name": payload.name.strip(),
        "value": payload.value,
        "unit": payload.unit.strip() or "cm",
    }
    # logged_at is user-specified (the whole point of this feature — see
    # models.py) rather than always "now" like weight_logs; only set it when
    # provided so the column's own `default now()` covers the omitted case.
    if payload.logged_at is not None:
        row["logged_at"] = payload.logged_at.isoformat()
    result = await run_in_threadpool(lambda: supabase.table("body_measurements").insert(row).execute())
    return result.data[0]


@router.patch("/{entry_id}", response_model=MeasurementResponse)
async def update_measurement(entry_id: str, payload: MeasurementUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    updates = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()
    if payload.value is not None:
        updates["value"] = payload.value
    if payload.unit is not None:
        updates["unit"] = payload.unit.strip() or "cm"
    if payload.logged_at is not None:
        updates["logged_at"] = payload.logged_at.isoformat()

    result = await run_in_threadpool(
        lambda: supabase.table("body_measurements")
        .update(updates)
        .eq("id", entry_id)
        .eq("user_id", user.id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Measurement not found")
    return result.data[0]


@router.delete("/{entry_id}", status_code=204)
async def delete_measurement(entry_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("body_measurements").delete().eq("id", entry_id).eq("user_id", user.id).execute()
    )
    return None
