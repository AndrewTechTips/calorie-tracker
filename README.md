<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8E75B2,50:FA520F,100:F55036&height=200&section=header&text=Iron%20Log&fontSize=70&fontColor=ffffff&fontAlignY=40&animation=fadeIn" width="100%" alt="Iron Log" />

<img src="https://readme-typing-svg.demolab.com/?font=Fira+Code&weight=600&size=20&duration=3200&pause=900&color=FA520F&center=true&vCenter=true&width=680&lines=Snap+a+photo.+Get+instant+macros.;Glassmorphism+UI+that+runs+at+native+frame+rates.;Meet+Ollie+%E2%80%94+he+lives+on+how+well+you+actually+eat.;Zero+frontend+dependencies.+Zero+framework.+Ever." alt="Iron Log" />

**Precision hypertrophy and macro tracking that removes the busywork.**

Snap a photo of your plate and get calories, protein, carbs, fats, fiber, sugar, and sodium back
in seconds — per ingredient, not just one number for the whole plate. No food database to search,
no barcode required.

[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](#%EF%B8%8F-tech-stack)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](#%EF%B8%8F-tech-stack)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](#%EF%B8%8F-tech-stack)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](#%EF%B8%8F-tech-stack)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](#-the-ai-pipeline)
[![Mistral AI](https://img.shields.io/badge/Mistral_AI-FA520F?style=for-the-badge&logo=mistralai&logoColor=white)](#-the-ai-pipeline)
[![Groq](https://img.shields.io/badge/Groq-F55036?style=for-the-badge&logo=lightning&logoColor=white)](#-the-ai-pipeline)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](#-deployment)
[![PWA](https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](#-performance--the-native-feel)

[![CI](https://img.shields.io/badge/CI-pytest_%2B_SSH_deploy-46E3B7?style=flat-square&logo=githubactions&logoColor=white)](#-deployment)
[![Backend](https://img.shields.io/badge/backend-Hetzner_VPS-003A70?style=flat-square&logo=linux&logoColor=white)](#backend--docker-compose-on-a-vps)
[![Frontend](https://img.shields.io/badge/frontend-GitHub_Pages-222222?style=flat-square&logo=githubpages&logoColor=white)](#frontend--github-pages)
[![Dependencies](https://img.shields.io/badge/runtime_JS_deps-0-success?style=flat-square)](#%EF%B8%8F-tech-stack)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#)

<sub>Built solo, end to end — backend, frontend, database, infra, design, and AI pipeline.</sub>

</div>

<br />

## Overview

Iron Log is a mobile-first nutrition and training app built around one idea: **logging food should
take seconds, not a search-and-scroll session through a database.**

Point a camera at a plate. A vision model identifies the food, estimates portion size against
real-world reference scales, checks its own arithmetic, and cross-references every ingredient
against real nutrition databases before it trusts a single number. No photo? Describe the meal in
plain English or Romanian. Got a package? Scan the barcode for an instant, deterministic lookup
that never spends an AI call at all.

Everything on top of that is designed to feel like a coach in your pocket rather than a
spreadsheet: a live calorie ring, weight forecasting with adaptive goal-setting, a full workout
diary, a fasting timer, an adherence streak with a grace token, background push notifications,
an AI coach that talks like a person — and **Ollie**, a companion who genuinely depends on how
well you eat and hydrate.

It runs as an installable PWA with **zero runtime JavaScript dependencies**, backed by a FastAPI
service on an always-on VPS.

---

## 🎨 The experience

The thing I care most about in this project: it should not feel like a hobby app. Every surface
was built to the standard of something you'd pay for.

### A first impression that earns the tap

The login screen isn't a form on a gradient — it's a small piece of theatre that plays in under
two seconds:

- **Pull the lamp cord.** A real hanging light with a pull string sits above the card. Tug it and
  the whole room warms up — a full-screen cinematic wash fades in behind everything as the app
  crosses from dark to light. That's the theme switcher, and it's discoverable *before* you have
  an account.
- **The lamp demonstrates itself.** On first load the cord pulls on its own, flares, and Ollie
  blinks awake underneath it. A control that shows you what it does needs no label — which is
  exactly why the "Try me ✨" hint is a one-time nudge and never a recurring nag.
- **Ollie sits on the card and watches.** He greets you, reacts as you move through the form,
  celebrates a successful signup — and the moment you focus the password field, **he covers his
  eyes with both wings.**
- **Progressive disclosure.** Email first, password revealed after — the form asks for one thing
  at a time instead of presenting a wall of inputs.
- **Rotating proof chips** replace the usual "your journey starts here" filler with three things
  the app actually does, cycling on a pure-CSS loop with no JS timer to leak.
- **Returning visitors get the same choreography at ~27% speed** — recognisable, never something
  to sit through.

### Glassmorphism, tuned rather than pasted on

- A single design-token system drives every frosted surface — one blur radius, one fill, one
  border, defined once and themed across **light, dark, and true AMOLED black**.
- Theme changes cross-fade like a sunrise instead of snapping.
- The glass is *measured*, not guessed: blur radii were pulled from 20/24px down to 12/14px after
  verifying the rendered output was pixel-identical (max per-channel delta **0.000/255**) — the
  frosted look comes from the fill and the border, while the radius is the part that costs GPU
  time.
- Dark-mode glass is genuinely tinted dark rather than white-at-low-alpha, the same way real
  frosted materials behave.

### Motion with intent

- **Physics-based scroll indicator** — a slim custom fill replaces the native scrollbar, glued to
  the true scroll position by a framerate-independent exponential glide. It looks identical on
  60Hz and 120Hz displays, can't overshoot or oscillate by construction, and the animation loop
  stops itself the instant it catches up, so idle pages cost nothing.
- **Swipe between tabs**, drag sheets away to dismiss, swipe journal cards for actions.
- **Staggered entrance choreography** on every view, celebration confetti rendered on a
  dependency-free canvas, and a scan flow that animates results in as they resolve.
- **Every single effect respects `prefers-reduced-motion`** — not by disabling the app, but by
  rendering the same final state without the travel.

---

## 🦉 Meet Ollie

Ollie is the app's companion, and he exists in two forms — the same character, drawn twice for two
different jobs.

### 2D Ollie — lightweight, everywhere

An inline SVG composed from a shared `<symbol>` set, so a single definition renders him on the
login screen and in the Progress tab's hero at effectively zero cost. Each independently animated
part (eyes open / happy / sick, brows, each wing) is its own symbol, which is what lets him blink,
emote, and cover his eyes without a sprite sheet or a single image request.

### 3D Ollie — the full character

A `<model-viewer>`-rendered owl living in the full-screen AI Coach sheet, with baked animation
clips for idle, thinking, talking, and a one-shot reaction — plus a 3D speech bubble anchored to
him in world space.

### He runs on your real data

This is the part that makes him more than decoration:

| | How it works |
|---|---|
| 🍗 **Hunger** | Today's logged calories as a percent of your target — computed live, no extra table, no network round trip |
| 💧 **Hydration** | Same, for water |
| ❤️ **Hearts** | The one persistent stat, judged **once per real calendar day, server-side** |
| 🎭 **Mood** | Derived from hearts by the server, so the badge and the animation can never disagree |

- **Feed him by logging.** A food or water log fires a particle burst over his HUD, plays his
  one-shot reaction clip, and puts a randomized contextual line in his speech bubble that
  references what you just logged.
- **Hearts have stakes.** A day with at least one food log, calories within tolerance, and water
  goal met heals a heart back. A bad day costs one. It moves by exactly one either direction, so a
  rough stretch is always one good day from recovering — never a one-way punishment ladder.
- **A day in progress is never judged early**, and bounded catch-up logic handles a server that was
  briefly down across a midnight boundary.
- **He visibly declines.** As hearts drop he desaturates, darkens, and his idle bob slows down —
  driven by static CSS hooks set once per mood change, so it costs nothing per frame.
- **Hearts are never client-writable.** The endpoint is read-only; the only way to move them is to
  actually eat and drink well.
- **One heart is earnable, never losable** — the weekly Discover challenge heals a heart on
  completion and can never take one away.

---

## ⚡ Performance & the native feel

A dedicated performance audit ran across four sprints, aimed at one target: **the app should be
indistinguishable from a native one on a mid-range phone.** Every item below is in the codebase
with its reasoning written next to it.

### Loading

- **Route-level code splitting.** Progress, Discover, the meal suggester, onboarding, the coach
  chat, settings, and the weekly recap each load on demand — and each brings only its **own slice
  of the translation dictionary**, split into per-tab i18n chunks rather than one monolithic
  string blob.
- **Predictive preloading.** A tab's module starts fetching the moment you begin the swipe toward
  it, so arriving feels instantaneous.
- **The 3D model and the PDF font set never load unless you ask for them.**
- **Content hashing does the cache busting.** Every bundle's filename encodes its own content, so
  a changed file is genuinely a new URL and an unchanged one serves from cache for free. The old
  hand-maintained `?v=` convention — and the script that bumped it across every file — is gone.

### Rendering

- **Domain-scoped repaints.** The dashboard knows which of four state domains actually changed, so
  a water quick-add no longer recomputes the day's totals, re-animates the calorie ring, or re-runs
  the coach's status banner — and a food log no longer redraws the water wave. Narrowing is opt-in
  per call site; the default still repaints everything, because a stale screen is a far worse bug
  than a redundant paint.
- **GPU-composited motion only.** Animations move `transform` and `opacity`, never layout
  properties — the scroll indicator, the entrance staggers, and the idle glows all stay off the
  layout/paint path.
- **`content-visibility` and CSS containment** on long lists and offscreen surfaces, so rendering
  work the user can't see doesn't get done.

### Memory

- **Ollie's 3D model releases itself.** Leave the coach sheet closed for 75 seconds and his
  geometry, textures, and animation clips are handed back to the GPU, then transparently remounted
  on your next visit. Long enough that dipping in and out never pays the reload cost; short enough
  that a forgotten sheet doesn't hold memory for the whole session.
- **Every Blob URL and particle node is explicitly reclaimed**, with failsafe cleanup for the case
  where `animationend` never fires because the tab was backgrounded.
- **Per-account teardown** wipes cached meal photos and stats on sign-out, so nothing leaks between
  accounts on a shared device.

### Network

- **Lazy ingredient payloads.** The journal list ships without per-ingredient breakdowns and
  fetches one on demand, only for the entry you actually opened.
- **Smart image compression.** Photos are decoded first and *then* resized — including iPhone HEIC,
  which used to bypass compression entirely — taking a real phone photo from 932KB to 284KB on
  upload.

### Offline (service worker v4)

A three-tier caching policy, because the tiers genuinely want different rules:

| Tier | What | Policy |
|---|---|---|
| **Immutable** | Content-hashed bundles | Cache-first, forever — the hash *is* the content |
| **Entry points** | `index.html`, legal pages, manifest | Always network-first — they point at the new hashes |
| **Stable statics** | Icons, the 3D model, backdrops | Stale-while-revalidate — instant, refreshed behind you |

- It **never** caches the API, so your food, water, and weight data is always fresh — never stale
  from a worker.
- The cache **prunes itself** precisely when a deploy lands, with a hard entry ceiling as a
  backstop, so it can't grow without bound.
- Discover Hub photos get their own separate cache bucket with its own lifecycle — a recipe photo
  stays valid across app versions, so the tab works in a gym basement.
- Nothing is precached from a hand-maintained asset list, so the worker can never drift out of
  sync with what the build actually shipped.

---

## ✨ Features

### Logging, four ways
- **📸 Photo scan** — identifies the food, estimates portion weight against real-world reference
  scales (a fist of rice, a deck-of-cards of meat), and returns a full macro *and* micronutrient
  breakdown **per ingredient**.
- **📝 Describe it** — type or dictate "a hand of nuts and a spoon of yogurt" and get the same
  structured estimate, no camera needed.
- **📦 Barcode** — the browser's native `BarcodeDetector` against Open Food Facts. Fully
  deterministic, unlimited, never spends an AI call.
- **🥫 Saved meals & custom foods** — your own pantry of reusable entries, with per-food nutrition
  facts you define once.

### The review sheet, where accuracy is actually won
Portion mass — not food identification — is the dominant error source in photo-based tracking, and
no model fixes it: a photograph simply doesn't contain the density and occlusion information
needed to recover weight. The only person who can correct it is the one who ate the food, so the
form is built entirely around making that correction effortless:
- **Weight is the primary field** — full width, larger type, its own accent — because every other
  number rescales from it live.
- **Household-measure chips** ("1 palm", "1 fist", "1 bowl") set the weight directly, since grams
  aren't the unit anyone perceives a portion in. Every value is lifted verbatim from the same
  reference anchors the vision model is told to reason with, so a user tapping "1 fist" and the
  model looking at a fist-sized mound land on the same number. Matched bilingually, diacritics
  stripped.
- **Confidence tiers** on every estimate, with a "where did this number come from" explainer —
  and a source badge showing whether a figure came from USDA, Open Food Facts, your own saved
  food, or the model's own recall.
- **The client never invents a nutrient the backend declined to invent.** A missing fiber value
  stays missing rather than being quietly guessed and rendered like a verified one.

### AI Coach
- **💬 Chat with real context** — it sees your targets, trends, streak, and today's meals, with
  full safety guardrails around calorie targets, disordered eating, and medication questions.
- **⚡ Zero-cost instant insights** — "today's focus" plus preset Q&A chips (calories left, streak,
  weekly progress, water, top food, weight forecast) computed instantly, offline, with no AI call
  at all. Chat is the bonus, not the main event.
- **🩹 Damage control** — after a meal that meaningfully overshoots, a calm, judgment-free
  rebalancing plan for the rest of the day, with a one-tap handoff into the meal suggester
  pre-filtered to lighter options.
- **🍽️ Smart meal suggestions** — real meal ideas that fit your *remaining* macros, filterable by
  high-protein / low-fat / budget / fast-prep.

### Progress — "The Pulse"
- **📈 Weight forecasting** — EMA-smoothed trend plus an empirical TDEE regression against your own
  logged history.
- **🎯 Adaptive goals** — a day-by-day energy-balance simulation surfaces a suggested target
  adjustment when your real trend drifts from your stated goal, with one-tap apply and
  individually lockable macros.
- **🚩 Under-logging detection** — a Goldberg EI:BMR plausibility check flags implausibly low
  self-reported intake instead of quietly trusting it.
- **🌊 Momentum** — a forgiving 0–100 score over a rolling 7-day window. An adherent day speeds it
  up, an off day nudges it, an unlogged day only coasts it down. It can't crash to zero, so one
  missed day is nearly invisible.
- **🏆 Trophy case & weekly history** — milestone badges grouped by area, plus a locally
  snapshotted record of past weeks (the server only retains 7 days, so older weeks are captured
  client-side and never sent anywhere).
- **💯 Every formula here is deterministic** — Mifflin-St Jeor, the TDEE regression, the Goldberg
  cutoff. Named, published methods with zero LLM calls in the path.

### Training & motivation
- **🏋️ Workout Diary** — a calendar and session diary with fast one-handed RPE set entry, curated
  routines, a 1RM calculator, and MET-based calorie-burn estimation, on its own full-screen
  surface.
- **⏱️ Fasting timer** — 16/18/20-hour windows or your own split, as two ring faces that flip
  between fasting and eating state. Fully offline.
- **🔥 Streak with a grace token** — a real adherence streak with one "freeze" per rolling window
  that forgives a single off-target day without breaking the chain.
- **🧑‍🏫 Guided onboarding** — a first-run walkthrough of every core flow, replayable from Settings.

### Discover Hub
A tab for planning, not just logging: a curated recipe catalog with a "recommended for you" strip
ranked against today's remaining macros, workout routines across experience levels, a live
exercise library with fuzzy bilingual search, live food-product search, and a **rotating weekly
challenge** — everyone gets the same one each ISO week, scored purely from what you actually
cooked, and completing it heals one of Ollie's hearts.

### 🔔 Web Push
Standards-based VAPID push (RFC 8030/8291/8292), sent straight to each browser's own push service.
No Firebase, no OneSignal, and it fires with the app fully closed:
- A background sweep every 10 minutes evaluates each user's **own local time** — daily reminders
  (fixed time or repeating interval), food and water nudges, quiet hours, and a Sunday recap.
- Warm, bilingual, deliberately non-alarming copy — this is the one place the backend talks to you
  in a moment you didn't ask for.
- Keyed per device, self-healing across silent subscription rotation, and dead endpoints are
  cleaned up inline the moment a push is rejected.
- Entirely optional: with no VAPID keys set, the whole system is inert and everything else works.

### Data, privacy & control
- **📄 Bilingual PDF export with an on-device archive** — a multi-section report persisted locally
  (OPFS, IndexedDB fallback) so a report you generated once stays available without regenerating.
- **⚖️ In-app legal center** — Privacy Policy, Terms, Disclaimers, and Data Deletion Policy, from
  one bilingual source, also published as standalone pages. States plainly that scanned photos are
  memory-only and never stored, and names every third-party processor.
- **🗑️ Full account control** — self-service "reset progress" (wipes history, keeps your account
  and saved meals) and strict type-to-confirm deletion, both gated behind their own flow.
- **⏳ Rolling retention** — food and water logs are purged on a schedule, enforced in two
  independent places so the app works on any database plan. Weight history is kept indefinitely,
  because a multi-week trend is the entire point of tracking it.
- **🌍 Fully bilingual** (English / Romanian) with strict key-parity enforced between dictionaries.

---

## 🧠 The AI pipeline

> The interesting problem here was never "call a vision model." It was: **how do you make a fast,
> cheap model produce numbers a person can trust — and make sure a bad day at one provider never
> becomes a wrong number in someone's food diary?**

### Two paths, split by whether anything downstream does math

| | Powers | Route |
|---|---|---|
| 💳 **Paid pipeline** | Photo scan, describe-a-meal, macro lookup, composite dishes | **Gemini 3.8 Flash**, with a single non-Google fallback (**Mistral** — Pixtral for vision, Nemo for text) reached only on a genuine Google-side outage |
| 🆓 **Free tier** | AI Coach chat, meal suggestions, weekly recap | **Groq** → **Mistral**, at **$0.00** |

The free tier is an operational rule, not a cost optimisation: those three features produce prose
and proposals, nothing computes with their output, so they never touch the paid key at all. Groq
leads for latency (0.3–0.7s), Mistral follows for headroom on the larger payloads.

Composite dishes — a stew, a *sarmale* plate — get a premium "chef" pass at high reasoning effort,
because they're the one path with no database floor underneath them.

### Grounded against real databases, not just model recall

A model can only ever *recall* a food's macros from training data, with no way to verify that
recollection. So every identified ingredient is checked first:

- **USDA FoodData Central** (generic and raw ingredients) and **Open Food Facts** (branded
  products) are queried **concurrently**, so grounding a six-ingredient meal costs roughly one
  lookup's latency, not six.
- A tuned confidence scorer decides what's trustworthy, with a hard gate that rejects
  form-changing mismatches — "banana" must never resolve to "banana chips" at 5× the calories,
  even though naive word overlap scores that a perfect match.
- An optional **local corpus** mirrors both sources into Postgres with vector + full-text
  retrieval fused by Reciprocal Rank Fusion, keeping most lookups entirely off the network.
  Embeddings are used strictly for *recall*, never for ranking — measured, because cosine
  similarity over short food names cheerfully ranks "Fish oil, salmon" above actual salmon.
- **Fail-open by design.** A missing key, a disabled flag, a timeout, or no confident match all
  resolve to a normal miss with the AI estimate behind it. This layer can only improve accuracy;
  it can never introduce a failure the pipeline didn't already have.

### Accuracy is a number here, not a vibe

- **An offline retrieval eval** replays 2,010 real USDA / Open Food Facts candidates — harvested
  once and frozen — through the real selection path. Deterministic, runs in milliseconds inside the
  ordinary test suite, no network and no quota. It reports grounding rate, calorie accuracy, macro
  accuracy, and a set of must-never-match guards, and **asserts a floor on each. Floors may only
  ever be raised.**
- **A live golden-macro eval** (opt-in, real providers) runs 32 end-to-end cases, deliberately
  weighted toward composite Romanian dishes and multi-ingredient plates — the least protected route
  in the pipeline.
- Real findings from this, shipped: a walnut lookup was landing on a crowdsourced row **61% wrong
  on carbohydrate** while sitting comfortably inside calorie tolerance. Energy is the least
  sensitive thing retrieval can get wrong, so the eval now asserts on macros too.

### Built so failure is boring

- **A verdict is not a failure.** "The model looked at this and said it isn't food" and "the model
  gave us nothing usable" are different exceptions with different handling — the second one
  **refunds your scan credit** and returns a retryable error instead of telling you your perfectly
  good photo was unrecognizable.
- **Truncation is retried, not surfaced.** Hidden reasoning tokens compete with the visible answer
  for the same budget; measuring the real distribution across 33 vision calls and sizing the
  reserve from it took truncation from **50% → 0%** on the hardest test photo, and *lowered* mean
  cost per scan from $0.0144 to $0.0088 — a truncated call still bills in full, and then pays for a
  retry on top.
- **Transient blips don't take the service down.** Retries, a failure-streak threshold, and a short
  cooldown replaced a single-strike circuit breaker that once took scanning offline account-wide
  for ten minutes over one upstream hiccup.
- **Hard spend ceilings.** A per-user daily allowance, an account-wide daily cap enforced at the
  single choke point every call passes through, and a bounded fan-out budget so one photo can never
  cascade into dozens of billable calls.
- **When the backup model answers, you're told.** The vision fallback is measurably worse, so a
  fallback result now carries a "double-check these numbers" note — worded specifically so it
  doesn't accidentally trip a different confidence heuristic in one language but not the other.

---

## 🔒 Security

Prompt injection against a multi-provider AI surface, and per-user isolation on a shared-service
database, are the two hardest security problems this app actually has. Both are treated as
first-class:

- **Every prompt treats its input as untrusted data, never instructions** — photos, free text, and
  chat history alike — with a fixed, silent refusal shape for anything off-task. Enforced
  structurally by a response schema, not by prompt wording alone, and funneled through a single
  parsing choke point so it doesn't have to be re-implemented per provider.
- **Every route requires a verified Supabase session JWT**, checked on every request. The backend
  never issues or trusts its own tokens.
- The service-role database client bypasses Row Level Security by necessity, so **every single
  query is explicitly scoped to the authenticated caller** — verified in code, with RLS policies
  behind it as defense in depth.
- **A strict CSP with no `unsafe-inline` and no `unsafe-eval`** (there is not one inline style
  attribute or script block in the app), and the Supabase CDN script pinned by exact SRI hash.
- **Per-user rate limiting** on every AI-triggering route, with both sustained and burst ceilings.
- The production container runs as a **non-root, shell-less service user** behind Traefik
  terminating TLS via Let's Encrypt.
- **API docs are off by default** — they're public and unauthenticated in FastAPI, and a 118KB
  machine-readable map of all 55 routes is a free gift to anyone probing.
- **Password reset copy never confirms whether an email has an account**, preventing enumeration.
- **35 test files** covering the logic worth covering — quota reset math, streak aggregation,
  retention cutoffs, ingredient bounds, refund correctness, notification eligibility, pet hearts,
  grounding scores, and the retrieval eval — run in CI on every push and PR. Not a blanket
  retrofit; the parts where a silent bug costs someone real data.

---

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| **Backend** | Python, FastAPI, Pydantic, Supabase (Postgres + RLS), slowapi, APScheduler, pywebpush |
| **AI** | Google Gemini 3.8 Flash (paid pipeline) · Mistral (fallback, both modalities) · Groq → Mistral (free tier) · USDA FoodData Central + Open Food Facts grounding · optional local corpus with fastembed/ONNX + pgvector |
| **Frontend** | Vanilla JavaScript, ES modules, **zero runtime dependencies, zero framework** · hand-rolled CSS design system · `<model-viewer>` 3D companion · inline SVG charts and character art · client-side PDF with on-device archival (OPFS/IndexedDB) |
| **Build** | Vite — one devDependency, used purely as infrastructure: bundling, minification, content hashing, multi-page entries |
| **Infra** | Docker Compose + Traefik on a self-hosted VPS (automatic TLS) · GitHub Pages for the frontend · Supabase for database and auth |
| **CI/CD** | GitHub Actions — pytest on every push/PR, SSH deploy to the host on `main`; a separate workflow builds and deploys the frontend |

<sub>No build tooling on the backend at all. The frontend's source is still hand-authored,
framework-free ES modules — Vite bundles and hashes that source for production, it doesn't change
how the app is written.</sub>

---

## 📁 Project layout

```
calorie-tracker/
├── sql/
│   ├── schema.sql                  run once in Supabase's SQL editor — source of truth
│   └── phase1_nutrition_corpus.sql optional local nutrition corpus (pgvector + full-text)
├── docker-compose.yml              production stack: FastAPI + Traefik (TLS termination)
├── deploy.sh                       run on the VPS: git pull + docker compose build/up
│
├── backend/                        FastAPI, containerized, always-on VPS
│   ├── Dockerfile                    non-root runtime user, --workers 1 (in-process
│   │                                 quota/rate-limit/scheduler state assumes one process)
│   ├── main.py                       app factory: CORS, gzip, security headers, routers,
│   │                                 schedulers, health check, optional Sentry
│   ├── config.py / database.py / auth.py / models.py / rate_limit.py
│   ├── data/discover_data.py         curated recipes, routines, exercises, weekly challenges
│   ├── scripts/                      corpus ingestion, embedding backfill, vision eval harness
│   ├── services/
│   │   ├── gemini_service.py           the AI pipeline: prompts, routing, injection defenses
│   │   ├── nutrition_db_service.py     USDA / Open Food Facts grounding + confidence scoring
│   │   ├── corpus_embedding.py         local corpus embeddings (fastembed, ONNX)
│   │   ├── ingredient_bounds.py        shared nutrition math + magnitude clamping
│   │   ├── quota_service.py            per-provider/model RPM/RPD counters + failure cooldown
│   │   ├── ai_usage_service.py         per-user daily/monthly AI allowances
│   │   ├── analytics_service.py        weight forecasting + adaptive goals — zero LLM calls
│   │   ├── workout_service.py          MET-based calorie-burn estimation
│   │   ├── pet_service.py / pet_scheduler.py         Ollie's daily hearts evaluation
│   │   ├── discover_challenge_service.py             weekly challenge rotation + scoring
│   │   ├── push_service.py / notification_*.py       Web Push, 10-min sweep, bilingual copy
│   │   ├── trends_service.py / daytime_service.py    pure aggregation + timezone boundaries
│   │   └── cleanup_service.py                        scheduled retention enforcement
│   ├── routers/                      one file per resource (20 of them)
│   └── tests/                        35 pytest files, incl. the frozen retrieval eval
│
└── frontend/                       built with Vite, deploys frontend/dist/ to Pages
    ├── index.html                    + privacy / terms / disclaimers / data-deletion
    ├── vite.config.js                multi-page entries, base "./", explicit CSS targets
    ├── public/                       copied byte-for-byte: sw.js, manifest.json, icons/,
    │                                 assets/ (Ollie's GLB + backdrop)
    ├── css/style.css + legal.css     the whole design system, tokenized and themed
    └── js/
        ├── app.js                      state, wiring, view switching — the entry point
        ├── api.js / supabaseClient.js / config.js
        ├── auth.js / authStage.js        credentials  |  the landing choreography + 2D Ollie
        ├── ui.js / coach.js / suggestions.js
        ├── scan.js / ingredientsList.js / portionPresets.js / macroMark.js
        ├── ollie3d.js / petHud.js / modelViewerLoader.js
        ├── aiCoach.js / coachChat.js / mealSuggester.js / damageControl.js / aiUsage.js
        ├── progress.js / analytics.js / charts.js / momentumMath.js / weekHistory.js
        ├── workoutDiary.js / routines.js / oneRepMax.js / fastingTimer.js / streakFreeze.js
        ├── discover.js / exerciseSearch.js / weeklyRecap.js
        ├── savedMealStats.js / savedMealPhotos.js / photoLightbox.js / photoStore.js / db.js
        ├── scrollProgress.js / confetti.js / avatar.js / tutorial.js / settings.js
        ├── notifications.js / pdfArchiveStore.js / legalContent.js
        └── i18n.js + i18n-chunks/      per-tab translation chunks, loaded with their tab
```

---

## 🚀 Getting started

### 1 · Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste and run `sql/schema.sql`. This creates every table, enables Row Level
   Security, and auto-creates a profile row for each new user.
3. **Authentication → Providers → Email** → confirm it's enabled.
4. **Authentication → URL Configuration** → add your frontend URL to both **Site URL** and
   **Redirect URLs** (required for password reset).
5. **Project Settings → API** → copy the Project URL, the `anon` key, and the `service_role` key.

### 2 · Backend

```bash
cd backend
cp .env.example .env          # fill in Supabase + AI provider values
pip install -r requirements.txt --break-system-packages   # or use a venv
uvicorn main:app --reload     # http://localhost:8000
```

At minimum you need a `GEMINI_API_KEY`. Everything else degrades gracefully when blank —
`backend/.env.example` documents every setting and where to get each key.

```bash
# tests
pip install -r requirements.txt -r requirements-dev.txt --break-system-packages
pytest
```

### 3 · Frontend

```bash
cd frontend
npm install                   # one devDependency: vite
npm run dev                   # http://localhost:5173
```

Point `API_BASE_URL` in `frontend/js/config.js` at your backend. `SUPABASE_URL` and
`SUPABASE_ANON_KEY` in that file are **not** secret — Row Level Security protects the data and the
anon key is designed to be public.

```bash
npm run build      # → frontend/dist/
npm run preview    # serve dist/ to verify exactly what ships
```

### 4 · AI provider keys

| Provider | Role | Get a key |
|---|---|---|
| **Google Gemini** | Required — the paid pipeline | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| **Groq** | Recommended — free-tier coach, suggestions, recap | [console.groq.com/keys](https://console.groq.com/keys) |
| **Mistral** | Recommended — free-tier headroom + the vision/text fallback | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| **USDA FoodData Central** | Optional — nutrition grounding | [api.data.gov/signup](https://api.data.gov/signup) |

The frontend never touches any of these — every AI call is proxied through the backend.

---

## 📦 Deployment

### Backend — Docker Compose on a VPS

The backend runs as an always-on container behind Traefik, **not** a scale-to-zero PaaS. That's a
requirement, not a preference: Web Push needs a live process to wake up and deliver at an arbitrary
time of day, and the in-process quota counters, rate limiter, and schedulers (retention cleanup,
notification sweep, Ollie's hearts) all assume one continuously running instance.

```bash
# on the server, one-time
git clone <this-repo-url> ironlog && cd ironlog
cp .env.example .env      # real values — see backend/.env.example
./deploy.sh               # build the image, bring the stack up
```

Every later deploy is `./deploy.sh` again — or let CI do it. `.github/workflows/backend-ci-cd.yml`
runs pytest on every push and PR touching `backend/**`, and on a green push to `main` SSHes into
the host and runs the deploy. **No manual step for ordinary backend changes.**

`docker-compose.yml` runs exactly two services — the FastAPI backend and Traefik in front of it.
There's no database container; the app talks to Supabase over the network.

### Frontend — GitHub Pages

Push to `main` and `.github/workflows/deploy.yml` builds with Vite and deploys `frontend/dist/`
automatically, scoped to only run when `frontend/**` actually changes. One-time manual setup:
**Settings → Pages → Build and deployment → Source** must be **"GitHub Actions"**, not "Deploy from
a branch".

### Database — Supabase

Managed Postgres + Auth. `sql/schema.sql` must be run once in the SQL editor before the backend
works. There's no migration tool — schema changes are written in the repo and applied by hand.

---

## 📬 Let's connect

<div align="center">

**Andrei Condrea**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Andrei_Condrea-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/andrei-condrea-b32148346)
[![Email](https://img.shields.io/badge/Email-condrea.andrey777%40gmail.com-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:condrea.andrey777@gmail.com)

<br />

<i>Built solo, end to end — backend, frontend, design, infra, and everything in between.</i>

</div>
