import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from config import get_settings
from database import get_supabase
from rate_limit import limiter
from routers import barcode, day, logs, meals, measurements, scan, targets, trends, water, weight
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
async def health_check_deep():
    """A real readiness check: verifies Supabase is actually reachable.
    Deliberately does NOT call Gemini — this endpoint is meant to be hit
    frequently by uptime monitoring, and a Gemini call on every ping would
    burn the shared daily quota (see services/quota_service.py) for nothing."""
    try:
        await run_in_threadpool(lambda: get_supabase().table("profiles").select("id").limit(1).execute())
        database_status = "ok"
    except Exception:
        logger.exception("Health check: Supabase query failed")
        database_status = "error"

    overall = "ok" if database_status == "ok" else "degraded"
    return {"status": overall, "database": database_status}
