from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All secrets/config are read from environment variables (or a local .env
    file in development). Nothing sensitive is ever hardcoded here."""

    supabase_url: str
    supabase_service_key: str
    supabase_anon_key: str
    # Gemini is now vision-only (see "Task-based AI routing" below) — a
    # single key, no more multi-key pooling. Text/JSON/chat tasks route
    # through the OpenAI-compatible providers below instead.
    gemini_api_key: str
    allowed_origins: str = "http://localhost:5173"

    # --- Task-based AI routing (non-Gemini providers) -----------------------
    # Both are OpenAI-compatible endpoints, called via openai.AsyncClient
    # with a provider-specific base_url (see services/gemini_service.py's
    # provider client constructors). Each is optional (blank = that provider
    # is skipped in its task's fallback chain) so a partially-configured
    # .env degrades gracefully rather than hard-failing at startup.
    #
    # Task A (vision/food-photo scanning): Gemini primary (gemini_api_key
    # above, own multi-model cycle — see gemini_models below), NVIDIA NIM
    # fallback only if Gemini's whole model chain is exhausted/erroring.
    # Task B (text/JSON — macro re-estimation, meal suggestions, text
    # descriptions) and Task C (conversational — coach chat, weekly recap,
    # damage control) both go Groq -> native-Gemini last resort (see
    # gemini_text_models below) — every provider here cycles its OWN
    # ordered list of models too (not just one model each), same principle
    # as Gemini's own multi-model chain: each model has an independent
    # quota pool, so falling through several models before giving up on a
    # provider uses vastly more of its real daily capacity than picking one
    # model and stopping. Groq is the only one of these with officially
    # published per-model hard limits (groq_models below, verified against
    # console.groq.com/docs/rate-limits).
    #
    # Cerebras and Chutes were tried and deliberately removed — both
    # required funding a billing balance to actually serve any request (a
    # 402 on every call while unfunded), which defeats the point of a free
    # fallback tier, and the user chose not to fund them. The native-Gemini
    # fallback below replaced their role in the chain instead.
    groq_api_key: str = ""
    nvidia_api_key: str = ""

    # Groq's own multi-model priority list — quality-tiered THEN quota-
    # depth-tiered, mirroring gemini_models' "name:rpm:rpd" format exactly
    # (services/quota_service.py's provider/model cycling is fully generic
    # now, shared by both Gemini and Groq). Verified against Groq's official
    # rate-limits page (console.groq.com/docs/rate-limits) as of 2026-08:
    # llama-3.3-70b-versatile/gpt-oss-120b/qwen3.6-27b/gpt-oss-20b all sit at
    # 30 RPM / 1,000 RPD (roughly comparable quality/general-purpose
    # capability, each its own independent pool — trying all four before
    # giving up on Groq is ~4x one model's daily capacity at full quality).
    # llama-3.1-8b-instant is meaningfully weaker but gets 30 RPM / 14,400
    # RPD — kept LAST, as a high-volume safety valve once the quality tier's
    # combined ~4,000 RPD is actually exhausted, not a default choice.
    # Deliberately excludes groq/compound(-mini) (agentic/tool-calling
    # systems, not a fit for this app's strict single-turn JSON contract)
    # and whisper/prompt-guard/orpheus/safeguard models (wrong modality —
    # audio, safety-classification, or TTS, not general text generation).
    groq_models: str = (
        "llama-3.3-70b-versatile:30:1000,"
        "openai/gpt-oss-120b:30:1000,"
        "qwen/qwen3.6-27b:30:1000,"
        "openai/gpt-oss-20b:30:1000,"
        "llama-3.1-8b-instant:30:14400"
    )
    # Fallback RPM/RPD for a *bare* model name added to groq_models above
    # without its own "name:rpm:rpd" (mirrors gemini_model_rpm/rpd below).
    groq_model_rpm: int = 30
    groq_model_rpd: int = 1000

    # NVIDIA model list — ordered by quality, not quota (NVIDIA doesn't
    # publish a reliable per-model number worth encoding as a proactive
    # gate). The account's real catalog was verified via NVIDIA's own GET
    # /v1/models during live testing — re-verify there before changing
    # this, a stale name just costs one wasted round-trip (falls through to
    # the next model) unless it's the LAST entry, same caveat gemini_models'
    # own comment describes.
    #
    # Vision-capable NVIDIA NIM model(s). z-ai/glm-5.2 verified live (fast,
    # correct, honors the invalid_input contract). meta/llama-3.2-90b-
    # vision-instruct was also tried as a second tier and timed out after
    # 40s+ (likely a cold-start NIM model) — deliberately excluded, since a
    # 40-second hang on this app's last-resort vision fallback would be far
    # worse for a mobile client than just failing that one request.
    nvidia_vision_models: str = "z-ai/glm-5.2"

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
    # double capacity vs. one; two regular Flash variants absorb overflow at
    # a smaller quota but *better* accuracy. Models this account shows as
    # 0/0 (unavailable) are excluded — routing to one would just waste an
    # attempt. Previously also listed gemini-3-flash, gemini-2.5-flash, and
    # gemini-2.5-flash-lite as further fallbacks, but as of 2026-08 all three
    # 404 outright for this account/project (the 2.5 pair explicitly
    # "no longer available to new users" per the API's own error message;
    # gemini-3-flash was never a valid model id here). 404 is in
    # RETRYABLE_STATUS_CODES so a dead entry mid-list is harmless (just a
    # wasted round-trip before the next candidate), but the last one in
    # priority order is NOT harmless: if every working model's RPM briefly
    # runs dry under a burst of requests, the walk-through-candidates
    # fallback in gemini_service.py::_generate_content reaches the final
    # entry with nothing left to fail over to, and a guaranteed-404 there
    # surfaces as a real, user-facing 500 instead of a retry. Re-verify in
    # Google AI Studio before re-adding any retired model back to this list.
    gemini_models: str = (
        "gemini-flash-lite-latest:12:480,"
        "gemini-3.1-flash-lite:12:480,"
        "gemini-3.6-flash:4:18,"
        "gemini-3.5-flash:4:18"
    )
    # Fallback RPM/RPD used only for a *bare* model name added to
    # gemini_models above without its own "name:rpm:rpd" limits.
    gemini_model_rpm: int = 12
    gemini_model_rpd: int = 480

    # Task B/C's TRUE last-resort fallback, only reached once Groq's entire
    # model chain has failed (see gemini_service._call_openai_compatible's
    # gemini_native_fallback param). Uses Gemini's NATIVE SDK (google-genai),
    # not the OpenAI-compatible shim — the shim was tried first and
    # rejected: on this account, every accessible Gemini model is
    # 3.x-generation, and Google's own docs confirm reasoning/thinking
    # cannot be disabled for 3.x models via the OpenAI-compat
    # `reasoning_effort` param, which made every OpenAI-shim call this app
    # tried burn its entire token budget on hidden reasoning before ever
    # emitting an answer (same failure class as the gpt-oss/qwen3.6 fix
    # elsewhere in this file, but with no escape hatch on that endpoint).
    # The native SDK isn't fully clean either, though — verified live that
    # gemini-3-flash-preview spends hidden thinking tokens even when
    # `thinking_budget=0` is explicitly requested (Google's docs: 3.x models
    # can't fully disable reasoning, only budget it), which left responses
    # truncated mid-JSON at this app's normal small token budgets. Fixed by
    # requesting a small non-zero thinking_budget instead
    # (gemini_service._GEMINI_TEXT_FALLBACK_THINKING_BUDGET) so the existing
    # "reserve thinking budget on top of the answer budget" logic actually
    # engages — verified live end-to-end after that fix, correct JSON every
    # time.
    #
    # `gemini-3-flash-preview` — deliberately NOT one of the 4 models in
    # gemini_models above, so this draws from a genuinely independent quota
    # pool on Google's side rather than competing with Task A's vision
    # traffic. Real limit confirmed directly from a live 429's own error
    # body (the most reliable source available — Google doesn't publish
    # preview-model quotas): 5 RPM. Daily cap is NOT independently
    # confirmed — 100 is a conservative placeholder; loosen it if observed
    # usage shows more headroom, tighten it if 429s start recurring within
    # a day (quota_service's own reactive fallover — this whole fallback
    # itself only fires after Groq's entire chain already failed — means a
    # wrong number here only ever costs one wasted round-trip, never a
    # user-facing failure by itself).
    gemini_text_models: str = "gemini-3-flash-preview:5:100"
    gemini_text_model_rpm: int = 5
    gemini_text_model_rpd: int = 100

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

    # --- AI Coach chat -------------------------------------------------------
    # Per-user, per-day cap on free-text Coach chat turns (services/
    # coach_chat_quota_service.py) — separate from, and in addition to, the
    # shared Groq RPM guard (groq_models above / quota_service.py) every
    # Task B/C AI feature already draws from. This one exists specifically because
    # chat is the one AI endpoint that takes raw free-text input from a
    # single user on demand, with no cache absorbing repeat traffic the way
    # coach_cache_service.py does for the weekly recap — without a per-user
    # ceiling, one chatty user could crowd out everyone else's share of
    # Groq's shared rate limit. A low default is intentional: this is a
    # bonus on top of the zero-cost preset insights (frontend/js/aiCoach.js),
    # not the primary way to use the coach.
    coach_chat_daily_limit: int = 8

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
