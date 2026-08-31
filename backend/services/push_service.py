import json
import logging

from pywebpush import WebPushException, webpush

from config import get_settings
from database import get_supabase

logger = logging.getLogger("push_service")

# Push services return 410 Gone for a subscription the browser itself has
# permanently torn down (uninstall, permission revoked, browser storage
# cleared) and, less commonly, 404 for one it never recognized at all (e.g.
# a stale endpoint from a push service that's since rotated its URL scheme).
# 403 means the push service rejected our VAPID auth *for this endpoint* —
# an endpoint minted under a different (old) applicationServerKey, or one
# that simply isn't ours to message; permanent from our side either way.
# All three mean the same thing to us: this row will never succeed again,
# ever — see send_to_subscription's own doc for why deleting it immediately
# (rather than retrying or waiting for a manual cleanup pass) is what keeps
# push_subscriptions from bloating with rows that can never be delivered to,
# and — the reason this matters for the duplicate-notification bug — stops a
# dead endpoint firing alongside the same device's live one.
_DEAD_SUBSCRIPTION_STATUS = {403, 404, 410}


def dedupe_subscriptions(subscriptions: list[dict]) -> list[dict]:
    """Collapses a user's push_subscriptions rows to one send target per
    physical device, so a single reminder can never fan out to the same
    device twice.

    Defense-in-depth on top of the DB's own (user_id, device_id) partial
    unique index + globally-unique endpoint: a table that predates
    `device_id`, or one briefly racing an endpoint rotation, could still hold
    two rows for one device. Keeps the most-recently-seen row per
    `device_id`; rows with no `device_id` (written by an older client) are
    de-duplicated by `endpoint` only, and a real `device_id` row always wins
    over a stray no-`device_id` row that happens to share its endpoint.
    """
    by_device: dict[str, dict] = {}
    no_device: dict[str, dict] = {}
    for sub in subscriptions:
        device_id = sub.get("device_id")
        if device_id:
            incumbent = by_device.get(device_id)
            if incumbent is None or (sub.get("last_seen_at") or "") >= (incumbent.get("last_seen_at") or ""):
                by_device[device_id] = sub
        else:
            no_device.setdefault(sub["endpoint"], sub)
    kept_endpoints = {sub["endpoint"] for sub in by_device.values()}
    return list(by_device.values()) + [sub for endpoint, sub in no_device.items() if endpoint not in kept_endpoints]

# TTL (seconds) a push service will hold a notification for an offline
# device before giving up — a day is generous for "come back and log" copy
# (nothing here is time-critical to the minute) without holding truly stale
# reminders indefinitely.
_PUSH_TTL_SECONDS = 86400


def _vapid_claims() -> dict:
    return {"sub": get_settings().vapid_admin_email}


def send_to_subscription(subscription: dict, payload: dict) -> bool:
    """Sends one Web Push message to one subscription row (a dict with at
    least endpoint/p256dh/auth_key/id/user_id — see the push_subscriptions
    table). Returns True on success, False on any failure.

    Self-cleaning: a 404/410 response means the push service itself is
    telling us this endpoint will never accept another message (see
    _DEAD_SUBSCRIPTION_STATUS above) — deleting it here, inline with the
    send, is what satisfies "the database does not bloat with dead push
    subscriptions" without needing a separate sweep job that could otherwise
    let a growing pile of dead rows sit around between runs.
    """
    settings = get_settings()
    if not settings.vapid_configured:
        logger.warning("send_to_subscription called but VAPID keys aren't configured — skipping")
        return False

    try:
        webpush(
            subscription_info={
                "endpoint": subscription["endpoint"],
                "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth_key"]},
            },
            data=json.dumps(payload),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims=_vapid_claims(),
            ttl=_PUSH_TTL_SECONDS,
        )
        get_supabase().table("push_subscriptions").update({"last_seen_at": "now()"}).eq(
            "id", subscription["id"]
        ).execute()
        return True
    except WebPushException as exc:
        status_code = exc.response.status_code if exc.response is not None else None
        if status_code in _DEAD_SUBSCRIPTION_STATUS:
            logger.info("Dead push subscription %s (status %s) — deleting", subscription["id"], status_code)
            get_supabase().table("push_subscriptions").delete().eq("id", subscription["id"]).execute()
        else:
            logger.warning("Push send failed for subscription %s: %s", subscription["id"], exc)
        return False
    except Exception:
        logger.exception("Unexpected error sending push to subscription %s", subscription["id"])
        return False


def send_to_user(user_id: str, payload: dict) -> int:
    """Sends `payload` once per device this user has subscribed on (a user
    can have several — phone, laptop, ...). Returns how many sends
    succeeded; a partial failure (one dead device among several) is normal
    and not logged as an error at this level — send_to_subscription already
    handles/logs each one individually.

    Rows are run through dedupe_subscriptions first: the single choke point
    that guarantees one notification per device even if the table briefly
    holds a rotation duplicate."""
    subscriptions = (
        get_supabase().table("push_subscriptions").select("*").eq("user_id", user_id).execute().data or []
    )
    return sum(1 for sub in dedupe_subscriptions(subscriptions) if send_to_subscription(sub, payload))
