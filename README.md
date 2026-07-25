<div align="center">

  <h1>🏋️ Iron Log</h1>

  <p>
    A precision hypertrophy and macro tracker that does the tedious part for you —
    <strong>snap a photo of your plate</strong> and get back calories, protein, carbs, and fats
    in seconds, powered by Google Gemini.<br />
    Built as a fully decoupled app: a <strong>FastAPI</strong> backend, a dependency-free
    <strong>vanilla JS</strong> frontend, and <strong>Supabase</strong> for auth and storage.
  </p>

  <p>
    <img src="https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
    <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" />
    <img src="https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white" alt="Google Gemini" />
    <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
    <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
  </p>

</div>

<br />

---

## What it does

Iron Log is a mobile-first web app for tracking calories and macros without the usual busywork
of searching a food database for every meal. Point your camera at your plate, and Gemini reads
the photo, identifies the food, and estimates weight and macros — with a portion-size self-check
built into the prompt so a small, fast model still lands on realistic numbers. No barcode? No
photo needed either — scan a package instead and it's looked up against Open Food Facts for free.
Log a favorite meal once and it's one tap to repeat forever.

Everything else a tracking app needs is here too: a daily calorie ring and macro bars that react
in real time, a water tracker with its own small animated flourishes, body-weight trends, a 7-day
history with a genuine adherence streak, and a coach banner that talks to you like a person
("still short on protein — good time for a shake") instead of just showing a number.

## ✨ Features

- **📸 AI photo scanning** — point, shoot, get macros back in a couple of seconds, powered by a
  Gemini vision call with a portion-anchored, arithmetic-checked prompt tuned for a small,
  free-tier model.
- **📦 Barcode scanning** — a second, unlimited lookup path via the browser's native
  `BarcodeDetector` API against Open Food Facts, no extra dependency, never touches the AI quota.
- **🧠 Smart, quota-aware model routing** — the backend tracks live per-model rate-limit headroom
  across a tiered list of Gemini models and routes each call to whichever one actually has
  capacity right now, instead of hammering one model and failing over only after it's already
  rate-limited.
- **⭐ Saved meals** — turn any logged item into a one-tap favorite for instant re-logging.
- **💧 Water tracking** — a liquid-fill capsule with its own bump/ripple/rising-bubble animation,
  tuned to stay GPU-cheap.
- **📈 Progress & trends** — a 7-day calorie chart, a full daily history list, body-weight
  trend charting, and a real adherence streak — all computed at read time from the same rows
  already being stored, no separate aggregate table to keep in sync.
- **🗓️ Flexible "day" tracking** — a manual "End day" action for anyone who eats past midnight or
  wants to start fresh early, decoupled from — but never inconsistent with — the actual calendar
  day your totals are computed against.
- **🌍 Bilingual** — English and Romanian, switchable in-app, with strict key-parity between the
  two dictionaries.
- **📴 Installable PWA** — a service worker caches the static shell so the app opens instantly on
  a flaky connection; your food/water data is never cached stale, since it's fetched fresh from
  the API every time.
- **🔒 Security-first by default** — every route requires a verified Supabase session, every
  database query is scoped to its owner, a strict CSP with no inline scripts, SRI-pinned CDN
  dependencies, and a documented prompt-injection defense on the AI path.

## 🛠️ Tech stack

**Backend** — Python, FastAPI, Supabase (Postgres + Row Level Security), Google Gemini
(`google-genai`), slowapi rate limiting, APScheduler.
**Frontend** — vanilla JavaScript (ES modules, no build step, no framework), hand-rolled CSS
design system, inline SVG charts (no charting library), a minimal i18n layer.
**Infra** — Render (backend), GitHub Pages (frontend, deployed via GitHub Actions), Supabase
(database + auth).

## 📁 Project layout

