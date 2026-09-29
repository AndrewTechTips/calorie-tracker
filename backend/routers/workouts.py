import asyncio
import functools
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from auth import get_current_user
from database import get_supabase
from models import (
    CardioCreate,
    CardioResponse,
    WorkoutSessionCreate,
    WorkoutSessionResponse,
    WorkoutSessionUpdate,
    WorkoutSetCreate,
    WorkoutSetUpdate,
)
from rate_limit import limiter
from routers.day import get_day_context
from services import cardio_service, workout_service
from services.db_tolerance import UNDEFINED_TABLE_CODES, read_tolerant

router = APIRouter(prefix="/workouts", tags=["workouts"])

_NOT_MIGRATED_DETAIL = (
    "The Workout Diary needs a one-time database update that hasn't been applied to this "
    "project yet. Ask your administrator to run the latest sql/schema.sql against Supabase."
)


def _503_if_not_migrated(fn):
    """Every route below reads/writes workout_sessions/workout_sets, tables
    this feature introduces (sql/schema.sql) that — unlike an existing
    table's new column (see db_tolerance.write_tolerant) — a not-yet-migrated
    project doesn't have at all. There's no partial-write fallback for a
    missing table the way there is for a missing column, so this is a flat
    "not set up yet" 503 instead of the raw 500 an unhandled APIError would
    otherwise surface. Pre-existing routes that merely *read* this table
    incidentally (routers/trends.py, routers/analytics.py) use
    db_tolerance.read_tolerant instead, since they must keep working with no
    workout data at all rather than fail outright — this router IS the
    feature, so failing loudly (with a clear reason) is correct here."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except APIError as exc:
            if exc.code in UNDEFINED_TABLE_CODES:
                raise HTTPException(status_code=503, detail=_NOT_MIGRATED_DETAIL) from exc
            raise

    return wrapper


# Same reasoning as the old flat workout_logs endpoint this replaces: kept
# indefinitely (see sql/schema.sql), no retention window to clamp against,
# but capped regardless of how long someone's been using the app. A session
# is one gym visit rather than one exercise entry now, so this covers a
# genuinely longer history than the old MAX_WORKOUT_ROWS=500 (which counted
# individual exercise entries) did.
MAX_SESSION_ROWS = 500


def _to_session_response(session: dict, sets: list[dict], cardio: list[dict] | None = None) -> dict:
    return {
        **session,
        "sets": sorted(sets, key=lambda s: (s["exercise_name"].lower(), s["set_number"])),
        # Newest last, so a session reads in the order it happened.
        "cardio": sorted(cardio or [], key=lambda c: c.get("logged_at") or ""),
    }


async def _fetch_cardio(supabase, session_ids: list[str]) -> dict[str, list[dict]]:
    """Cardio for a set of sessions, grouped by session_id.

    read_tolerant rather than the router's own 503: cardio_sessions is a table
    a project can legitimately not have yet (Phase 3 ships the migration for the
    user to apply by hand), and a session's SETS must keep loading regardless.
    The whole diary going dark because the newest optional feature has not been
    migrated would be a worse failure than cardio simply not appearing — which
    is the same judgement routers/trends.py already makes about workout data."""
    if not session_ids:
        return {}
    result = await read_tolerant(
        lambda: supabase.table("cardio_sessions").select("*").in_("session_id", session_ids).execute()
    )
    grouped: dict[str, list[dict]] = {}
    for row in result.data or []:
        grouped.setdefault(row["session_id"], []).append(row)
    return grouped


async def _get_latest_weight_kg(supabase, user_id: str) -> float:
    """Bodyweight input for the MET calorie formula — the user's most
    recent weight_logs entry (weight isn't stored on the profile itself,
    see sql/schema.sql), falling back to a generic average when they've
    never logged one."""
    result = await run_in_threadpool(
        lambda: supabase.table("weight_logs")
        .select("weight_kg")
        .eq("user_id", user_id)
        .order("logged_at", desc=True)
        .limit(1)
        .execute()
    )
    if result.data:
        return float(result.data[0]["weight_kg"])
    return workout_service.DEFAULT_BODYWEIGHT_KG


async def _fetch_session_or_404(supabase, session_id: str, user_id: str) -> dict:
    result = await run_in_threadpool(
        lambda: supabase.table("workout_sessions").select("*").eq("id", session_id).eq("user_id", user_id).maybe_single().execute()
    )
    if result is None or not result.data:
        raise HTTPException(status_code=404, detail="Workout session not found")
    return result.data


async def _fetch_sets(supabase, session_id: str) -> list[dict]:
    result = await run_in_threadpool(
        lambda: supabase.table("workout_sets").select("*").eq("session_id", session_id).order("set_number").execute()
    )
    return result.data or []


async def _recompute_and_save(
    supabase,
    session: dict,
    user_id: str,
    *,
    sets: list[dict] | None = None,
    weight_kg: float | None = None,
    cardio: list[dict] | None = None,
) -> dict:
    """Recomputes calories_burned from this session's current sets and
    persists it — called after every set create/update/delete so the
    cached column (dashboard Activity Burn chip, trends, analytics' 7-day
    average) never drifts from what's actually logged.

    `sets`/`weight_kg` let a caller that has ALREADY resolved those hand them
    in instead of paying for a second read of something it just fetched — see
    add_set, which is the hot path (one call per logged set, several per rest
    period) and where the duplicate `_fetch_sets` this removes was the whole
    cost. Omitted, they're fetched here as before, concurrently rather than
    one after the other: they're independent queries, so the callers that
    genuinely have nothing to hand in (update_set/delete_set/finish) still get
    one wait instead of two. Behaviour is identical either way — same math,
    same inputs, same persisted column."""
    # Fetch concurrently whatever the caller did not already have. The three
    # reads are mutually independent, so a caller that hands in none of them
    # still waits once rather than three times.
    missing = []
    if sets is None:
        missing.append(("sets", _fetch_sets(supabase, session["id"])))
    if weight_kg is None:
        missing.append(("weight", _get_latest_weight_kg(supabase, user_id)))
    if cardio is None:
        missing.append(("cardio", _fetch_cardio(supabase, [session["id"]])))
    if missing:
        results = await asyncio.gather(*(coro for _, coro in missing))
        for (name, _), value in zip(missing, results):
            if name == "sets":
                sets = value
            elif name == "weight":
                weight_kg = value
            else:
                cardio = value.get(session["id"], [])
    duration_hours = workout_service.estimate_session_duration_hours(
        started_at=session["started_at"], ended_at=session.get("ended_at"), set_count=len(sets)
    )
    strength_calories = workout_service.estimate_session_calories(sets, weight_kg, duration_hours)
    # A session can hold both — lifting and a finisher on the bike. The cached
    # column is the whole session's burn, so the cardio rows have to be added
    # back in or logging a set would silently erase the cardio already logged
    # against the same session.
    cardio_rows = cardio or []
    cardio_calories = sum(row.get("calories_burned") or 0 for row in cardio_rows)
    calories_burned = round(strength_calories + cardio_calories, 1)
    updated = {"calories_burned": calories_burned, "updated_at": datetime.now(timezone.utc).isoformat()}
    result = await run_in_threadpool(
        lambda: supabase.table("workout_sessions").update(updated).eq("id", session["id"]).execute()
    )
    return _to_session_response(result.data[0], sets, cardio_rows)


@router.get("/sessions", response_model=list[WorkoutSessionResponse])
@_503_if_not_migrated
async def list_sessions(
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
    user=Depends(get_current_user),
):
    """Backs the Workout Diary calendar — `start`/`end` narrow to a visible
    month/range; omitted, this returns full history (capped at
    MAX_SESSION_ROWS) the same way /measurements and the old /workouts did."""
    supabase = get_supabase()
    query = supabase.table("workout_sessions").select("*").eq("user_id", user.id)
    if start:
        query = query.gte("session_date", start.isoformat())
    if end:
        query = query.lte("session_date", end.isoformat())
    sessions_result = await run_in_threadpool(
        lambda: query.order("session_date", desc=True).limit(MAX_SESSION_ROWS).execute()
    )
    sessions = sessions_result.data or []
    if not sessions:
        return []

    session_ids = [s["id"] for s in sessions]
    sets_result = await run_in_threadpool(
        lambda: supabase.table("workout_sets").select("*").in_("session_id", session_ids).order("set_number").execute()
    )
    sets_by_session: dict[str, list[dict]] = {}
    for row in sets_result.data or []:
        sets_by_session.setdefault(row["session_id"], []).append(row)

    cardio_by_session = await _fetch_cardio(supabase, session_ids)
    return [
        _to_session_response(s, sets_by_session.get(s["id"], []), cardio_by_session.get(s["id"], []))
        for s in sessions
    ]


@router.get("/sessions/{session_id}", response_model=WorkoutSessionResponse)
@_503_if_not_migrated
async def get_session(session_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    session = await _fetch_session_or_404(supabase, session_id, user.id)
    sets, cardio = await asyncio.gather(
        _fetch_sets(supabase, session_id),
        _fetch_cardio(supabase, [session_id]),
    )
    return _to_session_response(session, sets, cardio.get(session_id, []))


@router.post("/sessions", response_model=WorkoutSessionResponse, status_code=201)
@_503_if_not_migrated
async def create_session(payload: WorkoutSessionCreate, user=Depends(get_current_user)):
    supabase = get_supabase()
    # Defaults to the user's own local "today" (routers/day.py — same
    # timezone-aware concept every other "today" in this app uses), not a
    # raw UTC date, so a late-night session in a non-UTC timezone lands on
    # the calendar day the user actually experienced it as.
    if payload.session_date is not None:
        session_date = payload.session_date
    else:
        day = await get_day_context(supabase, user.id)
        session_date = day["date"]
    row = {
        "user_id": user.id,
        "name": payload.name,
        "notes": payload.notes,
        "session_date": session_date.isoformat(),
    }
    # Duration-based cardio shortcut (Damage Control's "Move it"): a whole
    # activity logged with a time, not sets. Estimate calories_burned up front
    # from the MET formula so this session lands complete in one request — no
    # sets to add, no "Finish workout" step, and it shows on the dashboard
    # Activity chip / trends immediately like any other session.
    if payload.activity and payload.duration_minutes:
        weight_kg = await _get_latest_weight_kg(supabase, user.id)
        row["calories_burned"] = workout_service.estimate_cardio_calories(
            payload.activity, payload.duration_minutes, weight_kg
        )
        # A finished session from the start (started_at..ended_at span the
        # real activity duration, so the diary's detail view shows the right
        # elapsed time) — nothing else ever recomputes it (add_set/finish are
        # the only recompute paths, and a cardio session has no sets).
        now = datetime.now(timezone.utc)
        row["started_at"] = (now - timedelta(minutes=payload.duration_minutes)).isoformat()
        row["ended_at"] = now.isoformat()
        row["name"] = payload.name or payload.activity
    result = await run_in_threadpool(lambda: supabase.table("workout_sessions").insert(row).execute())
    return _to_session_response(result.data[0], [])


@router.patch("/sessions/{session_id}", response_model=WorkoutSessionResponse)
@_503_if_not_migrated
async def update_session(session_id: str, payload: WorkoutSessionUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    await _fetch_session_or_404(supabase, session_id, user.id)

    updates: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
    if payload.name is not None:
        updates["name"] = payload.name
    if payload.notes is not None:
        updates["notes"] = payload.notes
    if payload.finish:
        updates["ended_at"] = datetime.now(timezone.utc).isoformat()

    result = await run_in_threadpool(
        lambda: supabase.table("workout_sessions").update(updates).eq("id", session_id).eq("user_id", user.id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Workout session not found")
    session = result.data[0]

    if payload.finish:
        # Finishing swaps the calorie estimate's duration input from the
        # in-progress set-count heuristic to the session's real elapsed
        # time (see workout_service.estimate_session_duration_hours) — worth
        # a real recompute, not just returning the row as-is.
        return await _recompute_and_save(supabase, session, user.id)

    sets = await _fetch_sets(supabase, session_id)
    return _to_session_response(session, sets)


@router.delete("/sessions/{session_id}", status_code=204)
@_503_if_not_migrated
async def delete_session(session_id: str, user=Depends(get_current_user)):
    supabase = get_supabase()
    # workout_sets rows cascade-delete via their session_id -> workout_sessions.id
    # foreign key (sql/schema.sql) — no separate delete pass needed here.
    await run_in_threadpool(
        lambda: supabase.table("workout_sessions").delete().eq("id", session_id).eq("user_id", user.id).execute()
    )
    return None


@router.post("/sessions/{session_id}/sets", response_model=WorkoutSessionResponse, status_code=201)
@limiter.limit("60/minute;10/10 seconds")
@_503_if_not_migrated
async def add_set(request: Request, response: Response, session_id: str, payload: WorkoutSetCreate, user=Depends(get_current_user)):
    """The fast, one-handed mobile entry point — logs a single set and
    returns the whole session (including the freshly recomputed
    calories_burned) in one round trip, so the Workout Diary's active-session
    view never needs a second request just to refresh its summary. Rate
    limit is generous relative to this app's other write endpoints
    (backend/rate_limit.py's 120/minute;20/second app-wide default already
    covers ordinary use) since a real set-logging burst — several sets typed
    in quick succession between rest periods — is expected, normal usage
    here, not abuse."""
    supabase = get_supabase()

    # Three independent reads — the ownership check, the sets this session
    # already has (for set_number), and the bodyweight the MET formula needs.
    # Concurrent rather than sequential for the same reason routers/trends.py
    # gathers its own six: supabase-py is synchronous, so each still goes off
    # the event loop via run_in_threadpool, but the request waits once instead
    # of three times. Nothing here depends on another's result.
    session, existing_sets, weight_kg, cardio_by_session = await asyncio.gather(
        _fetch_session_or_404(supabase, session_id, user.id),
        _fetch_sets(supabase, session_id),
        _get_latest_weight_kg(supabase, user.id),
        # Phase 3: the session's cached burn is strength PLUS cardio, so a set
        # change has to know the cardio already logged against the same session
        # or it would silently erase it. Gathered here with the other three
        # rather than read inside _recompute_and_save, which would have turned
        # the one remaining wait into two — the count of queries went 5 -> 6,
        # the count of WAITS (the only thing the user feels) stayed at three.
        _fetch_cardio(supabase, [session_id]),
    )

    exercise_lower = payload.exercise_name.strip().lower()
    set_number = 1 + sum(1 for s in existing_sets if s["exercise_name"].strip().lower() == exercise_lower)

    row = {
        "user_id": user.id,
        "session_id": session_id,
        "exercise_name": payload.exercise_name.strip(),
        "category": payload.category,
        "set_number": set_number,
        "reps": payload.reps,
        "weight_kg": payload.weight_kg,
        "rpe": payload.rpe,
    }
    insert_result = await run_in_threadpool(lambda: supabase.table("workout_sets").insert(row).execute())
    # The insert already hands back the row it wrote (id/logged_at/created_at
    # included), so the session's new set list is what we already had plus that
    # one — no need to re-read a table we just wrote to, which is what the
    # second `_fetch_sets` inside _recompute_and_save used to do. Ordering
    # doesn't matter: _to_session_response sorts by (exercise_name, set_number)
    # on the way out regardless of what order it's given.
    inserted = (insert_result.data or [None])[0]
    sets = [*existing_sets, inserted] if inserted else None
    return await _recompute_and_save(
        supabase, session, user.id, sets=sets, weight_kg=weight_kg, cardio=cardio_by_session.get(session_id, [])
    )


@router.patch("/sets/{set_id}", response_model=WorkoutSessionResponse)
@_503_if_not_migrated
async def update_set(set_id: str, payload: WorkoutSetUpdate, user=Depends(get_current_user)):
    supabase = get_supabase()
    updates = {}
    if payload.exercise_name is not None:
        updates["exercise_name"] = payload.exercise_name.strip()
    if payload.category is not None:
        updates["category"] = payload.category
    if payload.reps is not None:
        updates["reps"] = payload.reps
    if payload.weight_kg is not None:
        updates["weight_kg"] = payload.weight_kg
    if payload.rpe is not None:
        updates["rpe"] = payload.rpe

    result = await run_in_threadpool(
        lambda: supabase.table("workout_sets").update(updates).eq("id", set_id).eq("user_id", user.id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Set not found")
    session = await _fetch_session_or_404(supabase, result.data[0]["session_id"], user.id)
    return await _recompute_and_save(supabase, session, user.id)


@router.delete("/sets/{set_id}", response_model=WorkoutSessionResponse)
@_503_if_not_migrated
async def delete_set(set_id: str, user=Depends(get_current_user)):
    """Returns the recomputed session (not a bare 204) — deleting a set
    always changes calories_burned/set numbering context the Workout
    Diary's active-session view is showing, so the caller needs the fresh
    session back rather than a second GET."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("workout_sets").delete().eq("id", set_id).eq("user_id", user.id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Set not found")
    session = await _fetch_session_or_404(supabase, result.data[0]["session_id"], user.id)
    return await _recompute_and_save(supabase, session, user.id)
