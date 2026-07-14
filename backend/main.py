import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from .config import get_settings
from .routers import logs, meals, scan, targets, water
from .routers.scan import limiter
from .services.cleanup_service import start_scheduler

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

# --- Rate limiting (10 req/min per user on the AI endpoint) -----------------
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# --- CORS: only the configured frontend origins may call this API ----------
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Routers -----------------------------------------------------------------
app.include_router(targets.router)
app.include_router(scan.router)
app.include_router(logs.router)
app.include_router(meals.router)
app.include_router(water.router)


@app.get("/", tags=["health"])
async def health_check():
    return {"status": "ok", "service": "calorie-tracker-api"}
