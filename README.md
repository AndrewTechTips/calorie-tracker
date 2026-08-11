<div align="center">

  <h1>🏋️ Iron Log</h1>

  <p>
    <strong>Precision hypertrophy and macro tracking that removes the busywork.</strong><br />
    Snap a photo of your plate and get calories, protein, carbs, fats, fiber, sugar, and sodium
    back in seconds — no food database to search, no barcode required.
  </p>

  <p>
    <img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
    <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" />
    <img src="https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white" alt="Google Gemini" />
    <img src="https://img.shields.io/badge/Groq-F55036?style=for-the-badge&logo=lightning&logoColor=white" alt="Groq" />
    <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
    <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
  </p>

</div>

<br />

---

## Overview

Iron Log is a mobile-first tracking app built around one idea: logging food should take seconds,
not a search-and-scroll session through a nutrition database. Point a camera at a plate and a
vision model identifies the food, estimates portion size against real-world reference scales, and
returns a full macro and micronutrient breakdown — with a built-in arithmetic self-check so a
fast, low-cost model still lands on numbers that add up. No photo? Describe the meal in plain
English (or Romanian) instead, or scan a barcode for an instant, deterministic lookup that never
touches an AI call at all.

Everything beyond logging is designed to feel like a coach in your pocket rather than a
spreadsheet: a calorie ring and macro bars that update live, a water tracker, body-weight and
measurement trends with real forecasting, a training log, an intermittent fasting timer, an
adherence streak with a once-a-week grace token, and an AI coach that talks like a person
("still short on protein — good time for a shake") instead of just showing a number.

The backend is a fully decoupled FastAPI service; the frontend is dependency-free vanilla
JavaScript with no build step, installable as a PWA that keeps working on a flaky connection.

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
- **🛡️ Prompt-injection–hardened by design** — every AI prompt treats the photo, free text, and
  chat history as untrusted *data*, never instructions, enforced by a structural response schema
  on top of the prompt wording, not the wording alone.

### Resilient, Task-Based AI Routing
Every AI feature is grouped into a task, each with its own primary provider and a multi-model
fallback chain — not a single point of failure:

| Task | What it powers | Routing |
|---|---|---|
| **Vision** | Photo scanning | Google Gemini (multiple models, quota-aware) → NVIDIA NIM fallback |
| **Text / JSON** | Text-description logging, meal suggestions, food-rename re-estimation | Groq (5-model quality-tiered chain) → native Gemini last resort |
| **Conversational** | AI Coach chat, weekly recap, "damage control" messages | Groq → native Gemini last resort |

Each provider cycles through several models in priority order before ever failing over to the
next provider — maximizing both answer quality and the free capacity actually available, instead
of stopping at the first rate limit. Every AI call is cached where it makes sense (repeat food-name
corrections, weekly recaps) to cut real-world API spend without any loss of accuracy.

### AI Coach
- **💬 Chat with context** — a capped daily allowance of free-text conversation with a coach that
  sees your real targets, trends, streak, and today's pre/post-workout-tagged meals, with the same
  untrusted-input handling and safety guardrails (no unsafe calorie targets, no disordered-eating
  guidance) as every other AI surface.
- **⚡ Zero-cost instant insights** — a proactive "today's focus" line and six preset Q&A chips
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

### Nutrition Science
- Full macro **and micronutrient** tracking — calories, protein, carbs, fats, fiber, sugar, and
  sodium on every entry, not just the "big three."
- A goal-aware calorie/macro target calculator (Mifflin-St Jeor BMR/TDEE, cut/maintain/bulk
  presets with per-kilogram protein targets).
- Body-weight trend charting with **EMA smoothing** and **linear-regression-based forecasting**
  (30/60/90-day weight projections), plus custom body measurements (waist, arms, anything you
  choose to track) — both kept indefinitely, since a multi-month trend is the whole point.

### Training & Motivation
- **🏋️ Workout logging** — sets, reps, and load per exercise, with a curated 28-entry popular
  exercise library plus a live search against a broader exercise database.
- **⏱️ Intermittent fasting timer** — a 16/18/20-hour fasting window (or your own custom split),
  visualized as two ring faces that flip between "fasting" and "eating" state, fully offline.
- **🔥 Adherence streak with a grace token** — a genuine calorie-adherence streak computed from
  real logged history, with one "freeze" per rolling 7 days that forgives a single off-target day
  without breaking the chain.
- **🎉 Confetti, without the bloat** — a dependency-free canvas particle effect that celebrates
  hitting a protein or fiber target, skipped automatically under `prefers-reduced-motion`.
- **🧑‍🏫 Guided onboarding** — a first-run walkthrough covering every core flow, including one
  genuinely interactive step, replayable anytime from Settings.

