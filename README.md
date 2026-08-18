<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:8E75B2,50:FA520F,100:F55036&height=200&section=header&text=Iron%20Log&fontSize=70&fontColor=ffffff&fontAlignY=40&animation=fadeIn" width="100%" alt="Iron Log" />

<img src="https://readme-typing-svg.demolab.com/?font=Fira+Code&weight=600&size=20&duration=3200&pause=900&color=FA520F&center=true&vCenter=true&width=600&lines=Snap+a+photo.+Get+instant+macros.;3-provider+AI+fallback+%E2%80%94+zero+single+point+of+failure.;Decoupled+FastAPI+%2B+zero-build+vanilla+JS.;Prompt-injection+hardened+by+design." alt="Iron Log — Snap a photo. Get instant macros. 3-provider AI fallback. Decoupled FastAPI + vanilla JS. Prompt-injection hardened by design." />

**Precision hypertrophy and macro tracking that removes the busywork.**

Snap a photo of your plate and get calories, protein, carbs, fats, fiber, sugar, and sodium back
in seconds — per ingredient, not just one number for the whole plate. No food database to search,
no barcode required.

[![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)](#-tech-stack)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)](#-tech-stack)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](#-tech-stack)
[![Mistral AI](https://img.shields.io/badge/Mistral_AI-FA520F?style=for-the-badge&logo=mistralai&logoColor=white)](#-resilient-task-based-ai-routing)
[![Google Gemini](https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white)](#-resilient-task-based-ai-routing)
[![Groq](https://img.shields.io/badge/Groq-F55036?style=for-the-badge&logo=lightning&logoColor=white)](#-resilient-task-based-ai-routing)
[![PWA](https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)](#-installable-offline-first-pwa)

[![No build step](https://img.shields.io/badge/build_step-none-success?style=flat-square)](#️-tech-stack)
[![Deploy backend](https://img.shields.io/badge/backend-Render-46E3B7?style=flat-square&logo=render&logoColor=white)](#deploy-the-backend)
[![Deploy frontend](https://img.shields.io/badge/frontend-GitHub_Pages-222222?style=flat-square&logo=githubpages&logoColor=white)](#deploy-the-frontend)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#)

<sub>Built solo, end to end — backend, frontend, database, and AI routing all in one repo.</sub>

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
with genuine forecasting and adaptive goal-setting, a full workout diary, an intermittent fasting
timer, an adherence streak with a once-a-week grace token, and an AI coach that talks like a
person ("still short on protein — good time for a shake") instead of just showing a number.

The backend is a fully decoupled FastAPI service; the frontend is dependency-free vanilla
JavaScript with no build step, installable as a PWA that keeps working on a flaky connection.

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
- ⚡ **Zero build step, either side** — the backend is plain FastAPI/uvicorn; the frontend is
  static ES modules served straight off GitHub Pages. Clone, fill in three env vars, run.
- 🧮 **Deterministic math where AI adds no value** — weight forecasting, adaptive goals, and
  MET-based workout calorie burn are pure, unit-tested formulas with zero LLM calls, kept
  separate from the genuinely AI-dependent features on purpose.

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

Mistral was promoted ahead of Groq as Task B/C's primary provider after production evidence of
more reliable JSON-schema adherence and no hidden-reasoning-token cost on complex multi-ingredient
descriptions — a failure class that was silently truncating results under Groq's reasoning-model
tier. Groq remains a real, independently-quota-tracked fallback rather than being removed.

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
  which can't disable "thinking" on any reachable model) — on a deliberately separate quota pool
  so it never competes with Task A's vision traffic.
- **Per-user AND per-provider quota enforcement.** A DB-backed, per-user daily allowance (survives
  a Render restart) sits on top of the in-memory per-(provider, model) RPM/RPD counters — the
  quota bar in Settings reflects real, live headroom, not a static number.

</details>

### AI Coach
- **💬 Chat with context** — a capped daily allowance of free-text conversation with a coach that
  sees your real targets, trends, streak, and today's pre/post-workout-tagged meals, with the same
  untrusted-input handling and safety guardrails (no unsafe calorie targets, no disordered-eating
  guidance) as every other AI surface.
- **⚡ Zero-cost instant insights** — a proactive "today's focus" line and preset Q&A chips
  (calories left, streak, weekly progress, water, top food, weight forecast) computed instantly and
  offline, no AI call at all — chat is the bonus, not the primary way to use the coach.
- **🩹 Damage control** — a non-blocking card that appears after a meal that meaningfully blows
  past target, with a calm, judgment-free rebalancing plan for the rest of the day and a one-tap
  handoff into the meal suggester, pre-filtered to lighter options.
- **🍽️ Smart meal suggestions** — asks for 3–4 real-world meal ideas that fit your remaining
  macros for the day, filterable (high-protein, low-fat, budget, fast-prep), each with its own
  editable per-ingredient breakdown.
- **🧠 Zero-cost suggestions** — a separate, fully offline nudge card that ranks your *own* saved
  meals against remaining macros and surfaces whichever exercise your training log shows as
  least-recently trained — no model call involved.

### Predictive Analytics & Adaptive Goals
- **📈 Weight forecasting** — EMA-smoothed trend plus an empirical TDEE regression against your
  own logged weight history, projected 30/60/90 days out.
- **🎯 Adaptive goal engine** — a day-by-day energy-balance simulation surfaces a suggested target
  adjustment when your real trend has drifted from your stated goal, with a one-tap "apply" and
  individually lockable macros for anything you don't want auto-adjusted.
- **🚩 Under-logging detection** — a Goldberg EI:BMR-style plausibility check flags implausibly
  low self-reported intake as likely under-logging instead of quietly trusting it.
- **100% deterministic** — every formula here (Mifflin-St Jeor, the TDEE regression, the
  Goldberg cutoff) is a named, published method with zero LLM calls anywhere in the path — see
  `backend/services/analytics_service.py`.

### Training & Motivation
- **🏋️ Workout Diary** — a full calendar + session diary with fast, one-handed RPE set entry,
  MET-based calorie-burn estimation per session, and its own dedicated full-screen surface (not
  just another sheet). Backed by `backend/services/workout_service.py`, fully unit-tested.
- **⏱️ Intermittent fasting timer** — a 16/18/20-hour fasting window (or your own custom split),
  visualized as two ring faces that flip between "fasting" and "eating" state, fully offline.
- **🔥 Adherence streak with a grace token** — a genuine calorie-adherence streak computed from
  real logged history, with one "freeze" per rolling 7 days that forgives a single off-target day
  without breaking the chain.
- **🎉 Confetti, without the bloat** — a dependency-free canvas particle effect that celebrates
  hitting a protein or fiber target, skipped automatically under `prefers-reduced-motion`.
- **🧑‍🏫 Guided onboarding** — a first-run walkthrough covering every core flow, replayable
  anytime from Settings.

### Discover Hub
A single tab for planning, not just logging: a curated recipe catalog (with a "recommended for
you" strip ranked against today's remaining macros), curated workout plans across experience
levels and goals — now with offline-cached images and info for the whole plan — a live
exercise-library search, and a live food-product search against Open Food Facts.

### Data, Privacy & Compliance
- **📄 Bilingual PDF export, now with an on-device archive** — a multi-section report (food logs,
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
- Self-service password reset with copy that never confirms or denies whether a given email has an
  account, preventing user enumeration.
- A deliberately-scoped pytest suite covers the logic that's genuinely worth covering: quota
  reset-at-midnight math, streak/trend aggregation, retention cutoff math, barcode error mapping,
  predictive-analytics formulas, and workout calorie-burn math — not a blanket retrofit for its
  own sake.

---

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| **Backend** | Python, FastAPI, Pydantic, Supabase (Postgres + Row Level Security), slowapi rate limiting, APScheduler |
| **AI routing** | Mistral AI (Task B/C primary) → Groq (fallback) → Google Gemini native SDK (last resort) for text/chat; Google Gemini (`google-genai`) → NVIDIA NIM for vision — all OpenAI-compatible providers called via `openai.AsyncOpenAI`, task-based routing with per-model quota tracking |
| **Frontend** | Vanilla JavaScript (ES modules, zero build step, zero framework), hand-rolled CSS design system, inline SVG charts, client-side PDF generation with on-device archival (OPFS/IndexedDB) |
| **Infra** | Render (backend), GitHub Pages via GitHub Actions (frontend), Supabase (database + auth) |
| **External data** | Open Food Facts (barcode/product lookup), a public exercise database (training library) |

<sub>No build tooling, no bundler, no framework runtime on either side — this is a deliberate
constraint, not a limitation: clone the repo, fill in three environment values, and both halves
run exactly as committed.</sub>

---

## 📁 Project layout

```
calorie-tracker/
├── sql/schema.sql            ← run once in Supabase's SQL editor; source of truth for the schema
├── backend/                   FastAPI, deploys to Render
│   ├── main.py                  app factory: CORS, security headers, rate limiting, routers
│   ├── config.py                 all settings, read from environment variables
│   ├── database.py                Supabase client factories (service-role + anon)
│   ├── auth.py                     verifies the Supabase session JWT on every request
│   ├── models.py                    Pydantic request/response schemas
│   ├── render.yaml                 Render Blueprint — one-click backend deploy
│   ├── data/discover_data.py         curated recipes, workout plans, and exercises
│   ├── services/
│   │   ├── gemini_service.py           task-based AI routing, prompts, prompt-injection defenses
│   │   ├── quota_service.py             generic per-provider/per-model shared quota tracking
│   │   ├── ai_usage_service.py           per-user, DB-backed AI feature quota (survives restarts)
│   │   ├── analytics_service.py           weight forecasting + adaptive goals, zero LLM calls
│   │   ├── workout_service.py              MET-based workout calorie-burn estimation
│   │   ├── food_cache_service.py            caches repeat text-only macro lookups
│   │   ├── coach_cache_service.py            caches weekly recaps + short-lived chat stats
│   │   ├── exercise_cache_service.py          bulk-fetch-and-cache for the exercise library
│   │   ├── trends_service.py                   pure daily/streak aggregation (fully unit-tested)
│   │   ├── daytime_service.py                   timezone-aware "what day is it" boundary math
│   │   └── cleanup_service.py                    scheduled data-retention cleanup
│   ├── routers/                     one file per resource — account, targets, scan, barcode,
│   │                                 logs, meals, water, weight, measurements, workouts, trends,
│   │                                 coach, day, foods, discover, analytics, ai_usage
│   └── tests/                        pytest — the genuinely critical logic, not a full retrofit
└── frontend/                  static site, deploys to GitHub Pages
    ├── index.html
    ├── manifest.json + sw.js    PWA shell, runtime caching
    ├── bump_version.py           rewrites every cache-busting ?v= in one shot
    └── js/
        ├── config.js               Supabase URL/key + API base URL (not secret — see below)
        ├── api.js                   fetch wrapper, attaches the session JWT to every call
        ├── auth.js                   login/signup/password-reset flow
        ├── i18n.js                    English/Romanian dictionary, strict key-parity
        ├── ui.js / coach.js             rendering + humanized status-banner copy logic
        ├── scan.js / mealSuggester.js     AI + barcode scan flow, smart meal suggestions
        ├── aiCoach.js / coachChat.js        zero-cost insights + full coach chat UI
        ├── damageControl.js                  post-overage rebalancing card
        ├── progress.js / analytics.js          weight/measurement charts, forecast + adaptive goals
        ├── workoutDiary.js                       calendar, session diary, RPE set entry
        ├── fastingTimer.js / streakFreeze.js       fasting timer, streak grace-token logic
        ├── discover.js                              recipes, workout plans, exercise/product search
        ├── photoLightbox.js / photoStore.js           full-screen meal photo viewer + hero storage
        ├── pdfArchiveStore.js / pdfFonts.js             on-device PDF report archive
        ├── avatar.js / confetti.js                       profile photo/initials, celebration effect
        ├── legalContent.js / legalPage.js                 bilingual legal center
        ├── tutorial.js                                     guided first-run onboarding
        ├── nutritionMath.js                                 shared macro/BMR/forecasting math
        ├── reminders.js                                      opt-in local notification reminders
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

### 2 · Backend

```bash
cd backend
cp .env.example .env          # fill in Supabase + AI provider values (see below)
pip install -r requirements.txt --break-system-packages   # or use a venv
uvicorn main:app --reload     # local dev at http://localhost:8000
```

At minimum you'll need `GEMINI_API_KEY` (photo scanning) and **either** `MISTRAL_API_KEY`
(Task B/C primary — recommended) **or** `GROQ_API_KEY` (Task B/C fallback) — all three have free
tiers with no credit card required. Every other provider key is an optional extra fallback layer;
see `backend/.env.example` for the full, heavily-commented list of every setting and where to get
each key.

Run the test suite with:

```bash
pip install -r requirements.txt -r requirements-dev.txt --break-system-packages
pytest
```

#### Deploy the backend

The easy way is a Render Blueprint: **New → Blueprint**, select this repo, and set
**Blueprint Path** to `backend/render.yaml` (Render only looks at the repo root by default). It'll
prompt for the 7 required secrets (Supabase keys, Gemini key, Mistral key, Groq key, allowed
origins) plus 2 optional ones (NVIDIA key, Sentry DSN); everything else already has a working
default. See `backend/render.yaml` for the full picture.

### 3 · Frontend

```bash
cd frontend
python3 -m http.server 5173   # ES modules need a real HTTP server, not file://
# open http://localhost:5173
```

Edit `frontend/js/config.js` with your Supabase URL/anon key and your backend's URL (localhost
for dev, your deployed backend's URL once it's live). Whenever you touch any frontend file, run
`python3 frontend/bump_version.py` before committing — see the comment at the top of that file
for why this matters on a no-build-step static site.

#### Deploy the frontend

Push to `main` and the included GitHub Actions workflow (`.github/workflows/deploy-pages.yml`)
takes care of it automatically. One-time setup: **Settings → Pages → Source → GitHub Actions**.

### 4 · AI provider keys

| Provider | Role | Get a key |
|---|---|---|
| **Google Gemini** | Required — Task A vision primary | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| **Mistral AI** | Recommended — Task B/C primary | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| **Groq** | Recommended — Task B/C fallback | [console.groq.com/keys](https://console.groq.com/keys) |
| **NVIDIA NIM** | Optional — Task A vision fallback | [build.nvidia.com](https://build.nvidia.com) |

The frontend never touches any of these keys — every AI call is proxied through the backend.

---

## 📬 Let's connect

<div align="center">

**Andrei Condrea**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Andrei_Condrea-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/andrei-condrea-b32148346)
[![Email](https://img.shields.io/badge/Email-condrea.andrey777%40gmail.com-EA4335?style=for-the-badge&logo=gmail&logoColor=white)](mailto:condrea.andrey777@gmail.com)

<br />

<i>Built solo, end to end — backend, frontend, and everything in between.</i>

</div>
