from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from auth import get_current_user
from database import get_supabase
from models import TargetsResponse, TargetsUpdate

router = APIRouter(prefix="/targets", tags=["targets"])

UNDEFINED_COLUMN = "42703"  # Postgres error code


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

    def do_update(data: dict):
        return supabase.table("profiles").update(data).eq("id", user.id).execute()

    try:
        result = await run_in_threadpool(do_update, update_data)
    except APIError as exc:
        # display_name is a new, optional column (sql/schema.sql) — if that
        # migration hasn't been applied to this Supabase project yet,
        # Postgres rejects the whole update over one unknown column. Retry
        # once without it rather than breaking every settings save for it;
        # the name just won't persist until the migration is run.
        if "display_name" in update_data and exc.code == UNDEFINED_COLUMN:
            retry_data = {k: v for k, v in update_data.items() if k != "display_name"}
            result = await run_in_threadpool(do_update, retry_data)
        else:
            raise
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data[0]
