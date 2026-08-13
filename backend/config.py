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
    # ACCURACY-FIRST ordering (changed 2026-08, after user reports of vision
    # scans being wildly high/low on calories/carbs): select_candidate()
    # always walks this list top-to-bottom and returns the FIRST entry with
    # live headroom, so list order IS priority order, not just a tiebreak —
    # whichever model is listed first gets essentially all normal-load
    # traffic, and later entries are true overflow, rarely reached. The
    # previous ordering put the two Flash-Lite models first purely for their
    # larger combined quota (~1000 RPD vs ~40 RPD for the Flash pair), which
    # meant nearly every real scan was silently served by the *less*
    # accurate tier every day, with the better Flash models almost never
    # actually used despite being second/third/fourth in a 4-model list.
    # That's backwards for this app's core feature: food-photo scanning is
    # the single most accuracy-sensitive call in the codebase, so the two
    # regular Flash models (better accuracy, smaller 20 RPD/5 RPM quota
    # each) are now tried FIRST, with the two Flash-Lite models (weaker
    # accuracy, larger 500 RPD/15 RPM quota each) demoted to their originally
    # intended role: high-volume overflow once the accurate tier's combined
    # ~40 RPD is actually exhausted for the day, not the default path. Models
    # this account shows as 0/0 (unavailable) are excluded — routing to one
    # would just waste an attempt. Previously also listed gemini-3-flash, gemini-2.5-flash, and
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
    #
    # RPM/RPD figures below were cross-checked directly against the live
    # per-model quota table in Google AI Studio (2026-08) and corrected to
    # match exactly — the previous numbers were hand-estimated and, for the
    # two Flash-Lite entries, slightly under the real 15 RPM/500 RPD ceiling
    # (harmless, just left quota on the table). `gemini-flash-lite-latest`
    # was also renamed to the explicit `gemini-3.5-flash-lite` id: an
    # unversioned "-latest" alias can silently start resolving to a
    # different model than the one these numbers were verified against,
    # which is exactly the kind of drift this whole list already warns
    # about — pinning it removes that risk.
    gemini_models: str = (
        "gemini-3.6-flash:5:20,"
        "gemini-3.5-flash:5:20,"
        "gemini-3.5-flash-lite:15:500,"
        "gemini-3.1-flash-lite:15:500"
    )
    # Fallback RPM/RPD used only for a *bare* model name added to
    # gemini_models above without its own "name:rpm:rpd" limits.
    gemini_model_rpm: int = 15
    gemini_model_rpd: int = 500

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
    # traffic. 5 RPM / 20 RPD — both confirmed directly against the live
    # per-model quota table in Google AI Studio ("Gemini 3 Flash", 2026-08).
    # The RPD figure was previously a 100 placeholder (5x too generous,
    # guessed before this table was available) — that mattered more than a
    # single wasted round-trip: with the real cap at 20, a burst of
    # Groq-chain failures could have this fallback itself return live 429s
    # well before quota_service's own proactive gate thought there was any
    # reason to stop trying it.
    gemini_text_models: str = "gemini-3-flash-preview:5:20"
    gemini_text_model_rpm: int = 5
    gemini_text_model_rpd: int = 20

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
    # Per-user, per-day cap on free-text Coach chat turns — one of the
    # per-user quotas services/ai_usage_service.py enforces (feature key
    # "coach_chat"), separate from, and in addition to, the shared Groq RPM
    # guard (groq_models above / quota_service.py) every Task B/C AI feature
    # already draws from. This one exists specifically because chat is the
    # one AI endpoint that takes raw free-text input from a single user on
    # demand, with no cache absorbing repeat traffic the way
    # coach_cache_service.py does for the weekly recap — without a per-user
    # ceiling, one chatty user could crowd out everyone else's share of
    # Groq's shared rate limit. A low default is intentional: this is a
    # bonus on top of the zero-cost preset insights (frontend/js/aiCoach.js),
    # not the primary way to use the coach. Kept as its own top-level setting
    # (not folded into the ai_*_daily_limit block below) since it predates
    # that block and other code may already reference this exact name.
    # Trimmed from an original 8 to 6 for the same reason the ai_*_daily_limit
    # block below was: this can still fall through to the tiny shared Gemini
    # text pool (gemini_text_models — 5 RPM/20 RPD, see its own comment) on a
    # bad Groq day, so a lower per-user ceiling means fewer Task B/C attempts
    # from any one user stacking up against that floor.
    coach_chat_daily_limit: int = 6

    # --- Per-user AI feature daily quotas (services/ai_usage_service.py) ----
    # DB-backed (sql/schema.sql's ai_feature_usage table +
    # increment_ai_feature_usage RPC), unlike quota_service.py's in-memory
    # PROVIDER-capacity counters above: these are a PER-USER entitlement, so
    # they must survive a Render restart/redeploy without silently resetting
    # everyone's daily allowance. One setting per feature (not a single dict
    # setting) so each is independently env-overridable and easy to retune
    # later without touching code — see ai_usage_service.py's
    # _FEATURE_LIMIT_SETTINGS for how each feature key maps to one of these.
    # Starting baselines, not tuned from real usage data yet: costlier/rarer
    # actions get a lower daily ceiling than cheap/frequent ones.
    #
    # ai_scan_daily_limit specifically was tightened from an initial 15 after
    # real-world use showed the shared Gemini VISION pool (gemini_models
    # above — 4 models, ~996 combined RPD) running low faster than the
    # in-app math alone predicted. That's expected, not a bug in the math:
    # quota_service.py's counters only see calls THIS backend makes — they
    # have no visibility into other usage on the same Google account/project
    # (e.g. testing directly in AI Studio), so real exhaustion can arrive
    # well before "N users x limit" would suggest. 8/day keeps the
    # worst-case aggregate (every user maxing out) to well under 20% of the
    # shared pool, leaving real headroom for retries/invalid_input attempts
    # and any out-of-band usage — while still comfortably covering a real
    # day of photographed meals (most users also mix in saved meals/barcode/
    # manual entry, not every meal gets a photo). Only `scan` was touched —
    # scan_describe/log_correction/coach_chat/weekly_recap/damage_control/
    # suggest_meals all route through Groq + a separate, much smaller Gemini
    # TEXT fallback pool (gemini_text_models below), never this vision pool,
    # so tightening them wouldn't address this and would only make those
    # features needlessly less usable.
    ai_scan_daily_limit: int = 8  # AI Meal Scan (photo) — Task A vision, the priciest call in the app
    # scan_describe/log_correction/damage_control/suggest_meals below were
    # each roughly halved from their original baseline for the same reason
    # as ai_scan_daily_limit above: Task B/C's real primary provider (Groq)
    # has plenty of headroom on its own, but every one of these features can
    # still fall through to the same tiny shared Gemini text pool
    # (gemini_text_models — 5 RPM/20 RPD total, see its own comment) if Groq
    # ever degrades. Fewer max daily attempts per user per feature means
    # fewer total Task B/C calls stacking up against that 20 RPD floor on a
    # bad Groq day, without meaningfully limiting normal single-day use.
    ai_scan_describe_daily_limit: int = 12  # "Describe a Meal" text estimate — Task B
    ai_log_correction_daily_limit: int = 15  # Food-name correction re-estimate — Task B, often cache-served (services/food_cache_service.py)
    # Weekly recap is the one feature whose NATURAL cadence isn't daily at
    # all — it's already cached server-side for 7 days per (user, language)
    # (coach_cache_service.py), so a real fresh generation only happens on a
    # genuine cache miss (first open of the week, or a language switch). A
    # daily-only cap of 5 (the original baseline) made no product sense —
    # "5 weekly reports in one day" isn't a real usage pattern, it was just
    # an unexamined copy of the other features' shape. This is the one
    # feature with a monthly ceiling too (ai_usage_service.py's
    # _FEATURE_MONTHLY_LIMIT_SETTINGS): daily=2 is just a same-day-repeat
    # guard (covers a genuine re-generate-after-a-mistake, or two language
    # switches in one sitting), monthly=8 is the real ceiling and matches
    # "about 1-2 recaps a week" over a ~4.3-week month — generous for real
    # weekly use, while making a whole month of never-cached regeneration
    # impossible.
    ai_weekly_recap_daily_limit: int = 2  # Weekly recap regeneration — Task C, already cached 7 days per (user, language)
    ai_weekly_recap_monthly_limit: int = 8  # ~1-2/week over a month — the real ceiling; the daily cap above is just a same-day guard
    ai_damage_control_daily_limit: int = 5  # "Damage Control" recovery message — Task C
    ai_suggest_meals_daily_limit: int = 8  # Smart Meal Suggester — Task B

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
