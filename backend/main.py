import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from config import get_settings
from database import get_supabase
from rate_limit import limiter
from routers import account, ai_usage, analytics, barcode, coach, day, discover, foods, logs, meals, measurements, scan, targets, trends, water, weight, workouts
from services.cleanup_service import start_scheduler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")

settings = get_settings()

# Inert/no-op until you create a free Sentry project and set SENTRY_DSN — see
# config.py. Must run before the FastAPI app is constructed so its Starlette/
# FastAPI auto-instrumentation actually attaches. Backend-only: adding this to
# the frontend too would mean a new external CDN script and loosening the
# CSP's script-src, which isn't worth it for this pass.
if settings.sentry_dsn:
    import sentry_sdk

    sentry_sdk.init(dsn=settings.sentry_dsn, send_default_pii=False, traces_sample_rate=0.0)
    logger.info("Sentry error tracking enabled")


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler = start_scheduler()
    yield
    scheduler.shutdown()


app = FastAPI(
    title="Calorie & Macro Tracker API",
    description="Backend for an AI-assisted hypertrophy/macro tracking app.",
    version="1.0.0",
    lifespan=lifespan,
)

# --- Rate limiting: 120/min default per user everywhere, tightened further on
# routes that spend real money (AI endpoints) — see rate_limit.py ------------
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


# --- Catch-all for any exception no router explicitly handles -------------
# Every AI-calling route already wraps its own provider call in a narrow
# try/except (see routers/coach.py, scan.py) since it needs a feature-specific
# friendly message. Plain CRUD routes (measurements.py, meals.py, water.py,
# weight.py, targets.py, day.py, ...) don't — an unexpected failure there
# (e.g. a transient Supabase error) previously fell through to Starlette's
# own default: safe (no stack trace to the client, debug=False here) but
# inconsistent with this API's `{"detail": ...}` error shape everywhere else,
# and logged only via uvicorn's generic ASGI logger rather than this app's own
# `logger` (and therefore Sentry, when configured — see sentry_sdk.init above,
# whose FastAPI integration hooks in here too). Registered as `Exception`,
# not a narrower type, but Starlette's ExceptionMiddleware picks the most
# specific handler by walking the raised exception's MRO — HTTPException (and
# RateLimitExceeded above) still resolve to their own already-registered
# handlers and are unaffected by this.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error. Please try again."})

# --- CORS: only the configured frontend origins may call this API. Explicit
# methods/headers (not "*") and no credentials — the frontend authenticates
# with a Bearer token in the Authorization header, never cookies, so there's
# nothing for allow_credentials to legitimately widen access to. ------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# --- Compress JSON responses (list endpoints in particular) ----------------
app.add_middleware(GZipMiddleware, minimum_size=500)

# Comfortably covers /scan's 8MB image cap plus multipart overhead — every
# other route's payload is a small JSON body, nowhere close to this.
MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024


# --- Reject oversized uploads by their declared size before the body is ever
# read, not after. This matters specifically for POST /scan's image upload:
# Starlette's multipart parser has no size cap on file parts at all (only
# non-file form fields get one — confirmed by reading formparsers.py), so
# routers/scan.py's own MAX_IMAGE_BYTES check only ever runs *after*
# Starlette has already fully received and spooled the file to disk/memory.
# A middleware is the only place early enough to actually stop that — it
# runs before FastAPI's routing/dependency layer touches the body at all.
# This can't catch a request that lies about or omits Content-Length while
# streaming unbounded data via chunked transfer (an inherent limit of a
# Content-Length-based check), but it comfortably covers this app's actual
# clients — browser fetch() with FormData always sets it correctly — at
# zero cost to every normal, correctly-sized request. -----------------------
@app.middleware("http")
async def limit_request_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_REQUEST_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body too large"})
    return await call_next(request)


# --- Baseline security headers on every response ----------------------------
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Harmless on plain-HTTP local dev (browsers only honor HSTS over HTTPS);
    # meaningful once deployed, where Render terminates TLS in front of this.
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # This API is never meant to be embedded/loaded as a subresource of
    # another origin's document context (it's a pure JSON API, not a page) —
    # these three lock that down at the process-isolation level, on top of
    # X-Frame-Options above. Belt-and-suspenders with the frontend's own CSP
    # (frame-ancestors 'none' in index.html) rather than a substitute for it —
    # see that file's comments on why a <meta> CSP can't actually enforce
    # frame-ancestors itself (GitHub Pages serves static files with no way to
    # set custom response headers, so this backend is the only place in the
    # whole stack that reliably can).
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["X-Permitted-Cross-Domain-Policies"] = "none"
    # No route on this API ever needs camera/microphone/geolocation/payment —
    # those are frontend-only concerns (the browser's own camera access for
    # AI/barcode scanning happens entirely client-side, never proxied through
    # this backend), so deny them all explicitly rather than leaving every
    # permission at the browser default of "allowed".
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
    )
    return response


# --- Routers -----------------------------------------------------------------
app.include_router(account.router)
app.include_router(targets.router)
app.include_router(scan.router)
app.include_router(barcode.router)
app.include_router(logs.router)
app.include_router(meals.router)
app.include_router(water.router)
app.include_router(weight.router)
app.include_router(measurements.router)
app.include_router(workouts.router)
app.include_router(trends.router)
app.include_router(analytics.router)
app.include_router(coach.router)
app.include_router(day.router)
app.include_router(foods.router)
app.include_router(discover.router)
app.include_router(ai_usage.router)


@app.get("/", tags=["health"])
async def health_check():
    """Fast, dependency-free liveness ping — this is what the frontend's
    warmBackend() hits on every page load to wake a sleeping free-tier
    instance, so it must never do real work (no DB call, and definitely no
    Gemini call — see GET /health below for why not)."""
    return {"status": "ok", "service": "calorie-tracker-api"}


@app.get("/health", tags=["health"])
# Burst clause alongside the sustained one — same reasoning as the
# rate_limit.py comment: a route-level limit here replaces (not adds to) the
# app-wide burst default, and this is the one unauthenticated route that does
# real Supabase work, making it the most exposed target for a flood.
@limiter.limit("20/minute;5/10 seconds")
async def health_check_deep(request: Request, response: Response):
    """A real readiness check: verifies Supabase is actually reachable.
    Deliberately does NOT call Gemini — this endpoint is meant to be hit
    frequently by uptime monitoring, and a Gemini call on every ping would
    burn the shared daily quota (see services/quota_service.py) for nothing.

    Explicitly rate-limited (on top of the app-wide default) since, unlike
    almost every other route, this one is both unauthenticated and does real
    work (an actual Supabase query) on every hit — 20/minute per IP is far
    above any legitimate uptime monitor's ping interval, but still a real
    ceiling instead of leaving this the one route with no route-specific
    guard at all.

    `response: Response` is required by every @limiter.limit(...) route —
    see rate_limit.py's "SECOND gotcha" comment. Without it this route
    500'd on every call (both "ok" and "degraded" are still 2xx responses),
    so uptime monitoring was getting a 500 on every ping instead of a
    meaningful health signal until this fix."""
    try:
        await run_in_threadpool(lambda: get_supabase().table("profiles").select("id").limit(1).execute())
        database_status = "ok"
    except Exception:
        logger.exception("Health check: Supabase query failed")
        database_status = "error"

    overall = "ok" if database_status == "ok" else "degraded"
    return {"status": overall, "database": database_status}
