from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from auth import get_current_user
from database import get_supabase
from models import TargetsResponse, TargetsUpdate
from services.daytime_service import local_today
from services.db_tolerance import write_tolerant
from services.effective_targets import effective_calorie_target

router = APIRouter(prefix="/targets", tags=["targets"])


def _decorate(row: dict, user) -> dict:
    """Stitch onto every return path: created_at (auth.users, not a profiles
    column — see TargetsResponse) and effective_daily_calories (daily_calories
    unless a "Trim tomorrow" override is live for the user's local today —
    services/effective_targets.py). daily_calories itself is untouched: it's
    still the persistent goal the Settings form edits."""
    today = local_today(row.get("timezone") or "UTC")
    return {
        **row,
        "created_at": user.created_at,
        "effective_daily_calories": effective_calorie_target(row, today),
    }


@router.get("", response_model=TargetsResponse)
async def get_targets(user=Depends(get_current_user)):
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("profiles").select("*").eq("id", user.id).maybe_single().execute()
    )
    # created_at lives on auth.users, not the profiles row itself (see
    # TargetsResponse's own comment) — stitched onto every return path below
    # off the `user` object this dependency already resolved, rather than
    # queried again.
    #
    # maybe_single() returns None outright (not .data=None) on no match —
    # must guard before touching .data, or a missing profile row throws
    # AttributeError instead of hitting the self-heal path below.
    if result is None or not result.data:
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
            return _decorate(insert_result.data[0], user)
        except APIError:
            # Lost a race against a concurrent request doing the same thing
            # (or the trigger firing late after all) — the row exists now
            # either way, so just re-read it.
            retry = await run_in_threadpool(
                lambda: supabase.table("profiles").select("*").eq("id", user.id).maybe_single().execute()
            )
            if retry is None or not retry.data:
                raise HTTPException(status_code=404, detail="Profile not found")
            return _decorate(retry.data, user)
    return _decorate(result.data, user)


@router.put("", response_model=TargetsResponse)
async def update_targets(payload: TargetsUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    update_data = payload.model_dump(exclude_none=True)
    # locked_macro is the one field here that must be clearable back to NULL
    # (Adaptive Goals' "None" pill) — exclude_none=True above would otherwise
    # silently drop an explicit `locked_macro: null`, leaving the previous
    # lock in the DB untouched while the frontend's pill UI already shows
    # "None" selected (see analytics.js's saveLockedMacro), so the next
    # refetch snaps it back to the stale locked macro. model_fields_set
    # distinguishes "the frontend explicitly sent this field" (must be
    # applied, even as null) from "the field was omitted entirely" (e.g. a
    # general settings save that doesn't touch the lock — must NOT reset it,
    # same reasoning as the age/height/biological_sex comment on
    # currentTargetsPayload in app.js).
    if "locked_macro" in payload.model_fields_set:
        update_data["locked_macro"] = payload.locked_macro

    # display_name, avatar_url, and daily_fiber are all newer, optional
    # columns (sql/schema.sql) — write_tolerant() retries with whichever of
    # them (if any) isn't recognized yet on this Supabase project dropped
    # from the update, instead of one unmigrated column rejecting the whole
    # settings save. See services/db_tolerance.py.
    result = await write_tolerant(
        lambda data: supabase.table("profiles").update(data).eq("id", user.id).execute(), update_data
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    # Frontend's saveAvatar/submitTargets/etc. all do `state.targets = updated`
    # wholesale (see app.js) — _decorate re-adds created_at (else the "Member
    # since" badge blanks) and effective_daily_calories (else the dashboard
    # ring loses a live "Trim tomorrow" override until the next full reload).
    return _decorate(result.data[0], user)