```
calorie-tracker/
├── sql/schema.sql          ← run once in Supabase's SQL editor; source of truth for the schema
├── backend/                 FastAPI, deploys to Render
│   ├── main.py               app factory: CORS, security headers, rate limiting, routers
│   ├── config.py              all settings, read from environment variables
│   ├── database.py            Supabase client factories (service-role + anon)
│   ├── auth.py                verifies the Supabase session JWT on every request
│   ├── models.py               Pydantic request/response schemas
│   ├── render.yaml            Render Blueprint — one-click backend deploy
│   ├── services/
│   │   ├── gemini_service.py    AI vision + text-only prompts, prompt-injection defenses
│   │   ├── quota_service.py     smart multi-model routing + live rate-limit tracking
│   │   ├── food_cache_service.py  caches repeat text-only macro lookups
│   │   ├── trends_service.py    pure daily/streak aggregation (fully unit-tested)
│   │   ├── day_service.py       "Day N" / End-day boundary math
│   │   └── cleanup_service.py   scheduled retention cleanup
│   ├── routers/                one file per resource — targets, scan, barcode, logs, meals,
│   │                            water, weight, trends, day
│   └── tests/                   pytest — the genuinely critical logic, not a full retrofit
└── frontend/                 static site, deploys to GitHub Pages
    ├── index.html
    ├── manifest.json + sw.js    PWA shell caching
    ├── bump_version.py          rewrites every cache-busting ?v= in one shot
    └── js/
        ├── config.js             Supabase URL/key + API base URL (not secret — see below)
        ├── api.js                 fetch wrapper, attaches the session JWT to every call
        ├── auth.js                 login/signup/password-reset flow
        ├── i18n.js                  English/Romanian dictionary
        ├── ui.js / coach.js          rendering + the humanized status-banner copy logic
        ├── scan.js / progress.js      AI + barcode scan flow, trends/weight charts
        ├── reminders.js               opt-in local notification reminders
        └── app.js                     app state, event wiring — the entry point
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
5. **Project Settings → API** → copy your Project URL, `anon` public key, and `service_role`
   key — you'll need all three below.

### 2. Backend

```bash
cd backend
cp .env.example .env          # fill in your Supabase + Gemini values
pip install -r requirements.txt --break-system-packages   # or use a venv
uvicorn main:app --reload     # local dev at http://localhost:8000
```

**Deploy to Render** — the easy way is a Blueprint: **New → Blueprint**, select this repo, and
set **Blueprint Path** to `backend/render.yaml` (Render only looks at the repo root by default).
It'll prompt for the handful of required secrets; everything else already has a working default.
See `backend/render.yaml` for the full picture.

### 3. Frontend

```bash
cd frontend
python3 -m http.server 5173   # ES modules need a real HTTP server, not file://
# open http://localhost:5173
```

Edit `frontend/js/config.js` with your Supabase URL/anon key and your backend's URL (localhost
for dev, your Render URL once deployed). Whenever you touch any frontend file, run
`python3 frontend/bump_version.py` before committing — see the comment at the top of that file
for why.

**Deploy to GitHub Pages** — push to `main` and the included GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`) takes care of it automatically. One-time setup: **Settings
→ Pages → Source → GitHub Actions**.

### 4. Gemini API key

Get one at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) and put it in
the backend's `GEMINI_API_KEY`. The frontend never touches this key — every AI call goes through
the backend.

## 🔒 Security

- Every route requires a verified Supabase session JWT, checked against Supabase itself on every
  request — the backend never issues or trusts its own tokens.
- The service-role database client bypasses Row Level Security by design (it needs to, to serve
  every user), so every single query is explicitly scoped to the authenticated caller — verified,
  not just assumed.
- A strict Content-Security-Policy with no `unsafe-inline`/`unsafe-eval`, and the Supabase CDN
  script is pinned by exact subresource integrity hash.
- `/scan` and other AI-triggering routes are rate-limited per authenticated user, on top of a
  shared daily quota guard so one free-tier Gemini key can't be exhausted by a single user.
- The Gemini prompt treats the photo and any free-text context as untrusted *data*, never
  instructions, with a structural (not just prompt-level) enforcement layer — see the comment
  block at the top of `gemini_service.py` for the full threat model.
- Self-service password reset, with copy that never confirms or denies whether a given email has
  an account (prevents user enumeration).

## 📬 Let's connect

- **Name:** Andrei Condrea
- **LinkedIn:** [Andrei Condrea](https://www.linkedin.com/in/andrei-condrea-b32148346)
- **Email:** condrea.andrey777@gmail.com

<p align="center">
  <i>Built solo, end to end — backend, frontend, and everything in between.</i>
</p>
