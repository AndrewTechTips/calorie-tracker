from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All secrets/config are read from environment variables (or a local .env
    file in development). Nothing sensitive is ever hardcoded here."""

    supabase_url: str
    supabase_service_key: str
    supabase_anon_key: str
    # Primary/legacy single-key var — still required so an existing
    # single-key deployment's .env keeps working with zero changes.
    gemini_api_key: str
    # Additional keys for the multi-key routing pool (see gemini_keys below
    # and services/quota_service.py), comma-separated, e.g.
    # "key2,key3" — do NOT repeat gemini_api_key here, it's folded in
    # automatically as the first/highest-priority key. Blank (the default)
    # means "just the one key in gemini_api_key", identical to this app's
    # behavior before multi-key support existed.
    gemini_api_keys: str = ""
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
    # The no-photo "describe what I ate" path (routers/scan.py's POST
    # /scan/describe) needs real reasoning too — inferring composition *and*
    # portion weight from free text is comparable in complexity to the vision
    # call, not the zero-budget "simple lookup" estimate_macros_for_food_name
    # does for a single already-known food name at a given weight. Set lower
    # than the vision budget since there's no image to reason over, just text.
    gemini_description_thinking_budget: int = 512

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

    @property
    def gemini_keys(self) -> list[str]:
        """Ordered, de-duplicated pool of Gemini API keys — gemini_api_key
        always comes first (it's "key1" in every priority-ordered log message
        and in the multi-key routing algorithm's docs — see
        services/quota_service.py), followed by whichever additional keys
        gemini_api_keys lists, in the order given. A key repeated in both
        settings (or listed twice within gemini_api_keys) is only kept once,
        at its first/highest-priority position, so a copy-paste mistake in
        the env var can't silently double that key's effective quota."""
        keys = [self.gemini_api_key.strip()] if self.gemini_api_key.strip() else []
        for raw in self.gemini_api_keys.split(","):
            key = raw.strip()
            if key and key not in keys:
                keys.append(key)
        return keys


@lru_cache
def get_settings() -> Settings:
    return Settings()
