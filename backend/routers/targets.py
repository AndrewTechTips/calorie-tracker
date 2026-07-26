from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from database import get_supabase
from models import TargetsResponse, TargetsUpdate
from services.db_tolerance import write_tolerant

router = APIRouter(prefix="/targets", tags=["targets"])


@router.get("", response_model=TargetsResponse)
async def get_targets(user=Depends(get_current_user)):
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("profiles").select("*").eq("id", user.id).maybe_single().execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data


@router.put("", response_model=TargetsResponse)
async def update_targets(payload: TargetsUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    update_data = payload.model_dump(exclude_none=True)

    # display_name and daily_fiber are both newer, optional columns
    # (sql/schema.sql) — write_tolerant() retries with whichever of them
    # (if any) isn't recognized yet on this Supabase project dropped from the
    # update, instead of one unmigrated column rejecting the whole settings
    # save. See services/db_tolerance.py.
    result = await write_tolerant(
        lambda data: supabase.table("profiles").update(data).eq("id", user.id).execute(), update_data
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data[0]
