import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
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
from routers import barcode, day, logs, meals, measurements, scan, targets, trends, water, weight, workouts
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
    return response


# --- Routers -----------------------------------------------------------------
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
app.include_router(day.router)


@app.get("/", tags=["health"])
async def health_check():
    """Fast, dependency-free liveness ping — this is what the frontend's
    warmBackend() hits on every page load to wake a sleeping free-tier
    instance, so it must never do real work (no DB call, and definitely no
    Gemini call — see GET /health below for why not)."""
    return {"status": "ok", "service": "calorie-tracker-api"}


@app.get("/health", tags=["health"])
@limiter.limit("20/minute")
async def health_check_deep(request: Request):
    """A real readiness check: verifies Supabase is actually reachable.
    Deliberately does NOT call Gemini — this endpoint is meant to be hit
    frequently by uptime monitoring, and a Gemini call on every ping would
    burn the shared daily quota (see services/quota_service.py) for nothing.

    Explicitly rate-limited (on top of the app-wide default) since, unlike
    almost every other route, this one is both unauthenticated and does real
    work (an actual Supabase query) on every hit — 20/minute per IP is far
    above any legitimate uptime monitor's ping interval, but still a real
    ceiling instead of leaving this the one route with no route-specific
    guard at all."""
    try:
        await run_in_threadpool(lambda: get_supabase().table("profiles").select("id").limit(1).execute())
        database_status = "ok"
    except Exception:
        logger.exception("Health check: Supabase query failed")
        database_status = "error"

    overall = "ok" if database_status == "ok" else "degraded"
    return {"status": overall, "database": database_status}
