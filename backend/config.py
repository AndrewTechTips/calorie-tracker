from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All secrets/config are read from environment variables (or a local .env
    file in development). Nothing sensitive is ever hardcoded here."""

    supabase_url: str
    supabase_service_key: str
    supabase_anon_key: str
    gemini_api_key: str
    allowed_origins: str = "http://localhost:5173"

    # --- Gemini model selection -------------------------------------------
    # Swapping models (e.g. after buying paid-tier credits) is a pure config
    # change — no code edits needed. gemini_fallback_model is optional: leave
    # it blank to disable failover entirely (single-model behavior, as before).
    gemini_model: str = "gemini-flash-lite-latest"
    gemini_fallback_model: str = ""
    # Thinking gives the model private reasoning tokens to verify arithmetic
    # (calories vs 4P+4C+9F) before it commits to the final JSON, at a small,
    # capped token cost. 0 disables it. Only applied to the vision call — the
    # text-only re-estimate is a simple lookup that doesn't need it.
    gemini_vision_thinking_budget: int = 1024

    # --- Data retention ----------------------------------------------------
    # Rolling window, not a calendar week: a row is purged once it's this many
    # days old, same mechanism as before (see services/cleanup_service.py),
    # just a bigger number. Keep this in sync with the interval baked into
    # sql/schema.sql's cleanup_old_logs() if you change it.
    retention_days: int = 7

    # --- Shared Gemini quota guard -------------------------------------------
    # This app runs on a single free-tier Gemini API key shared by every user
    # until paid credits are purchased. gemini_daily_quota is a soft cap this
    # backend enforces itself so a burst of scans fails with one clear,
    # friendly message instead of everyone hitting Google's own rate-limit
    # error independently. There's no way to hardcode "the" free-tier number
    # here — it varies by model and Google can change it — so check your
    # actual quota in Google AI Studio for gemini_model and set this to
    # something comfortably under it (this default is a placeholder).
    gemini_daily_quota: int = 1000

    # --- Optional integrations (all inert/no-op when left blank) ------------
    # Note: there is no Turnstile setting here — CAPTCHA verification for
    # signup happens entirely inside Supabase Auth (configured in the
    # Supabase dashboard with its own secret key), never touching this
    # backend. Only the public Turnstile *site* key lives in the frontend
    # (frontend/js/config.js) — see frontend/js/auth.js.
    sentry_dsn: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
