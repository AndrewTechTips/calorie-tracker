<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8E75B2,50:FA520F,100:F55036&height=200&section=header&text=Iron%20Log&fontSize=70&fontColor=ffffff&fontAlignY=40&animation=fadeIn" width="100%" alt="Iron Log" />

<img src="https://readme-typing-svg.demolab.com/?font=Fira+Code&weight=600&size=20&duration=3200&pause=900&color=FA520F&center=true&vCenter=true&width=650&lines=Snap+a+photo.+Get+instant+macros.;3-provider+AI+fallback+%E2%80%94+zero+single+point+of+failure.;Decoupled+FastAPI+%2B+Vite-built+vanilla+JS+PWA.;Ollie%2C+your+3D+companion%2C+lives+on+real+adherence." alt="Iron Log" />

**Precision hypertrophy and macro tracking that removes the busywork.**

Snap a photo of your plate and get calories, protein, carbs, fats, fiber, sugar, and sodium back
in seconds — per ingredient, not just one number for the whole plate. No food database to search,
no barcode required.

[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](#-tech-stack)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](#-tech-stack)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](#-tech-stack)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](#-tech-stack)
[![Mistral AI](https://img.shields.io/badge/Mistral_AI-FA520F?style=for-the-badge&logo=mistralai&logoColor=white)](#-resilient-task-based-ai-routing)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](#-resilient-task-based-ai-routing)
[![Groq](https://img.shields.io/badge/Groq-F55036?style=for-the-badge&logo=lightning&logoColor=white)](#-resilient-task-based-ai-routing)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](#-deployment)
[![PWA](https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](#-installable-offline-first-pwa)

[![CI](https://img.shields.io/badge/CI-pytest_%2B_SSH_deploy-46E3B7?style=flat-square&logo=githubactions&logoColor=white)](#-deployment)
[![Deploy backend](https://img.shields.io/badge/backend-Hetzner_VPS-003A70?style=flat-square&logo=linux&logoColor=white)](#backend--docker-compose-on-a-vps)
[![Deploy frontend](https://img.shields.io/badge/frontend-GitHub_Pages-222222?style=flat-square&logo=githubpages&logoColor=white)](#frontend--github-pages)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#)

<sub>Built solo, end to end — backend, frontend, database, infra, and AI routing all in one repo.</sub>

</div>

<br />

## Overview

Iron Log is a mobile-first tracking app built around one idea: logging food should take seconds,
not a search-and-scroll session through a nutrition database. Point a camera at a plate and a
vision model identifies the food, estimates portion size against real-world reference scales, and
returns a full macro and micronutrient breakdown — with a built-in arithmetic self-check so a
fast, low-cost model still lands on numbers that add up. No photo? Describe the meal in plain
English (or Romanian) instead, or scan a barcode for an instant, deterministic lookup that never
touches an AI call at all.

Everything beyond logging is designed to feel like a coach in your pocket rather than a
spreadsheet: a calorie ring and macro bars that update live, a weight/measurement trend engine
with genuine forecasting and adaptive goal-setting, a full workout diary with strength-training
routines, an intermittent fasting timer, an adherence streak with a once-a-week grace token, a 3D
companion who reacts to how well you actually eat and hydrate, background push notifications, and
an AI coach that talks like a person ("still short on protein — good time for a shake") instead of
just showing a number.

The backend is a fully decoupled FastAPI service running around the clock on a self-hosted VPS
(needed for background push notifications, not just request/response); the frontend is
dependency-free vanilla JavaScript — no framework, ever — bundled for production by Vite and
installable as a PWA that keeps working on a flaky connection.

---

## Why it's built this way

> No single AI provider is reliable enough, alone, to gate a core product feature on. Iron Log
> treats every AI call as something that **will** eventually fail, get rate-limited, or degrade —
> and routes around it automatically, in-flight, without the user ever seeing an error.

- 🔀 **Multi-provider AI routing, three deep** — every AI feature has a primary provider, a
  fallback provider, and a true last-resort, each cycling several of its own models before ever
  handing off. See [Resilient, Task-Based AI Routing](#-resilient-task-based-ai-routing).
- 🛡️ **Prompt-injection hardened by construction, not by patch** — untrusted-data framing and a
  structural JSON response schema on *every* prompt, funneled through one parsing choke point
  regardless of which provider answers.
- 🧩 **A build step only where it earns its keep** — the backend is plain FastAPI/uvicorn with zero
  build tooling; the frontend is authored as plain ES modules with no framework and no
  rearchitecting for the bundler's sake, with Vite added purely as infrastructure to hash and
  minify that same source for production instead of shipping it byte-for-byte.
- 🧮 **Deterministic math where AI adds no value** — weight forecasting, adaptive goals, and
  MET-based workout calorie burn are pure, unit-tested formulas with zero LLM calls, kept
  separate from the genuinely AI-dependent features on purpose.
- 🐧 **Always-on infra where the feature demands it** — the backend runs on a self-hosted VPS
  behind Traefik, not a scale-to-zero PaaS, specifically because background Web Push delivery
  needs a process that's alive to wake up and send a notification at an arbitrary time of day.

---

## ✨ Features

### AI-Powered Logging
- **📸 Photo scanning** — a vision model identifies the food, estimates portion weight against
  real-world reference scales (a fist of rice, a deck-of-cards of meat), and returns calories,
  protein, carbs, fats, fiber, sugar, and sodium — broken down **per ingredient**, not just as one
  aggregate number for the whole plate.
- **📝 Describe what you ate** — no camera needed; type or voice-dictate a free-text description
  ("a hand of nuts and a spoon of yogurt") and get the same structured, per-ingredient estimate.
- **📦 Barcode scanning** — a second, unlimited path via the browser's native `BarcodeDetector`
  API against Open Food Facts. Purely deterministic, never spends an AI call.
- **🥗 Nutrition database grounding** — before trusting the AI's own recalled macros, every
  identified ingredient is looked up concurrently against **USDA FoodData Central** (generic/raw
  ingredients) and **Open Food Facts** (branded/packaged products), with a tuned confidence-scored
  match that swaps in a real, verified number whenever one clears the bar — best-effort and
  fail-open, so it can only ever improve on the AI's own estimate, never introduce a new failure
  mode.
- **🧮 Editable ingredient breakdown** — every AI result, saved meal, and Discover recipe shares
  one ingredient editor: add, remove, or duplicate components, and editing a weight live-rescales
  that ingredient's macros while the card's totals recompute as a true sum, never a second guess.
- **🖼️ Meal photo lightbox** — tap any journal entry's thumbnail for an instant full-screen view
  that opens on the cached thumbnail immediately, then silently upgrades to a higher-quality
  "hero" photo in the background.

### 🔀 Resilient, Task-Based AI Routing

Every AI feature is grouped into a task, each with its own primary provider and a multi-model
fallback chain spanning **three independent providers** — never a single point of failure:

| Task | What it powers | Routing chain |
|---|---|---|
| **A · Vision** | Photo scanning | Google Gemini (multi-model, quota-aware) → NVIDIA NIM fallback |
| **B · Text / JSON** | Text-description logging, meal suggestions, food-rename re-estimation | **Mistral** (accuracy-ordered, multi-model) → Groq → native Gemini last resort |
| **C · Conversational** | AI Coach chat, weekly recap, "damage control" messages | **Mistral** (throughput-ordered, multi-model) → Groq → native Gemini last resort |

Mistral was promoted ahead of Groq as Task B/C's primary provider on production evidence of
stricter JSON-schema adherence and no hidden-reasoning-token cost on complex multi-ingredient
descriptions — a failure class that was silently truncating results under Groq's reasoning-model
tier. Groq remains a real, independently quota-tracked fallback rather than being removed.

<details>
<summary><b>How the fallback actually works, end to end</b></summary>

<br />

- **Per-model cycling, not just per-provider.** Each provider in each chain cycles its own
  ordered list of models — every model has an independent quota pool, so a chain can absorb
  several rate-limited models before the whole provider is considered exhausted.
- **Proactive + reactive routing.** A quota tracker picks the first candidate with live headroom
  *before* the call; a retryable error (429/500/503/402) during the call falls through the rest of
  the chain reactively, without failing the request back to the user.
- **Reasoning-model awareness.** Some Groq models (`gpt-oss-*`, `qwen3.6`) spend hidden reasoning
  tokens out of the same budget as the visible answer — detected by name and given an explicit low
  reasoning-effort hint, plus a reserved token buffer, so they don't silently return truncated
  JSON.
- **A genuine last resort, not a repeat of the shim.** When every OpenAI-compatible provider in a
  chain fails, Task B/C fall through to Gemini's **native** SDK (not the OpenAI-compatible shim,
  which can't disable "thinking" on any model this account can reach) — on a deliberately separate
  quota pool so it never competes with Task A's vision traffic.
- **Per-user AND per-provider quota enforcement.** A DB-backed, per-user daily allowance (survives
  a redeploy/restart) sits on top of the in-memory per-(provider, model) RPM/RPD counters — the
  quota bar in Settings reflects real, live headroom, not a static number.

</details>

### AI Coach
- **💬 Chat with context** — a capped daily allowance of free-text conversation with a coach that
  sees your real targets, trends, streak, and today's meals, with the same untrusted-input
  handling and safety guardrails (no unsafe calorie targets, no disordered-eating guidance) as
  every other AI surface.
- **⚡ Zero-cost instant insights** — a proactive "today's focus" line and preset Q&A chips
  (calories left, streak, weekly progress, water, top food, weight forecast) computed instantly and
  offline, no AI call at all — chat is the bonus, not the primary way to use the coach.
- **🩹 Damage control** — a non-blocking card that appears after a meal that meaningfully blows
  past target, with a calm, judgment-free rebalancing plan for the rest of the day and a one-tap
  handoff into the meal suggester, pre-filtered to lighter options.
- **🍽️ Smart meal suggestions** — asks for real-world meal ideas that fit your remaining macros
  for the day, filterable (high-protein, low-fat, budget, fast-prep), each with its own editable
  per-ingredient breakdown.

### 🦉 Ollie — a 3D companion with real stakes
A `<model-viewer>`-rendered owl living inside the AI Coach sheet, driven by a genuine Tamagotchi
gamification layer on top of your real tracking data — not a gimmick bolted onto the chat window:
- **Hunger and hydration** are today's already-logged calories/water expressed as a percent of
  target, computed live — feeding and hydrating Ollie is instant, with zero extra network round
  trips.
- **Hearts** are the one persistent stat, judged **once per real calendar day, server-side**: a
  day with at least one food log, calories within tolerance of target, and water goal met heals a
  heart back; a bad day costs one. Bounded catch-up logic handles a server that was briefly down
  across a day boundary, and a day in progress is never judged early.
- **Mood-reactive idle animation** — Ollie visibly desaturates and slows down as hearts drop,
  using the exact same server-computed mood the hearts badge shows, never a second frontend
  judgment.
- **Live reactions** — a floating particle burst plus a contextual, randomized speech-bubble line
  fires the moment a food or water log lands, with its own auto-hide lifecycle so messages never
  overlap or get stuck.

### Predictive Analytics & Adaptive Goals
- **📈 Weight forecasting** — EMA-smoothed trend plus an empirical TDEE regression against your
  own logged weight history, projected out over time.
- **🎯 Adaptive goal engine** — a day-by-day energy-balance simulation surfaces a suggested target
  adjustment when your real trend has drifted from your stated goal, with a one-tap "apply" and
  individually lockable macros for anything you don't want auto-adjusted.
- **🚩 Under-logging detection** — a Goldberg EI:BMR-style plausibility check flags implausibly
  low self-reported intake as likely under-logging instead of quietly trusting it.
- **100% deterministic** — every formula here (Mifflin-St Jeor, the TDEE regression, the Goldberg
  cutoff) is a named, published method with zero LLM calls anywhere in the path — see
  `backend/services/analytics_service.py`.

### Training & Motivation
- **🏋️ Workout Diary** — a full calendar + session diary with fast, one-handed RPE set entry,
  curated strength-training routines, MET-based calorie-burn estimation per session, and its own
  dedicated full-screen surface (not just another sheet) — see `backend/services/workout_service.py`
  and `frontend/js/workoutDiary.js`/`routines.js`.
- **⏱️ Intermittent fasting timer** — a 16/18/20-hour fasting window (or your own custom split),
  visualized as two ring faces that flip between "fasting" and "eating" state, fully offline.
- **🔥 Adherence streak with a grace token** — a genuine calorie-adherence streak computed from
  real logged history, with one "freeze" per rolling window that forgives a single off-target day
  without breaking the chain.
- **🎉 Confetti, without the bloat** — a dependency-free canvas particle effect that celebrates
  hitting a target, skipped automatically under `prefers-reduced-motion`.
- **🧑‍🏫 Guided onboarding** — a first-run walkthrough covering every core flow, replayable
  anytime from Settings.

### 🔔 Web Push Notifications
Standards-based VAPID push (RFC 8030/8291/8292), sent directly to whatever push service each
browser's own subscription endpoint points at — no Firebase, no OneSignal, and it fires even with
the app fully closed:
- A background sweep (APScheduler, every 10 minutes) evaluates each user's own local time against
  their preferences — daily reminders (fixed time or repeating interval), food/water nudges,
  quiet hours, and a Sunday weekly recap.
- Warm, bilingual, non-alarming copy (never system-alert-toned) with graceful 404/410 handling —
  a dead subscription is cleaned up inline the moment a push to it is rejected, so nothing bloats.
- Fully optional and inert until configured: with no VAPID keys set, the relevant endpoints 503
  cleanly instead of crashing, and the rest of the app is entirely unaffected.

### Discover Hub
A single tab for planning, not just logging: a curated recipe catalog (with a "recommended for
you" strip ranked against today's remaining macros), curated workout routines across experience
levels and goals, a live exercise-library search with fuzzy matching and bilingual query
translation, and a live food-product search against Open Food Facts.

### Data, Privacy & Compliance
- **📄 Bilingual PDF export, with an on-device archive** — a multi-section report (food logs,
  water, weight, workouts, and a rolled-up daily summary) that's also persisted locally (OPFS, with
  an IndexedDB fallback) so a report you generated once stays available for re-viewing or
  re-sharing without regenerating it.
- **⚖️ In-app legal center** — Privacy Policy, Terms of Service, Disclaimers, and a Data Deletion
  Policy, sourced from one bilingual document and also published as standalone public pages.
  Explicitly documents that AI photo scanning is memory-only and never stored, and discloses every
  third-party processor by name.
- **🗑️ Full account control** — a self-service "reset progress" (wipes history, keeps your
  account and saved meals) and a strict, type-to-confirm account deletion, both gated behind their
  own confirmation flow.
- **⏳ Rolling data retention** — food/water logs are kept on a rolling window and purged on a
  schedule (weight history is kept indefinitely, since a multi-week trend is the point of tracking
  it), enforced in two independent places so the app works regardless of database plan.

### Installable, Offline-First PWA
- A service worker that caches the static app shell at runtime (no hand-maintained asset list to
  keep in sync) so the app opens instantly even on a flaky connection — while food, water, and
  weight data are always fetched fresh, never served stale.
- A deterministic, locally-generated initials avatar (no third-party avatar service) when no
  custom photo is set, and a lightweight photo upload path that stays entirely within a Postgres
  text column — no storage bucket dependency.
- Fully bilingual (English/Romanian) with strict key-parity enforced between both dictionaries.

---

## 🔒 Security

Prompt-injection defense against a multi-provider AI surface, and strict per-user data isolation
on a shared-service database, are the two hardest security problems this app actually has — both
are treated as first-class, not an afterthought:

- Every AI prompt treats the photo, free text, and chat history it receives as untrusted *data*,
  never instructions — enforced by a structural response schema, not prompt wording alone — with a
  fixed, silent refusal shape for any off-task or injection attempt, applied identically across
  every provider in every fallback chain.
- Every route requires a verified Supabase session JWT, checked against Supabase on every
  request — the backend never issues or trusts its own tokens.
- The service-role database client bypasses Row Level Security by design (it has to, to serve
  every user), so every single query is explicitly scoped to the authenticated caller — verified
  in code, not just assumed.
- A strict Content-Security-Policy with no `unsafe-inline`/`unsafe-eval`, and the Supabase CDN
  script pinned by exact subresource integrity hash.
- Every AI-triggering route is rate-limited per authenticated user, on top of both shared
  provider-level quota tracking and a DB-backed per-user daily allowance that survives a restart.
- The production container runs as a non-root, shell-less service user with no capability to
  write outside its own app directory, behind Traefik terminating TLS via Let's Encrypt.
- Self-service password reset with copy that never confirms or denies whether a given email has an
  account, preventing user enumeration.
- A genuinely broad pytest suite (20+ files) covering the logic that's worth covering: quota
  reset-at-midnight math, streak/trend aggregation, retention cutoff math, barcode error mapping,
  predictive-analytics formulas, workout calorie-burn math, notification eligibility/quiet-hours
  math, pet-hearts evaluation, and nutrition-database-grounding scoring — run automatically in CI
  on every push and PR, not a blanket retrofit for its own sake.

---

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| **Backend** | Python, FastAPI, Pydantic, Supabase (Postgres + Row Level Security), slowapi rate limiting, APScheduler, pywebpush (Web Push) |
| **AI routing** | Mistral AI (Task B/C primary) → Groq (fallback) → Google Gemini native SDK (last resort) for text/chat; Google Gemini (`google-genai`) → NVIDIA NIM for vision — OpenAI-compatible providers called via `openai.AsyncOpenAI`, task-based routing with per-model quota tracking |
| **Frontend** | Vanilla JavaScript (ES modules, zero framework), built and content-hashed for production by **Vite**, hand-rolled CSS design system, `<model-viewer>`-rendered 3D companion, inline SVG charts, client-side PDF generation with on-device archival (OPFS/IndexedDB) |
| **Infra** | Docker Compose + Traefik (backend, self-hosted VPS, automatic TLS via Let's Encrypt), GitHub Pages via GitHub Actions (frontend), Supabase (database + auth) |
| **CI/CD** | GitHub Actions — pytest on every push/PR, SSH deploy to the backend host on `main`; a separate workflow builds the frontend with Vite and deploys to Pages |
| **External data** | Open Food Facts (barcode/product lookup), USDA FoodData Central (nutrition grounding), a public exercise database (training library) |

<sub>No build tooling on the backend, and the frontend's own source is still hand-authored,
framework-free ES modules — Vite only bundles/hashes/minifies that source for production, it
doesn't change how the app is written.</sub>

---

## 📁 Project layout

```
calorie-tracker/
├── sql/schema.sql            ← run once in Supabase's SQL editor; source of truth for the schema
├── docker-compose.yml        ← production stack: FastAPI backend + Traefik (TLS termination)
├── deploy.sh                  run on the VPS: git pull + docker compose build/up
├── backend/                   FastAPI, containerized, deployed to a self-hosted VPS
│   ├── Dockerfile               multi-stage build, non-root runtime user, --workers 1 (in-memory
│   │                            quota/rate-limit/scheduler state assumes a single process)
│   ├── main.py                   app factory: CORS, gzip, security headers, rate-limit wiring,
│   │                             routers, health check, scheduler startup, optional Sentry init
│   ├── config.py                  all settings, read from environment variables
│   ├── database.py                 Supabase client factories (service-role + anon)
│   ├── auth.py                      verifies the Supabase session JWT on every request
│   ├── models.py                     Pydantic request/response schemas
│   ├── render.yaml                    alternate one-click Render Blueprint deploy path
│   ├── data/discover_data.py            curated recipes, workout routines, and exercises
│   ├── services/
│   │   ├── gemini_service.py            task-based AI routing, prompts, prompt-injection defenses
│   │   ├── quota_service.py               generic per-provider/per-model shared quota tracking
│   │   ├── ai_usage_service.py              per-user, DB-backed AI feature quota (survives restarts)
│   │   ├── nutrition_db_service.py            USDA / Open Food Facts grounding for AI macro estimates
│   │   ├── analytics_service.py                 weight forecasting + adaptive goals, zero LLM calls
│   │   ├── workout_service.py                     MET-based workout calorie-burn estimation
│   │   ├── pet_service.py / pet_scheduler.py        Ollie's daily hearts evaluation
│   │   ├── push_service.py / notification_scheduler.py / notification_copy.py   Web Push sending,
│   │   │                                              10-min sweep, bilingual copy templates
│   │   ├── notification_service.py                  pure, unit-tested notification eligibility math
│   │   ├── food_cache_service.py / coach_cache_service.py / exercise_cache_service.py  in-memory
│   │   │                                              caches for repeat AI/API lookups
│   │   ├── trends_service.py                          pure daily/streak aggregation
│   │   ├── daytime_service.py                           timezone-aware "what day is it" boundary math
│   │   └── cleanup_service.py                            scheduled data-retention cleanup
│   ├── routers/                     one file per resource — account, targets, scan, barcode, logs,
│   │                                 meals, water, weight, measurements, workouts, routines, trends,
│   │                                 coach, day, foods, discover, analytics, ai_usage, notifications, pet
│   └── tests/                        pytest — 20+ files covering every pure/critical service above
└── frontend/                  built with Vite, deploys frontend/dist/ to GitHub Pages
    ├── index.html               + privacy/terms/disclaimers/data-deletion.html — Vite's multi-page
    │                            entries (vite.config.js's rollupOptions.input)
    ├── vite.config.js            multi-page input list, base: "./" (portable to any Pages subpath),
    │                            publicDir: "public"
    ├── package.json / package-lock.json   one devDependency (vite) — commit the lockfile, CI's
    │                            `npm ci` depends on it matching exactly
    ├── public/                  copied to dist/ byte-for-byte, unbundled/unhashed — sw.js (service
    │   ├── manifest.json          worker scope requires a stable URL), manifest.json + icons/ (PWA
    │   ├── icons/                 install), assets/ (Ollie's 3D model + background, referenced via a
    │   └── assets/                 <model-viewer src="..."> attribute Vite's HTML scanner won't see)
    ├── dist/                    Vite's build output — gitignored, this is what actually deploys
    ├── css/style.css + legal.css
    └── js/
        ├── config.js               Supabase URL/key + API base URL + VAPID public key (not secret)
        ├── api.js                   fetch wrapper, attaches the session JWT to every call
        ├── auth.js                   login/signup/password-reset flow (+ optional Turnstile)
        ├── i18n.js / i18n-chunks/      English/Romanian dictionary, strict key-parity
        ├── ui.js / coach.js             rendering + humanized status-banner copy logic
        ├── scan.js / mealSuggester.js     AI + barcode scan flow, smart meal suggestions
        ├── aiCoach.js / coachChat.js / aiUsage.js   zero-cost insights, coach chat UI, quota bar
        ├── ollie3d.js / petHud.js / modelViewerLoader.js   Ollie's 3D model + gamification HUD
        ├── damageControl.js                  post-overage rebalancing card
        ├── progress.js / analytics.js / charts.js   weight/measurement charts, forecast + goals
        ├── workoutDiary.js / routines.js / oneRepMax.js   calendar, session diary, routines
        ├── fastingTimer.js / streakFreeze.js       fasting timer, streak grace-token logic
        ├── discover.js / exerciseSearch.js / exerciseI18n.js   recipes, routines, exercise search
        ├── notifications.js                         Web Push subscribe/preferences UI
        ├── photoLightbox.js / photoStore.js / db.js   full-screen meal photo viewer + local storage
        ├── pdfArchiveStore.js / pdfFonts.js             on-device PDF report archive
        ├── avatar.js / confetti.js                       profile photo/initials, celebration effect
        ├── legalContent.js / legalPage.js                 bilingual legal center
        ├── tutorial.js                                     guided first-run onboarding
        ├── nutritionMath.js / ingredientsList.js             shared macro/BMR/forecasting math
        └── app.js                                             app state, event wiring — entry point
```

---

## 🚀 Getting started

### 1 · Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste and run `sql/schema.sql`. This creates every table, enables Row Level
   Security, and auto-creates a profile row for each new signed-up user.
3. **Authentication → Providers → Email** → confirm it's enabled, and decide whether you want
   "Confirm email" on (recommended).
4. **Authentication → URL Configuration** → add your deployed frontend URL to both **Site URL**
   and **Redirect URLs** (needed for the password-reset email flow to work).
5. **Project Settings → API** → copy your Project URL, `anon` public key, and `service_role` key
   — you'll need all three below.

### 2 · Backend (local development)

```bash
cd backend
cp .env.example .env          # fill in Supabase + AI provider values (see below)
pip install -r requirements.txt --break-system-packages   # or use a venv
uvicorn main:app --reload     # local dev at http://localhost:8000
```

At minimum you'll need `GEMINI_API_KEY` (photo scanning) and **either** `MISTRAL_API_KEY`
(Task B/C primary — recommended) **or** `GROQ_API_KEY` (Task B/C fallback) — all three have free
tiers with no credit card required. Every other provider key (NVIDIA, USDA, VAPID/Web Push,
Sentry) is optional and degrades gracefully when blank; see `backend/.env.example` for the full,
heavily-commented list of every setting and where to get each key.

Run the test suite with:

```bash
pip install -r requirements.txt -r requirements-dev.txt --break-system-packages
pytest
```

### 3 · Frontend (local development)

```bash
cd frontend
npm install                   # one devDependency: vite
npm run dev                   # Vite dev server at http://localhost:5173
```

Edit `frontend/js/config.js` to point `API_BASE_URL` at your local backend
(`http://localhost:8000`) or your deployed backend's URL. `SUPABASE_URL`/`SUPABASE_ANON_KEY` in
that file are not secret (Row Level Security protects the data; the anon key is meant to be
public).

To sanity-check a production build locally:

```bash
npm run build       # → frontend/dist/
npm run preview      # serves dist/ so you can verify what actually ships
```

---

## 📦 Deployment

### Backend — Docker Compose on a VPS

The backend runs as an always-on container behind Traefik (TLS via Let's Encrypt), not a
scale-to-zero PaaS — this is required for Web Push notifications, which need a live process to
wake up and deliver a message at an arbitrary time of day, and for the in-process quota/rate-limit
counters and APScheduler jobs (cleanup, notification sweep, Ollie's daily hearts evaluation) that
assume a single, continuously-running instance.

```bash
# on the server, one-time setup
git clone <this-repo-url> ironlog && cd ironlog
cp .env.example .env      # fill in real values (see backend/.env.example for the full list)
./deploy.sh               # builds the backend image and brings the stack up
```

Every subsequent deploy is just `./deploy.sh` again (or let CI do it — see below).
`docker-compose.yml` runs exactly two services: the FastAPI backend and Traefik in front of it;
there is no local database container, since the app talks to Supabase over the network.

CI/CD (`.github/workflows/backend-ci-cd.yml`) runs the pytest suite on every push/PR touching
`backend/**`, and on a successful push to `main`, SSHes into the host and runs `deploy.sh`
automatically — no manual deploy step for ordinary changes.

An alternate one-click path (`backend/render.yaml`, a Render Blueprint) is also kept in the repo
for anyone who'd rather not manage their own VPS — note that Web Push delivery specifically
depends on an always-on host, so it won't fire reliably on a scale-to-zero plan.

### Frontend — GitHub Pages

Push to `main` and `.github/workflows/deploy.yml` builds the frontend with Vite and deploys
`frontend/dist/` automatically via `actions/configure-pages` + `actions/upload-pages-artifact` +
`actions/deploy-pages` — scoped to only run when `frontend/**` actually changes. One-time manual
setup: **Settings → Pages → Build and deployment → Source** must be **"GitHub Actions"**, not
"Deploy from a branch".

### Database — Supabase

Managed Postgres + Auth; `sql/schema.sql` must be run once via the SQL editor before the backend
will work. There's no migration tool — schema changes are written here but applied by hand in the
SQL editor.

### 4 · AI provider keys

| Provider | Role | Get a key |
|---|---|---|
| **Google Gemini** | Required — Task A vision primary, Task B/C last resort | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| **Mistral AI** | Recommended — Task B/C primary | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| **Groq** | Recommended — Task B/C fallback | [console.groq.com/keys](https://console.groq.com/keys) |
| **NVIDIA NIM** | Optional — Task A vision fallback | [build.nvidia.com](https://build.nvidia.com) |
| **USDA FoodData Central** | Optional — nutrition database grounding | [api.data.gov/signup](https://api.data.gov/signup) |

The frontend never touches any of these keys — every AI call is proxied through the backend.

---

## 📬 Let's connect

<div align="center">

**Andrei Condrea**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Andrei_Condrea-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/andrei-condrea-b32148346)
[![Email](https://img.shields.io/badge/Email-condrea.andrey777%40gmail.com-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:condrea.andrey777@gmail.com)

<br />

<i>Built solo, end to end — backend, frontend, infra, and everything in between.</i>

</div>
</content>