@router.post("/sessions/{session_id}/cardio", response_model=WorkoutSessionResponse, status_code=201)
@limiter.limit("30/minute;6/10 seconds")
@_503_if_not_migrated
async def add_cardio(
    request: Request, response: Response, session_id: str, payload: CardioCreate, user=Depends(get_current_user)
):
    """Logs one cardio effort — possibly several segments — against an existing
    session, and returns the whole recomputed session, exactly as add_set does.

    Each segment is priced INDEPENDENTLY by services/cardio_service.py and the
    results are summed. That is the point of segments (Phase 3.5): a warm-up at
    5 km/h flat and twenty minutes at 6 km/h and 8% incline are physiologically
    different efforts, and pricing the average of them would understate the work
    by more than the warm-up was worth. Each segment keeps its own provenance,
    so a treadmill interval priced by the ACSM walking equation and an elliptical
    stretch priced from a MET band never get presented as equally certain.

    Bodyweight is resolved ONCE for the whole request and passed into every
    segment — it cannot change between a warm-up and a cool-down, and reading it
    per segment would be one Supabase round trip per interval.
    """
    supabase = get_supabase()
    session, weight_kg = await asyncio.gather(
        _fetch_session_or_404(supabase, session_id, user.id),
        _get_latest_weight_kg(supabase, user.id),
    )

    rows = []
    now = datetime.now(timezone.utc).isoformat()
    for segment in payload.segments:
        estimate = cardio_service.estimate_cardio(
            segment.machine, segment.params, weight_kg, segment.duration_minutes, net=payload.net
        )
        rows.append(
            {
                "user_id": user.id,
                "session_id": session_id,
                "machine": segment.machine.strip(),
                "params": segment.params,
                "duration_minutes": segment.duration_minutes,
                "calories_burned": estimate.kcal,
                "equation_id": estimate.equation_id,
                "is_estimate": estimate.is_estimate,
                "logged_at": now,
            }
        )

    await run_in_threadpool(lambda: supabase.table("cardio_sessions").insert(rows).execute())
    # The session's cached calories_burned now has to include these — that
    # recompute reads the cardio rows back itself, so it is correct whether this
    # session also has sets or is cardio-only.
    return await _recompute_and_save(supabase, session, user.id, weight_kg=weight_kg)


@router.delete("/cardio/{cardio_id}", response_model=WorkoutSessionResponse)
@_503_if_not_migrated
async def delete_cardio(cardio_id: str, user=Depends(get_current_user)):
    """Returns the recomputed session rather than a bare 204, for the same
    reason delete_set does: removing a cardio effort always changes the
    session's burn, so the caller needs the fresh session back, not a second
    GET."""
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("cardio_sessions").delete().eq("id", cardio_id).eq("user_id", user.id).execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Cardio entry not found")
    session = await _fetch_session_or_404(supabase, result.data[0]["session_id"], user.id)
    return await _recompute_and_save(supabase, session, user.id)
