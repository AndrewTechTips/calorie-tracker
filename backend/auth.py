from fastapi import Header, HTTPException, status
from fastapi.concurrency import run_in_threadpool

from database import get_supabase_anon


async def get_current_user(authorization: str | None = Header(default=None)):
    """FastAPI dependency: expects `Authorization: Bearer <supabase_access_token>`.

    The frontend gets this token from `supabase.auth.getSession()` after the user
    logs in via Supabase Auth, and sends it on every API call. We verify it here
    against Supabase itself — the backend never issues or trusts its own tokens.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )

    token = authorization.removeprefix("Bearer ").strip()

    try:
        # This runs on every single authenticated request in the app, so it
        # must not block the event loop while it does. get_supabase_anon() is
        # a synchronous httpx.Client (see database.py) — every other Supabase
        # call in this codebase is wrapped in run_in_threadpool for the same
        # reason; this dependency was the one exception.
        response = await run_in_threadpool(lambda: get_supabase_anon().auth.get_user(token))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session, please log in again",
        )

    if response is None or response.user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session, please log in again",
        )

    return response.user  # .id, .email available


def get_client_ip(request) -> str:
    """The real visitor IP behind the reverse proxy.

    Traefik terminates TLS at the edge and forwards to this container over an
    internal Docker network (see docker-compose.yml), and uvicorn is NOT
    started with `--proxy-headers` (see backend/Dockerfile's CMD), so
    `request.client.host` is Traefik's container IP on every request, not the
    visitor's, unless `X-Forwarded-For` is read explicitly.

    Only the RIGHT-MOST entry is trusted: that is the one our own proxy
    appended just before forwarding to us. Anything to its left is whatever
    the original client (or an earlier untrusted hop) put there themselves —
    trusting the *first* entry would let a client simply lie about its own IP
    in a header it fully controls.

    This assumes exactly ONE trusted proxy hop, which is what the VPS stack
    has (Traefik, talking straight to the internet). It was written for
    Render's edge originally and the logic carried over unchanged because the
    shape is identical — but it would need adjusting if a second hop were ever
    added in front, e.g. putting Cloudflare or another CDN ahead of Traefik,
    since the right-most entry would then be Cloudflare's IP rather than the
    visitor's.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def rate_limit_key(request) -> str:
    """slowapi key function for the routes that intentionally rate-limit per
    *authenticated user* rather than per IP — the two Gemini-costing routes
    (POST /scan, /scan/describe) and the food-name-change path on
    PATCH /logs/{id}, so users behind the same NAT/office network don't share
    that tight a bucket. Safe to key off the raw, unverified bearer-token
    string here specifically because slowapi's per-route `@limiter.limit(...)`
    decorator only ever runs *after* FastAPI has already resolved
    `Depends(get_current_user)` for that same request — an invalid token
    never reaches this key function at all, it 401s first. (This is NOT true
    of the app-wide default limit below, which is why that one is IP-based
    instead — see get_client_ip's docstring.)"""
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.removeprefix("Bearer ").strip()
    return get_client_ip(request)