### Discover Hub
A single tab for planning, not just logging: a curated recipe catalog (with a "recommended for
you" strip ranked against today's remaining macros), curated workout plans across experience
levels and goals, a live exercise-library search, and a live food-product search against Open
Food Facts — all cached for instant, offline-first repeat loads.

### Data, Privacy & Compliance
- **📄 Bilingual PDF export** — a multi-section report (food logs, water, weight, workouts, and a
  rolled-up daily summary) with its own independent English/Romanian toggle and full support for
  Romanian diacritics.
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

## 🔒 Security

- Every route requires a verified Supabase session JWT, checked against Supabase on every
  request — the backend never issues or trusts its own tokens.
- The service-role database client bypasses Row Level Security by design (it has to, to serve
  every user), so every single query is explicitly scoped to the authenticated caller — verified
  in code, not just assumed.
- A strict Content-Security-Policy with no `unsafe-inline`/`unsafe-eval`, and the Supabase CDN
  script pinned by exact subresource integrity hash.
- Every AI-triggering route is rate-limited per authenticated user, on top of provider-level quota
  tracking, so no single user can exhaust shared capacity for everyone else.
- Every AI prompt treats the photo, free text, and chat history it receives as untrusted *data*,
  never instructions — enforced by a structural response schema, not prompt wording alone — with a
  fixed, silent refusal shape for any off-task or injection attempt.
- Self-service password reset with copy that never confirms or denies whether a given email has an
  account, preventing user enumeration.
- A narrow, deliberately-scoped pytest suite covers the logic that's genuinely worth covering:
  quota reset-at-midnight math, streak/trend aggregation, retention cutoff math, and barcode error
  mapping — not a blanket retrofit for its own sake.

## 🛠️ Tech stack

| Layer | Technology |
|---|---|
| **Backend** | Python, FastAPI, Pydantic, Supabase (Postgres + Row Level Security), slowapi rate limiting, APScheduler |
| **AI** | Google Gemini (`google-genai`), Groq, NVIDIA NIM — all via the OpenAI SDK where applicable, task-based routing with per-model quota tracking |
| **Frontend** | Vanilla JavaScript (ES modules, zero build step, zero framework), hand-rolled CSS design system, inline SVG charts, client-side PDF generation |
| **Infra** | Render (backend), GitHub Pages via GitHub Actions (frontend), Supabase (database + auth) |
| **External data** | Open Food Facts (barcode/product lookup), a public exercise database (training library) |

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
│   │   ├── quota_service.py             generic per-provider/per-model quota tracking
│   │   ├── food_cache_service.py         caches repeat text-only macro lookups
│   │   ├── coach_cache_service.py         caches weekly recaps + short-lived chat stats
│   │   ├── exercise_cache_service.py       bulk-fetch-and-cache for the exercise library
│   │   ├── trends_service.py               pure daily/streak aggregation (fully unit-tested)
│   │   ├── daytime_service.py               timezone-aware "what day is it" boundary math
│   │   └── cleanup_service.py               scheduled data-retention cleanup
│   ├── routers/                     one file per resource — account, targets, scan, barcode,
│   │                                 logs, meals, water, weight, measurements, workouts, trends,
│   │                                 coach, day, foods, discover
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
        ├── progress.js                        trends, weight/measurement charts + forecasting
        ├── fastingTimer.js / streakFreeze.js    fasting timer, streak grace-token logic
        ├── discover.js                           recipes, workout plans, exercise/product search
        ├── avatar.js / confetti.js                 profile photo/initials, celebration effect
        ├── legalContent.js / legalPage.js           bilingual legal center
        ├── tutorial.js                                guided first-run onboarding
        ├── nutritionMath.js                            shared macro/BMR/forecasting math
        ├── reminders.js                                  opt-in local notification reminders
        └── app.js                                         app state, event wiring — entry point
```

## 🚀 Getting started

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste and run `sql/schema.sql`. This creates every table, enables Row Level
   Security, and auto-creates a profile row for each new signed-up user.
3. **Authentication → Providers → Email** → confirm it's enabled, and decide whether you want
   "Confirm email" on (recommended).
4. **Authentication → URL Configuration** → add your deployed frontend URL to both **Site URL**
   and **Redirect URLs** (needed for the password-reset email flow to work).
5. **Project Settings → API** → copy your Project URL, `anon` public key, and `service_role` key
   — you'll need all three below.

### 2. Backend

```bash
cd backend
cp .env.example .env          # fill in your Supabase, Gemini, and Groq values (see below)
pip install -r requirements.txt --break-system-packages   # or use a venv
uvicorn main:app --reload     # local dev at http://localhost:8000
```

At minimum you'll need `GEMINI_API_KEY` (photo scanning) and `GROQ_API_KEY` (text estimation,
meal suggestions, and the AI coach) — both have free tiers with no credit card required. Every
other AI provider is an optional extra fallback layer; see `backend/.env.example` for the full,
heavily-commented list of every setting and where to get each key.

Run the test suite with:

```bash
pip install -r requirements.txt -r requirements-dev.txt --break-system-packages
pytest
```

**Deploy to Render** — the easy way is a Blueprint: **New → Blueprint**, select this repo, and
set **Blueprint Path** to `backend/render.yaml` (Render only looks at the repo root by default).
It'll prompt for the required secrets; everything else already has a working default. See
`backend/render.yaml` for the full picture.

### 3. Frontend

```bash
cd frontend
python3 -m http.server 5173   # ES modules need a real HTTP server, not file://
# open http://localhost:5173
```

Edit `frontend/js/config.js` with your Supabase URL/anon key and your backend's URL (localhost
for dev, your deployed backend's URL once it's live). Whenever you touch any frontend file, run
`python3 frontend/bump_version.py` before committing — see the comment at the top of that file
for why this matters on a no-build-step static site.

**Deploy to GitHub Pages** — push to `main` and the included GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`) takes care of it automatically. One-time setup:
**Settings → Pages → Source → GitHub Actions**.

### 4. AI provider keys

- **Gemini** (required, vision) — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- **Groq** (required, text/chat) — [console.groq.com/keys](https://console.groq.com/keys)
- **NVIDIA NIM** (optional vision fallback) — [build.nvidia.com](https://build.nvidia.com)

The frontend never touches any of these keys — every AI call is proxied through the backend.

## 📬 Let's connect

- **Name:** Andrei Condrea
- **LinkedIn:** [Andrei Condrea](https://www.linkedin.com/in/andrei-condrea-b32148346)
- **Email:** condrea.andrey777@gmail.com

<p align="center">
  <i>Built solo, end to end — backend, frontend, and everything in between.</i>
</p>
