import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from config import get_settings
from rate_limit import limiter
from routers import logs, meals, scan, targets, water
from services.cleanup_service import start_scheduler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler = start_scheduler()
    yield
    scheduler.shutdown()


settings = get_settings()

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
app.include_router(logs.router)
app.include_router(meals.router)
app.include_router(water.router)


@app.get("/", tags=["health"])
async def health_check():
    return {"status": "ok", "service": "calorie-tracker-api"}
