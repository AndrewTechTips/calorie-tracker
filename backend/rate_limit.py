from slowapi import Limiter

from auth import get_client_ip

# Single shared limiter instance for the whole app. Every route gets the
# generous default unless it explicitly overrides it (see routers/scan.py and
# the AI-triggering path in routers/logs.py, both capped lower since they
# spend real money on Gemini API calls, and both override this default
# key_func back to auth.rate_limit_key — see that function's docstring for
# why that's safe for them specifically). 120/minute is far above any real
# usage pattern this app has (the dashboard fires at most ~4 parallel GETs on
# load) — it exists to stop a runaway client/script, not to throttle people.
#
# key_func is IP-based (not per-user) here specifically because this default
# is enforced by SlowAPIMiddleware at the ASGI layer, *before* FastAPI ever
# resolves Depends(get_current_user) for a given route. A per-user key here
# would let anyone bypass this entire default limit by simply sending a
# different Authorization header value on every request — no valid session
# required to get a fresh bucket each time, since nothing validates the token
# before it's used as the key. IP-based can't be sidestepped the same way.
limiter = Limiter(key_func=get_client_ip, default_limits=["120/minute"])
