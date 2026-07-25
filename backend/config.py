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

    # --- Gemini model selection & smart routing -----------------------------
    # Ordered candidate list, highest priority first. Each entry is a bare
    # model name (falls back to gemini_model_rpm/rpd below) or "name:rpm:rpd"
    # for its own limit — free-tier quotas vary wildly by model (see
    # `api_limits`, repo root; verify yours in Google AI Studio, these can
    # differ by project/region). services/quota_service.py tracks live usage
    # and routes to the first candidate with headroom *before* each call
    # instead of waiting for a 429; gemini_service.py's reactive failover
    # (429/404/etc.) is the backup for when that check and Google disagree.
    #
    # The default list is tiered by quota AND accuracy: two independent
    # Flash-Lite models (~500 RPD/15 RPM each) carry real traffic and roughly
    # double capacity vs. one; four regular Flash variants absorb overflow at
    # a smaller quota but *better* accuracy; a second Flash-Lite is the last
    # resort. Models this account shows as 0/0 (unavailable) are excluded —
    # routing to one would just waste an attempt.
    gemini_models: str = (
        "gemini-flash-lite-latest:12:480,"
        "gemini-3.1-flash-lite:12:480,"
        "gemini-3.6-flash:4:18,"
        "gemini-3.5-flash:4:18,"
        "gemini-3-flash:4:18,"
        "gemini-2.5-flash:4:18,"
        "gemini-2.5-flash-lite:8:18"
    )
    # Fallback RPM/RPD used only for a *bare* model name added to
    # gemini_models above without its own "name:rpm:rpd" limits.
    gemini_model_rpm: int = 12
    gemini_model_rpd: int = 480
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
