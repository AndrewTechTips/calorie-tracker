from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

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
        # sql/schema.sql's on_auth_user_created trigger is meant to insert this
        # row automatically at signup — but a Supabase project whose schema was
        # applied before that trigger existed (or where it's simply missing for
        # any other reason) silently leaves every new signup with no profile
        # row at all. That's worse here than it sounds: the frontend's
        # settings-btn handler (app.js) treats a failed GET /targets as fatal
        # and never opens the Settings sheet, so this alone was enough to make
        # the whole sheet — export button included — read as "not there" for
        # an affected user, not just the targets form inside it. Self-heal
        # instead of 404ing: insert the same default row the trigger would
        # have, so this works immediately regardless of whether that trigger
        # actually exists on this particular project.
        try:
            insert_result = await run_in_threadpool(
                lambda: supabase.table("profiles").insert({"id": user.id, "email": user.email}).execute()
            )
            return insert_result.data[0]
        except APIError:
            # Lost a race against a concurrent request doing the same thing
            # (or the trigger firing late after all) — the row exists now
            # either way, so just re-read it.
            retry = await run_in_threadpool(
                lambda: supabase.table("profiles").select("*").eq("id", user.id).maybe_single().execute()
            )
            if not retry.data:
                raise HTTPException(status_code=404, detail="Profile not found")
            return retry.data
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
