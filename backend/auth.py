from fastapi import Header, HTTPException, status

from .database import get_supabase_anon


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
        response = get_supabase_anon().auth.get_user(token)
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


def rate_limit_key(request) -> str:
    """slowapi key function — rate-limit per authenticated user, not per IP,
    so users behind the same NAT/office network don't share a limit bucket."""
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header.removeprefix("Bearer ").strip()
    return request.client.host if request.client else "anonymous"
