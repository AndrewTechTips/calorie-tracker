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

    # FastAPI's /docs, /redoc and /openapi.json, which it serves publicly and
    # unauthenticated by default. OFF unless explicitly enabled — see main.py's
    # FastAPI(...) call for the full reasoning and the measurement. Default is
    # the secure value so a host whose .env was never updated is still closed.
    api_docs_enabled: bool = False

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
    # THE RPD NUMBER IS A SPEND CEILING, NOT A RATE LIMIT. This is the only
    # account-wide limit in the app — ai_usage_service's caps are PER USER, so
    # they bound what one person costs and say nothing about what 200 people
    # cost. gemini_service._generate_content refuses every call once this is
    # hit (see its own comment), which makes it the deployment's kill switch.
    #
    # THE ARITHMETIC, so this can be retuned against a real budget rather than
    # guessed. Measured request shapes on gemini-3.8-flash at $0.75/$3.75 per
    # 1M (introductory, ends 2026-12-31 and then DOUBLES — revisit this number
    # then):
    #     a vision scan call   ~3,400 in / 700 out   ~= $0.0053
    #     a text recall call     ~900 in / 450 out   ~= $0.0024
    # A realistic mixed day averages roughly $0.004/call, so:
    #
    #     2,000 calls/day  ~=  $8/day  ~=  $240/month   <- the value below
    #     1,000 calls/day  ~=  $4/day  ~=  $120/month
    #       500 calls/day  ~=  $2/day  ~=   $60/month
    #
    # 2,000/day was chosen to comfortably cover 50 users at realistic usage
    # (~$60/month projected) with ~4x headroom for a spike, while making the
    # runaway scenario impossible: the old value of 10,000/day would have
    # permitted roughly $1,200/month. LOWER THIS if you want a tighter
    # guarantee — the cost of setting it too low is a friendly "AI is busy"
    # message, which is strictly better than an unexpected bill.
    #
    # This is a ceiling on YOUR OWN spend, so it is fine for it to sit well
    # below Google's actual rate limits — it is not trying to predict them.
    # RPM stays generous (it only shapes bursts, and Google's own 429 plus the
    # Mistral fallback already handle real rate limiting).
    #
    # NOT A SUBSTITUTE FOR A BILLING BUDGET. This counter is in-memory and
    # resets on restart, so a crash-loop could spend more than one day's worth.
    # Set a Google Cloud billing budget with alerts as the backstop — see the
    # deployment guide.
    gemini_models: str = "gemini-3.8-flash:1000:2000"
    gemini_model_rpm: int = 1000
    gemini_model_rpd: int = 2000

    # --- Cheap tier: only reachable if free_text_allow_paid_fallback is ON --
    # AI Coach chat, Smart Meal Suggester and the weekly recap no longer run
    # on Gemini at all — they route through the FREE text tier below, which is
    # an operational rule ("these features cost $0.00"), not a cost
    # optimisation. This pool is what they fall back TO, and only when
    # free_text_allow_paid_fallback has been deliberately switched on.
    #
    # Left wired rather than deleted because that switch is the whole point:
    # it lets a decision to accept a few dollars a month for a
    # never-unavailable Ollie be made in the .env, not in a code change. While
    # it stays false (the default) nothing here is ever billed.
    #
    # Its own quota pool ("gemini_chat") so a chatty afternoon can never eat
    # the scan budget.
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
    # Own pool, own ceiling — a composite dish runs at thinking_level=high and
    # thinking tokens bill as OUTPUT, so these are the most expensive calls in
    # the app per unit. 300/day keeps this pool's own worst case near $2/day
    # and, because it is separate, a burst of composite dishes can never eat
    # the main scan budget above.
    gemini_composite_models: str = "gemini-3.8-flash:1000:300"
    gemini_composite_model_rpm: int = 1000
    gemini_composite_model_rpd: int = 300

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

    # --- The FREE text tier: chat, meal suggestions, weekly recap ----------
    # An operational rule, stated as such: the recurring API cost of Ollie
    # chat and Smart Meal Suggestions is $0.00. Paid budget is reserved
    # strictly for the vision/macro-pricing pipeline, whose output real
    # numbers are computed from. Nothing in this list is ever billed.
    #
    # Ordered "provider:model" candidates, tried left to right; a provider
    # whose API key is blank is skipped rather than failing. That ordering is
    # the entire routing policy — there is no per-task table, no priority
    # list per provider, and no reasoning-effort vocabulary. Every entry is an
    # ordinary OpenAI-compatible chat/completions endpoint answering the same
    # prompts with response_format={"type":"json_object"}, funnelled through
    # gemini_service._parse_json_response like every other provider.
    #
    # WHY THESE TWO, measured live 2026-09-11 against this project's own keys
    # and this file's real COACH_CHAT_PROMPT / MEAL_SUGGESTION_PROMPT:
    #
    #   groq qwen/qwen3.8-27b    chat 0.3-0.4s, suggestions 3.0s, valid JSON
    #                            every time, idiomatic Romanian, and it
    #                            refused a prompt-injection probe with the
    #                            same {"error":"invalid_input"} Gemini emits.
    #                            At parity with gemini-3.5-flash-lite on this
    #                            workload and ~4x faster.
    #   mistral open-mistral-nemo backstop for a Groq 429. Weaker Romanian
    #                            ("iaurt greu" for Greek yogurt) and slow
    #                            (7-15s), but its free tier reports 625,000
    #                            tokens/minute against Groq's 8,000, so it has
    #                            headroom exactly when Groq has none.
    #
    # REJECTED, with reasons, so nobody re-litigates this from model names
    # alone: groq openai/gpt-oss-20b AND -120b both return 400
    # json_validate_failed on these prompts — they burn the budget on hidden
    # reasoning and emit nothing, recoverable only with the per-model
    # reasoning_effort table Phase 2 deleted. mistral ministral-3b-2512
    # answers fast but writes non-words in Romanian ("Sucio de lapte",
    # "Burebă de carne"), which is worse than a slow answer on a feature whose
    # entire output is prose. A second, unbilled GEMINI_FREE_API_KEY was
    # evaluated and rejected on privacy, not capability: Google's own API
    # terms say that for unpaid services "Human reviewers may read, annotate,
    # and process your API input and output" and that submissions are used to
    # improve Google products — and Coach chat carries a user's real weight,
    # calorie targets and free-text health questions. Groq's terms are the
    # opposite and are not split by tier (no training on inputs/outputs, no
    # retention by default), which for EU users under GDPR is the deciding
    # difference.
    #
    # ORDERING IS THE POLICY, and Groq is first for latency, not quality:
    # measured live, Groq answers chat in 0.3-0.7s but its free tier enforces
    # 1,000 OUTPUT tokens per minute across the whole account, so roughly
    # three requests drain it and the rest fall through. Mistral's free tier
    # reports 625,000 tokens/minute. So the walk degrades the right way —
    # sub-second when there is headroom, 5-25s when there is not, and it is
    # the 2,600-token meal-suggestion payload (which Groq rejects outright,
    # since its expected output alone exceeds that 1,000 ceiling) that
    # Mistral ends up serving most often. Putting Mistral first would make
    # every user wait 5-25s to spare the occasional fall-through.
    #
    # A third option worth provisioning if that ceiling bites in production:
    # Cerebras' free tier is published at 1M tokens/day with no comparable
    # per-minute output cliff. Its base URL is already registered in
    # gemini_service._OPENAI_COMPATIBLE_BASE_URLS, so enabling it is
    # CEREBRAS_API_KEY plus "cerebras:<model>" at the front of this list — no
    # code change. It is deliberately NOT the default because, unlike the two
    # below, it has not been probed against these prompts here.
    groq_api_key: str = ""
    cerebras_api_key: str = ""
    free_text_models: str = "groq:qwen/qwen3.8-27b,mistral:open-mistral-nemo"

    # The escape hatch for the $0.00 rule, OFF by default. Left false, a
    # chat/suggestion request that every free provider failed surfaces the
    # same "the AI could not answer" error those endpoints already handle —
    # that is the honest cost of the rule, and it is stated rather than
    # quietly patched over with a billed call. Set true to accept a small
    # spend in exchange for the feature never being unavailable.
    free_text_allow_paid_fallback: bool = False

    # --- The single non-Google fallback for the PAID pipeline ---------------
    # Purpose, precisely: a Google-side outage on the scan/describe/macro
    # path. Not quota (a paid tier makes that a non-issue at this app's
    # scale), not quality, not cost. Tried once, after Gemini has actually
    # failed, never proactively.
    #
    # ONE provider now covers both modalities, which is why there is no
    # NVIDIA_API_KEY any more. Measured live 2026-09-11, same prompts, same
    # images, six attempts each:
    #
    #   meta/llama-3.2-11b-vision (the incumbent, via NVIDIA NIM)
    #       PARSE-FAILED 5 of 6. It identifies the food correctly and then
    #       writes markdown prose ("**Food Components:**\n* Bacon\n* Eggs"),
    #       which _parse_json_response rejects. NIM has no response_format to
    #       hold it to the schema. A fallback that cannot emit the one shape
    #       its caller accepts is not a fallback.
    #   the rest of NIM's vision catalog on this key: gemma-3-12b 404s,
    #       gemma-4-31b times out past 45s, nemotron-nano-omni returns
    #       "503 ResourceExhausted: Worker local total request limit reached
    #       (28/16)" — free shared workers, saturated by strangers.
    #   mistral pixtral-12b-2409
    #       6 of 6 clean JSON, 2.2-3.8s, correct decomposition
    #       (bacon 120g + fried eggs 100g), and 937,500 tokens/minute of free
    #       headroom. It is a vision model that also answers text fine.
    #
    # Text stays on a dedicated text model (open-mistral-nemo) because it is
    # measurably better at the one job that matters here — recalling macros
    # for a Romanian food name — than either pixtral or the ministral-3b this
    # replaces. All three are poor at it; this path only runs when Google is
    # already down, and a degraded answer beats none. mistral-medium-3.5 and
    # mistral-small-2603 remain unusable: both still answer 429 with
    # x-ratelimit-limit-req-minute=0 on the free tier, re-verified 2026-09-11.
    #
    # A blank MISTRAL_API_KEY simply drops both fallbacks and a Gemini failure
    # surfaces to the caller, which every caller already handles.
    mistral_api_key: str = ""
    mistral_text_fallback_model: str = "open-mistral-nemo"
    mistral_vision_fallback_model: str = "pixtral-12b-2409"

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
    # --- Per-user AI feature daily quotas MOVED OUT OF CONFIG ---------------
    # coach_chat_daily_limit / ai_scan_daily_limit / ai_scan_describe_daily_limit
    # / ai_log_correction_daily_limit / ai_weekly_recap_daily_limit /
    # ai_weekly_recap_monthly_limit / ai_suggest_meals_daily_limit all used to
    # live here as env-overridable settings. They are now hardcoded constants in
    # services/ai_usage_service.py (_FEATURE_DAILY_LIMITS /
    # _FEATURE_MONTHLY_LIMITS), which is the single source of truth.
    #
    # Why they moved: these numbers map directly to a credit-card bill, and
    # this file sets extra="ignore" (necessary, see its own comment above), so
    # a stale AI_SCAN_DAILY_LIMIT left in the VPS .env from an earlier tuning
    # pass would silently RAISE the ceiling with nothing in the repo showing it
    # and no error anywhere. Retuning is now a code change and a deploy, which
    # is the right friction for a spend ceiling. See that module's own comment
    # for the full reasoning, including the precise (narrower) sense in which
    # this is a "bypass" fix — it was never client-reachable.
    #
    # A leftover AI_*_DAILY_LIMIT in an existing .env is now simply inert.

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
