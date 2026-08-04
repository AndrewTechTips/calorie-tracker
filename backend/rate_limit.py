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
#
# --- "Smart" burst-vs-abuse shape -------------------------------------------
# Two limits are combined here on purpose, not just one:
#   - "120/minute" is the sustained ceiling (unchanged from before).
#   - "20/second" is a burst ceiling. A real browser session never needs it —
#     even the dashboard's worst case (~4 parallel GETs on load, occasionally
#     doubled by a fast tab-switch re-render) sits far under it — but it's
#     what actually stops a 1000 req/sec flood: without it, that flood would
#     freely burn through the entire 120/minute budget in well under a
#     second and then sit "successfully rate limited" for the rest of the
#     minute, having already gotten ~120x the intended damage in through the
#     door. The burst ceiling caps how much damage a single instant of abuse
#     can do, independent of the sustained one.
# `strategy="moving-window"` (limits' in-memory moving-window algorithm, no
# Redis/extra infra needed) matters for the same reason: the default
# "fixed-window" strategy resets its counter on the clock (e.g. every :00),
# so a client can send a full window's worth of requests at 0:59 and another
# full window's worth at 1:00 — two allowances back-to-back, effectively
# doubling any limit right at the boundary. Moving-window tracks a true
# rolling window per key instead, so "120/minute" and "20/second" both mean
# what they say at every instant, not just measured from an arbitrary clock
# tick. `headers_enabled=True` sends X-RateLimit-*/Retry-After response
# headers so a well-behaved client (or our own frontend) can see it's close
# to a limit and back off gracefully instead of just getting a bare 429 —
# "invisible to legitimate users" in practice, since no real usage pattern
# here gets anywhere near either ceiling.
#
# IMPORTANT for anyone adding a new @limiter.limit(...) route override: slowapi
# routes with their own decorator are skipped by the middleware entirely (see
# SlowAPIMiddleware._should_exempt in slowapi/middleware.py — "there is a
# decorator for this route, we let the decorator handle it") and, by default
# (override_defaults=True), a decorator's limit string *replaces* the two
# defaults above rather than adding to them. Every existing per-route override
# in this codebase (routers/scan.py, logs.py, barcode.py) already re-states
# its own burst clause for exactly this reason — copy that pattern
# ("<sustained>/minute;<burst>/10 seconds") rather than a single bare
# "N/minute", or that route silently loses the flood-burst protection below.
#
# SECOND gotcha, specific to headers_enabled=True (below) combined with
# key_func=rate_limit_key (auth.py): any route using that key_func MUST also
# declare a `response: Response` parameter in its own signature (FastAPI's
# built-in "mutate the response object directly" pattern), even though the
# route already returns a Pydantic model via response_model=. Without it,
# slowapi's post-call header injection has nothing to write X-RateLimit-*
# headers onto and raises "parameter `response` must be an instance of
# starlette.responses.Response" on every *successful* (2xx) call — never on
# an error path, which is exactly why this is easy to miss in testing. See
# routers/logs.py::correct_log and both routes in routers/scan.py for the
# fix in practice. Routes using the plain default key_func (e.g.
# routers/barcode.py) are not affected by this specific gotcha.
limiter = Limiter(
    key_func=get_client_ip,
    default_limits=["120/minute", "20/second"],
    strategy="moving-window",
    headers_enabled=True,
)
