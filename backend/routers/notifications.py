from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool

from auth import get_current_user
from config import get_settings
from database import get_supabase
from models import NotificationPreferences, PushSubscriptionCreate, PushUnsubscribe
from rate_limit import limiter
from services.notification_copy import notification_text
from services.push_service import send_to_user

router = APIRouter(prefix="/notifications", tags=["notifications"])

_DEFAULT_PREFERENCES = NotificationPreferences().model_dump()


@router.post("/subscribe", status_code=204)
async def subscribe(payload: PushSubscriptionCreate, user=Depends(get_current_user)):
    """Registers (or re-registers) one browser/device for this user. Upserts
    on `endpoint` — the browser's own per-registration URL, globally unique
    by construction (see sql/schema.sql's push_subscriptions comment) — so a
    resubscribe (e.g. the browser rotating keys via its own
    `pushsubscriptionchange` event) updates the existing row instead of
    piling up a duplicate. Deliberately does NOT touch
    notification_preferences.push_enabled — the frontend flips that
    separately via PUT /preferences right after a successful subscribe, so
    "have I granted a subscription" and "does the user currently want pushes"
    stay two independent facts (a user can hold a live subscription while
    push is toggled off, and get it back on without a fresh permission
    prompt)."""
    supabase = get_supabase()
    row = {
        "user_id": user.id,
        "endpoint": payload.endpoint,
        "p256dh": payload.keys.p256dh,
        "auth_key": payload.keys.auth,
        "user_agent": payload.user_agent,
        "last_seen_at": "now()",
    }
    await run_in_threadpool(lambda: supabase.table("push_subscriptions").upsert(row, on_conflict="endpoint").execute())
    return None


@router.delete("/subscribe", status_code=204)
async def unsubscribe(payload: PushUnsubscribe, user=Depends(get_current_user)):
    """Best-effort: the frontend calls this both on an explicit "turn off
    notifications" action and opportunistically whenever it detects its own
    subscription is no longer valid. Scoped to `.eq("user_id", user.id)` on
    top of the endpoint match — endpoint is already globally unique, but this
    keeps the ownership-filter discipline CLAUDE.md requires on every query
    against the service-role client, rather than relying on uniqueness
    alone."""
    supabase = get_supabase()
    await run_in_threadpool(
        lambda: supabase.table("push_subscriptions").delete().eq("endpoint", payload.endpoint).eq("user_id", user.id).execute()
    )
    return None


@router.get("/preferences", response_model=NotificationPreferences)
async def get_preferences(user=Depends(get_current_user)):
    supabase = get_supabase()
    result = await run_in_threadpool(
        lambda: supabase.table("notification_preferences").select("*").eq("user_id", user.id).maybe_single().execute()
    )
    data = (result.data if result else None) or {}
    # Falls back to defaults rather than 404ing: sql/schema.sql's trigger
    # auto-creates this row for every new signup, but an account that
    # existed before this migration ran only gets one from the one-time
    # backfill statement in that same migration — if that hasn't been
    # (re-)run yet on this Supabase project, this keeps the endpoint working
    # instead of erroring for those users.
    return {**_DEFAULT_PREFERENCES, **data}


@router.put("/preferences", response_model=NotificationPreferences)
async def update_preferences(payload: NotificationPreferences, user=Depends(get_current_user)):
    supabase = get_supabase()
    row = {"user_id": user.id, **payload.model_dump(), "updated_at": "now()"}
    await run_in_threadpool(
        lambda: supabase.table("notification_preferences").upsert(row, on_conflict="user_id").execute()
    )
    return payload


@router.post("/test", status_code=200)
@limiter.limit("5/minute;2/10 seconds")
async def send_test_notification(request: Request, response: Response, language: str = "en", user=Depends(get_current_user)):
    """Settings → Notifications' "send yourself a test" button — the
    fastest way for a user to confirm push actually reaches their device
    without waiting for a real reminder to come due. Rate-limited tighter
    than this API's app-wide default since, unlike the CRUD routes above,
    this one has a real external side effect (an actual push service call)
    per request.

    `language` is a query param the frontend fills with its own current UI
    language (same `?language=` convention as GET /coach/weekly-recap) —
    simpler than a second DB read of notification_preferences.language just
    to answer "which language is this specific button click in", and always
    correct even for a language switch that hasn't been saved yet."""
    settings = get_settings()
    if not settings.vapid_configured:
        raise HTTPException(status_code=503, detail="Push notifications aren't configured on this server")
    lang = "ro" if language == "ro" else "en"
    title, body = notification_text(lang, "test")
    sent = await run_in_threadpool(
        lambda: send_to_user(user.id, {"title": title, "body": body, "url": "/", "tag": "test"})
    )
    if sent == 0:
        raise HTTPException(status_code=404, detail="No active push subscriptions found for this device/account")
    return {"sent": sent}
