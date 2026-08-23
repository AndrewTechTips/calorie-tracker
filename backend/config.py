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

    # Groq's own multi-model priority list — quality-tiered, mirroring
    # gemini_models' "name:rpm:rpd" format exactly (services/quota_service.py's
    # provider/model cycling is fully generic now, shared by both Gemini and
    # Groq). gpt-oss-120b/qwen3.6-27b/gpt-oss-20b all sit at 30 RPM / 1,000 RPD
    # (roughly comparable quality/general-purpose capability, each its own
    # independent pool — verified against Groq's official rate-limits page,
    # console.groq.com/docs/rate-limits, as of 2026-08). Deliberately excludes
    # groq/compound(-mini) (agentic/tool-calling systems, not a fit for this
    # app's strict single-turn JSON contract) and whisper/prompt-guard/
    # orpheus/safeguard models (wrong modality — audio, safety-classification,
    # or TTS, not general text generation).
    #
    # No Llama entry: both this account's Llama models — `llama-3.3-70b-
    # versatile` (the production incident that first surfaced this — see
    # gemini_service.py's "Fallover policy for OpenAI-compatible candidates"
    # comment) and `llama-3.1-8b-instant` (previously kept LAST here as a
    # high-volume 30 RPM/14,400 RPD safety valve once the quality tier's
    # combined ~3,000 RPD was exhausted) — were deprecated by Groq on the
    # SAME day, 2026-06-17, and both hard-shut-down 2026-08-16 (confirmed
    # directly against console.groq.com/docs/deprecations on 2026-08-18, two
    # days after shutdown — matches the timing of the 404s seen in
    # production). Groq's own recommended replacements for both are already
    # in this list: `openai/gpt-oss-120b`/`qwen/qwen3.6-27b` for the 70B
    # model, `openai/gpt-oss-20b` for the 8B one — so this list already *is*
    # "the current Llama-tier models" under Groq's new naming, nothing further
    # to add back. Losing llama-3.1-8b-instant does mean this chain no longer
    # has a genuine high-volume overflow tier (its 14,400 RPD dwarfed every
    # other entry here) — console.groq.com/docs/models shows no comparably
    # high-limit text model in Groq's current lineup to replace that specific
    # role with, so the realistic combined daily capacity across this whole
    # list is now the 4 models' ~3,000 RPD, not the ~17,000+ it used to be.
    # If that combined cap turns out to be too tight in practice, that's a
    # capacity-planning follow-up (a paid Groq tier, or leaning harder on the
    # native-Gemini last resort), not something fixable by finding another
    # free high-volume model to bolt on here. Re-verify both the rate-limits
    # and deprecations pages before trusting any model name in this file
    # long-term — this is the second time in one day a model here went stale.
    groq_models: str = (
        "openai/gpt-oss-120b:30:1000,"
        "qwen/qwen3.6-27b:30:1000,"
        "openai/gpt-oss-20b:30:1000"
    )
    # Fallback RPM/RPD for a *bare* model name added to groq_models above
    # without its own "name:rpm:rpd" (mirrors gemini_model_rpm/rpd below).
    groq_model_rpm: int = 30
    groq_model_rpd: int = 1000

    # --- Mistral (Task B/C primary, as of 2026-08) --------------------------
    # Promoted ahead of Groq after user reports of inaccurate macro estimates
    # and silently dropped ingredients on complex, multi-item free-text
    # descriptions (see gemini_service.py's TEXT_EXTRACTION_PROMPT callers).
    # Mistral's JSON-mode models adhere to the requested schema far more
    # reliably than Groq's reasoning-model lineup and — critically — don't
    # spend hidden reasoning tokens out of the visible-answer token budget the
    # way gpt-oss/qwen3.6 on Groq do (see _reasoning_effort_for's own
    # comment), which was the direct cause of truncated/incomplete
    # multi-ingredient responses. Groq is demoted to first fallback (not
    # removed — its own model chain is still a real, independent quota pool
    # worth trying before giving up), and the native-Gemini last resort at
    # the end of the chain is unchanged.
    #
    # ONE CANONICAL CATALOG, TWO TASK-SPECIFIC ORDERINGS: this list is the
    # single source of truth for every Mistral model this app uses, across
    # BOTH Task B (macro/ingredient extraction — accuracy is the whole point
    # of the app, see gemini_service.py's _MISTRAL_ACCURACY_PRIORITY) and
    # Task C (chat/recap/damage-control — accuracy matters far less than tone
    # and throughput, see _MISTRAL_CHAT_PRIORITY). Deliberately ONE settings
    # field, not two: quota_service tracks real usage per (provider, model),
    # and Mistral's own per-model rate limit is genuinely shared across
    # whichever task calls it — splitting this into two separate settings
    # (like gemini_models vs gemini_text_models, which are deliberately
    # non-overlapping models on two independent Google quota pools) would
    # make our own bookkeeping double-count the SAME model's real capacity if
    # both task orderings ever referenced it, silently allowing 2x the real
    # traffic before a live 429 caught it. gemini_service.py's two priority
    # lists instead just reorder this one shared catalog differently per
    # task, via quota_service.select_from() — correct because the underlying
    # (provider, model) counter is one and the same either way.
    #
    # RPM figures below are read DIRECTLY off this account's own live
    # x-ratelimit-limit-req-minute response headers (2026-08) — the same
    # "highest-confidence source available" principle gemini_text_models' 5
    # RPM figure already uses (that one came from a live 429 body; these came
    # from a live 200's own headers, arguably even more reliable since no
    # error was needed to observe them). Mistral's API returns NO daily-count
    # header at all (only per-minute req/token limits) — there is no
    # confirmed RPD ceiling to encode, so the RPD figures below are
    # deliberately conservative, safe-to-loosen placeholders (well under each
    # model's theoretical rpm*1440 ceiling), not verified numbers. Re-verify
    # both by re-running the same live-header check
    # (`httpx.post(...).headers["x-ratelimit-limit-req-minute"]`) before
    # trusting this list long-term — same caveat every other provider/model
    # list in this file already carries.
    #
    # ACCURACY IS COUNTER-INTUITIVE HERE — do not "fix" this ordering by
    # tier-name assumption without re-testing: live-tested against a real
    # complex multi-ingredient description (5 small-gram items — the exact
    # failure class this integration was meant to fix), mistral-large-latest
    # was the only model with ZERO physically-impossible ingredient macros
    # across 2 full runs (a component's protein+carbs+fats summing to MORE
    # grams than its own weight_g is impossible — a hard, objective
    # correctness signal, not a style judgment). mistral-small-latest was
    # decent but imperfect (0-2/5 impossible across runs). mistral-medium-
    # latest — despite sitting between them by name/price — was consistently
    # WORSE than small (2-3/5 impossible across 2 runs), and open-mistral-
    # nemo (the model originally tried here) isn't even in this account's own
    # GET /v1/models catalog anymore (a stale/legacy model still silently
    # served, not a current one) and was the worst performer of all before
    # being dropped from this list entirely. Only 4 RPM on the most accurate
    # model is a real, deliberate constraint, not an oversight — same
    # "smallest quota, best accuracy, tried first anyway" tradeoff
    # gemini_models' own Flash pair already makes; quota_service's proactive
    # headroom check naturally overflows to small/medium the moment large's
    # 4-per-minute (shared across every user on this single Render instance)
    # is exhausted, rather than ever blocking a request on it.
    mistral_api_key: str = ""
    mistral_models: str = (
        "mistral-large-latest:4:3000,"
        "mistral-small-latest:50:20000,"
        "mistral-medium-latest:50:20000,"
        "ministral-8b-latest:188:100000,"
        "ministral-3b-latest:750:400000"
    )
    # Fallback RPM/RPD for a *bare* model name added to mistral_models above
    # without its own "name:rpm:rpd" (mirrors groq_model_rpm/rpd above).
    mistral_model_rpm: int = 30
    mistral_model_rpd: int = 1000

    # NVIDIA model list — ordered by quality, not quota (NVIDIA doesn't
    # publish a reliable per-model number worth encoding as a proactive
    # gate). The account's real catalog was verified via NVIDIA's own GET
    # /v1/models during live testing — re-verify there before changing
    # this, a stale name just costs one wasted round-trip (falls through to
    # the next model) unless it's the LAST entry, same caveat gemini_models'
    # own comment describes.
    #
    # Vision-capable NVIDIA NIM model(s). z-ai/glm-5.2 (the previous default)
    # reached end-of-life on 2026-08-21 — live-verified via a real request:
    # NVIDIA's API now returns a 410 Gone ("has reached its end of life...
    # and is no longer available") for it. Re-verified the account's current
    # catalog (GET /v1/models) and live-tested every vision-tagged model
    # found there with a real image request: nvidia/nemotron-nano-12b-v2-vl
    # and meta/llama-3.2-11b-vision-instruct both responded correctly in a
    # few seconds (kept, in that order — NVIDIA's own more recent nano-VL
    # model first). meta/llama-3.2-90b-vision-instruct was also tried and
    # timed out after 40s+ (likely a cold-start NIM model) — deliberately
    # excluded, since a 40-second hang on this app's last-resort vision
    # fallback would be far worse for a mobile client than just failing that
    # one request. Re-verify this list periodically — NIM models get
    # end-of-life'd with little notice, as this one just demonstrated.
    nvidia_vision_models: str = "nvidia/nemotron-nano-12b-v2-vl,meta/llama-3.2-11b-vision-instruct"

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

    # --- Web Push notifications ----------------------------------------------
    # Standards-based Web Push (RFC 8030 + VAPID, RFC 8292) — no Firebase/OneSignal,
    # sent directly to whichever push service the browser's own endpoint points
    # at (FCM for Chrome/Edge, Mozilla's for Firefox, Apple's for Safari/iOS 16.4+),
    # via backend/services/push_service.py (pywebpush). Viable now specifically
    # because this backend runs on an always-on VPS (see docker-compose.yml) —
    # a scheduler that must wake up and POST to a push service at an arbitrary
    # time of day has nowhere to run on a scale-to-zero host.
    #
    # Generate a keypair once (py_vapid ships no public_key_string()/
    # private_key_string() helper — this hand-rolls the same raw,
    # base64url-no-padding encoding PushManager.subscribe()'s
    # applicationServerKey and pywebpush's Vapid.from_string() both expect):
    #   python3 -c "
    #   from cryptography.hazmat.primitives import serialization
    #   from py_vapid import Vapid02
    #   from py_vapid.utils import b64urlencode
    #   v = Vapid02(); v.generate_keys()
    #   priv = v.private_key.private_numbers().private_value.to_bytes(32, 'big')
    #   pub = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    #   print('VAPID_PUBLIC_KEY=' + b64urlencode(pub))
    #   print('VAPID_PRIVATE_KEY=' + b64urlencode(priv))
    #   "
    # The public key is NOT secret (it's shipped to every browser via
    # frontend/js/config.js, same non-secret-by-design posture as
    # SUPABASE_ANON_KEY) — only the private key needs protecting. Both blank
    # is a valid, inert state: routers/notifications.py's endpoints all
    # degrade to a clear 503 rather than crashing at import time, so an
    # unconfigured deploy just has push notifications off, like every other
    # optional integration in this file.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    # The `sub` claim every push service requires in the VAPID JWT (RFC 8292)
    # — a contact URI so the push service's operator can reach you if this
    # server is ever misbehaving (e.g. flooding them). "mailto:" is what
    # every push service actually expects here, not a bare email.
    vapid_admin_email: str = "mailto:admin@example.com"

    # --- Optional integrations (all inert/no-op when left blank) ------------
    # Note: there is no Turnstile setting here — CAPTCHA verification for
    # signup happens entirely inside Supabase Auth (configured in the
    # Supabase dashboard with its own secret key), never touching this
    # backend. Only the public Turnstile *site* key lives in the frontend
    # (frontend/js/config.js) — see frontend/js/auth.js.
    sentry_dsn: str = ""

    # --- Nutrition database grounding (services/nutrition_db_service.py) ----
    # Before trusting the AI's own recalled macro numbers for an identified
    # food, this looks the food up against USDA FoodData Central (generic/raw
    # ingredients) and Open Food Facts (branded/packaged products, incl. real
    # Romanian-market brands — verified live: Pirifan, Covalact, Zuzu, and
    # several Telemea brands all returned complete nutriment data) and, on a
    # confident text match, uses the database's real values instead of the
    # model's guess. Neither database requires payment; USDA does require a
    # free API key (unlike Open Food Facts) — get one instantly at
    # https://api.data.gov/signup (no approval wait). DEMO_KEY works for
    # local testing but is rate-limited hard (30/hour) — never use it in
    # production.
    usda_api_key: str = ""
    # Master kill switch — flip to false to instantly revert to pure-AI
    # estimation (today's behavior) without a code rollback, e.g. if a
    # database integration is ever misbehaving in production. Open Food
    # Facts alone (no key needed) already makes grounding useful even with
    # usda_api_key blank; this flag disables BOTH sources at once regardless.
    nutrition_db_grounding_enabled: bool = True

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def vapid_configured(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
