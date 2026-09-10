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

    # ========================================================================
    # PHASE 2 — one primary model, one non-Google fallback per modality.
    #
    # What this replaced: a task-based routing table across four providers
    # (Gemini / Mistral / Groq / NVIDIA), each cycling its own ordered model
    # list, with per-task priority orderings, a cross-provider walker, and a
    # native-SDK last resort. All of that existed for ONE reason — no single
    # free tier was dependable enough to rely on — and every one of its
    # workarounds (reasoning-effort vocabularies that differ per model family,
    # entitlement gates that 403, stale ids that 404, thinking budgets that
    # could not be turned off) was a symptom of that. On a paid Gemini tier
    # the premise is gone, so the machinery is too.
    #
    # The shape now: gemini-3.8-flash is the primary for everything except
    # chat/suggestions, which use the cheaper flash-lite tier. Each modality
    # keeps exactly ONE non-Google fallback, for the case a paid tier cannot
    # help with: a Google-side outage.
    # ========================================================================

    # --- Primary: vision + text extraction, macro lookup, recap -------------
    # gemini-3.8-flash. Cheaper than the gemini-3.6-flash it replaces
    # ($0.75/$3.75 per 1M vs $1.50/$7.50) AND higher-quality, and it restores
    # a working thinking control — see gemini_vision_thinking_level below for
    # why that mattered so much here.
    #
    # RPM/RPD BELOW ARE PLACEHOLDERS FOR A PAID TIER 1 PROJECT. Google does
    # not publish per-model paid limits; they are shown per project at
    # https://aistudio.google.com/rate-limit. Read yours and set these to
    # match. They only drive quota_service's proactive gating and the
    # frontend's usage bar — setting them too HIGH just means the app relies
    # on Google's own 429 instead of pre-empting it (which the fallback
    # already handles), and too LOW means refusing scans you could have run.
    gemini_models: str = "gemini-3.8-flash:1000:10000"
    gemini_model_rpm: int = 1000
    gemini_model_rpd: int = 10000

    # --- Cheap tier: AI Coach chat + Smart Meal Suggester -------------------
    # Both are text-only, high-frequency, and conversational rather than
    # numeric — nothing downstream does arithmetic on their output the way the
    # scan pipeline does on an extraction. gemini-3.5-flash-lite is $0.30/$2.50
    # per 1M against 3.8-flash's $0.75/$3.75, i.e. ~60% cheaper input and ~33%
    # cheaper output, for output nobody re-derives a calorie count from.
    #
    # Its own quota pool ("gemini_chat") so a chatty afternoon can never eat
    # the scan budget — the same isolation the old gemini_text_models pool
    # provided, kept for the same reason.
    gemini_chat_models: str = "gemini-3.5-flash-lite:1000:10000"
    gemini_chat_model_rpm: int = 1000
    gemini_chat_model_rpd: int = 10000

    # --- Composite-dish "chef" — NOW ENABLED --------------------------------
    # A composite/cooked prepared dish (Stage 1's is_composite hint — a stew, a
    # "mix", "salata de boeuf") has no single reference DB entry, so it skips
    # nutrition_db_service and is priced by an AI recall of the whole dish.
    # Live A/B testing showed the old cheap chain systematically UNDER-
    # estimates these: it drops cooking fat/oil/mayo and mis-composes
    # unfamiliar regional recipes (it decomposed "salata de boeuf" into a
    # lettuce salad, ~3x under).
    #
    # This was built, live-tested, and then shipped DISABLED because no
    # high-tier model was reachable on a free key. That constraint is what
    # Phase 2 removes. It runs on the same gemini-3.8-flash as the primary but
    # at thinking_level=high and against its own quota pool, because inferring
    # a regional dish's composition, cooking method and portion is a reasoning
    # task, not a lookup. Blank disables it (composites then fall back to the
    # ordinary text path).
    gemini_composite_models: str = "gemini-3.8-flash:1000:10000"
    gemini_composite_model_rpm: int = 1000
    gemini_composite_model_rpd: int = 10000

    # --- Thinking levels ----------------------------------------------------
    # Gemini 3.8 REMOVED the numeric `thinking_budget` parameter and replaced
    # it with the string enum `thinking_level` ("low" | "medium" | "high";
    # "minimal" is rejected outright with a 400). This is a hard API break, not
    # a rename with a compatibility shim — passing thinking_budget to 3.8 is an
    # error, which is why _call_model no longer has a numeric budget at all.
    #
    # It also deletes a whole class of workaround that used to live in
    # gemini_service: 3.x models could not have reasoning disabled, only
    # budgeted, so the old code reserved extra tokens on top of the answer
    # budget and retried without thinking on a MAX_TOKENS truncation. With a
    # real enum, "low" is a supported setting rather than something to be
    # worked around.
    #
    # medium (the API default) for vision: the call has to identify every
    # component AND estimate portion mass, and it self-checks its own
    # arithmetic before committing to JSON.
    gemini_vision_thinking_level: str = "medium"
    # The no-photo "describe what I ate" path infers composition and portion
    # from text alone — comparable work to the vision call, so the same level.
    gemini_description_thinking_level: str = "medium"
    # high for the composite chef. This is the one path in the app with no
    # database floor underneath it, pricing exactly the dishes the cheap
    # models got 3x wrong. It is also rare, so the extra thinking tokens cost
    # very little in aggregate.
    gemini_composite_thinking_level: str = "high"
    # low for chat and meal suggestions. Google's own guidance puts
    # latency-sensitive chat at low, and thinking tokens bill as output — on
    # the two highest-frequency text features that is the single largest
    # avoidable line item.
    gemini_chat_thinking_level: str = "low"
    # A plain macro lookup for one already-identified food name is a recall
    # task, not a reasoning one.
    gemini_lookup_thinking_level: str = "low"

    # --- The single non-Google fallback -------------------------------------
    # Purpose, precisely: a Google-side outage. Not quota (a paid tier makes
    # that a non-issue at this app's scale), not quality, not cost. It is
    # tried once, after Gemini has actually failed, and never proactively.
    #
    # Two providers rather than one only because no single one covers both
    # modalities well:
    #   vision — NVIDIA NIM, already wired and vision-capable.
    #   text   — Mistral, ONE model, deliberately the model that was Task B/C's
    #            primary until now, so it is proven against these exact prompts
    #            and JSON schemas rather than merely plausible.
    #
    # GROQ IS GONE ENTIRELY. It was the source of every reasoning-effort
    # workaround in this codebase (gpt-oss accepts low/medium/high, Qwen
    # accepts only none/default and 400s on "low", both burn their whole
    # token budget on hidden reasoning at small max_tokens) and it bought
    # nothing a paid Gemini tier does not.
    #
    # Either key left blank simply drops that fallback — a Gemini failure then
    # surfaces to the caller, which every caller already handles.
    nvidia_api_key: str = ""
    nvidia_vision_models: str = "meta/llama-3.2-11b-vision-instruct"
    mistral_api_key: str = ""
    mistral_fallback_model: str = "mistral-medium-3.5"

    # --- Data retention ----------------------------------------------------
    # Rolling window, not a calendar week: a row is purged once it's this many
    # days old, same mechanism as before (see services/cleanup_service.py),
    # just a bigger number. Keep this in sync with the interval baked into
    # sql/schema.sql's cleanup_old_logs() if you change it.
    retention_days: int = 7

    # daily_calorie_summary (sql/schema.sql) is a small longitudinal aggregate
    # — one row per user per logged day — kept FAR longer than retention_days
    # above so features that need history past the 7-day raw-log window have
    # it: the Damage Control "zoom-out" sparkline, and the Phase 2 Weekly
    # Recap insights engine's 4-/8-week baselines. 90 days covers an 8-week
    # baseline with margin at negligible storage cost. Keep this in sync with
    # the interval in sql/schema.sql's cleanup_old_logs() AND the identical
    # prune in services/cleanup_service.py.
    summary_retention_days: int = 90

    # How many days the Damage Control card's "zoom-out" sparkline spans —
    # today plus the trailing (n-1) days, read from daily_calorie_summary.
    # Must be <= summary_retention_days. The psychological job is "today's
    # spike is one notch on a steady line", which needs enough prior days to
    # read as a trend, not just a couple.
    damage_control_sparkline_days: int = 14

    # --- AI Coach chat -------------------------------------------------------
    # Per-user, per-day cap on free-text Coach chat turns — one of the
    # per-user quotas services/ai_usage_service.py enforces (feature key
    # "coach_chat"). This exists because chat is the one AI endpoint that
    # takes raw free-text input from a single user on demand, with no cache
    # absorbing repeat traffic the way coach_cache_service.py does for the
    # weekly recap.
    #
    # Its original rationale was rate-limit protection: without a ceiling one
    # chatty user could crowd out everyone else's share of a tiny shared free
    # tier. On a paid tier that pressure is gone, and what this now protects
    # is SPEND — chat is the highest-frequency text feature in the app, so
    # this is the ceiling on what one user can cost per day. Kept at 6 for
    # that reason. Raising it is now a budget decision rather than a capacity
    # one; at gemini-3.5-flash-lite's pricing (see gemini_chat_models) a turn
    # is a fraction of a cent, so there is room if the product wants it.
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
    # scan_describe/log_correction/coach_chat/weekly_recap/suggest_meals all
    # route through Groq + a separate, much smaller Gemini
    # TEXT fallback pool (gemini_text_models below), never this vision pool,
    # so tightening them wouldn't address this and would only make those
    # features needlessly less usable.
    ai_scan_daily_limit: int = 8  # AI Meal Scan (photo) — Task A vision, the priciest call in the app
    # scan_describe/log_correction/suggest_meals below were
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
    # Damage Control had a daily cap here until it was rebuilt as a 100%
    # deterministic feature (no LLM call anywhere) — nothing left to meter, so
    # its quota and its row in Settings → AI Limits were both removed. See
    # routers/coach.py's GET /coach/damage-control and
    # services/damage_control_service.py.
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

    # --- Phase 1: local corpus retrieval ------------------------------------
    # When true, nutrition_db_service retrieves candidates from the local
    # public.nutrition_corpus table (hybrid vector + full-text, one indexed
    # query) instead of fanning out to the USDA and Open Food Facts HTTP APIs.
    #
    # Defaults to FALSE so this is opt-in and reversible: the table has to be
    # created (sql/phase1_nutrition_corpus.sql) and populated
    # (scripts/ingest_nutrition_corpus.py) before it can answer anything, and
    # a deploy that flipped itself over to an empty table would ground nothing
    # and silently route every lookup to the AI. Flip it on only once
    #   select count(*) from public.nutrition_corpus where embedding is not null
    # returns what you expect. Flipping it back to false restores the remote
    # API path with no code change, which is the same escape hatch
    # nutrition_db_grounding_enabled above provides one level up.
    #
    # What this buys (see the Phase 1 notes in CLAUDE.md): no USDA rate limit
    # in the request path (the old path spent up to 24 external calls per
    # six-ingredient scan against a 1,000/hour key), no network leg on the
    # hot path, and retrieval over the WHOLE corpus rather than each source's
    # own top-25 lexical window.
    nutrition_db_local_corpus: bool = False
    # How many fused candidates the RPC returns per query. The gates in
    # _score/implausibility_reason then filter these down. 40 is well above
    # the ~25-per-source the remote APIs returned, and the cost of a larger
    # number is local CPU in _score rather than another network round trip —
    # but do not raise it without re-running tests/test_retrieval_eval.py:
    # deeper candidates are progressively less relevant, and the gates are
    # the only thing standing between a low-relevance row and a calorie count.
    nutrition_db_match_count: int = 40
    # When the local corpus grounds NOTHING for a name, still try the old
    # remote USDA/Open Food Facts search before giving up and handing the
    # question to the AI.
    #
    # This is not belt-and-braces caution, it is a measured requirement. The
    # local corpus is USDA (13.3k rows) plus the ROMANIA slice of Open Food
    # Facts (3.1k rows), while the remote path queries Open Food Facts'
    # entire global index. Measured on tests/test_retrieval_eval.py's 46
    # grounded cases:
    #
    #     remote only (the old path)   grounding 91%   accuracy 72%
    #     local only                   grounding 83%   accuracy 70%
    #     local + remote fallback      grounding 100%  accuracy 78%
    #
    # Local-only REGRESSES, because foods like walnuts, dried dates, rice
    # flour and canned tuna were being served by Open Food Facts' global
    # catalogue, not by anything Romanian. Local-first-with-fallback beats
    # both: the corpus answers the common case with no network and no quota
    # (measured: 38 of 46 queries never leave the process), and the remote
    # search only runs for the tail it genuinely cannot cover.
    #
    # Set false to make the local corpus authoritative — worth doing only
    # after ingesting a substantially wider Open Food Facts slice than the
    # Romania filter produces, and only with the eval re-run to prove it.
    nutrition_db_remote_fallback: bool = True

    # extra="ignore", added in Phase 2. pydantic-settings defaults to
    # extra="forbid", which means an environment variable with no matching
    # field here is a STARTUP CRASH, not a warning. That is a fine default
    # while fields only get added — but Phase 2 deleted several (GROQ_API_KEY,
    # GROQ_MODELS, MISTRAL_MODELS, GEMINI_TEXT_MODELS, the *_THINKING_BUDGET
    # numbers), and those values are still present in the deployed
    # environment: in backend/.env locally, and as configured env vars on the
    # host, which this repo cannot reach in to clean up.
    #
    # Under "forbid" the first deploy after this change would have failed to
    # boot on a leftover GROQ_API_KEY — an outage caused entirely by tidying,
    # with no way to fix it except editing the host's config before the code
    # could start. "ignore" makes the removed variables inert instead, so the
    # cleanup is safe to do afterwards, at leisure, or never.
    #
    # The cost is losing typo protection on env var names. That is worth it
    # here: every setting in this file has a working default, so a typo
    # degrades to the default rather than to a wrong value, and the settings
    # that genuinely must be present (Supabase keys, Gemini key) have no
    # default and still fail loudly when missing.
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def vapid_configured(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
