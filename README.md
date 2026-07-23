# Iron Log — Calorie & Macro Tracker

A decoupled hypertrophy/macro tracking app: **FastAPI backend** (Render) + **vanilla JS frontend**
(GitHub Pages) + **Supabase** (Postgres + Auth) + **Gemini** (via the `google-genai` SDK) for AI
food scanning.

```
calorie-tracker/
├── sql/schema.sql          ← run once in Supabase SQL editor
├── backend/                ← FastAPI, deploy to Render
│   ├── main.py
│   ├── config.py
│   ├── database.py
│   ├── auth.py
│   ├── models.py
│   ├── services/
│   │   ├── gemini_service.py
│   │   └── cleanup_service.py
│   ├── routers/
│   │   ├── targets.py
│   │   ├── scan.py
│   │   ├── logs.py
│   │   ├── meals.py
│   │   └── water.py
│   ├── requirements.txt
│   ├── render.yaml
│   └── .env.example
└── frontend/                ← static site, deploy to GitHub Pages
    ├── index.html
    ├── css/style.css
    └── js/
        ├── config.js
        ├── supabaseClient.js
        ├── api.js
        ├── auth.js
        ├── ui.js
        ├── scan.js
        └── app.js
```

## 1. Supabase setup

1. Create a project at supabase.com.
2. Open **SQL Editor** → paste and run `sql/schema.sql`. This creates `profiles`,
   `daily_logs`, `saved_meals`, `water_logs`, enables Row Level Security, and
   auto-creates a profile row for every new signed-up user.
3. (Optional but recommended) **Database → Extensions** → enable `pg_cron`, then
   run the `cron.schedule(...)` statement at the bottom of `schema.sql` (commented
   out) to auto-delete logs older than 3 days at the database level. If you skip
   this, the backend's own scheduled job (`cleanup_service.py`) does the same
   thing daily — you only need one.
4. **Authentication → Providers** → confirm Email is enabled. Decide whether you
   want "Confirm email" on or off (the frontend handles both cases).
5. **Project Settings → API** → copy your Project URL, `anon` public key, and
   `service_role` key — you'll need all three below.

## 2. Backend (FastAPI on Render)

```bash
cd backend
cp .env.example .env   # fill in real values
pip install -r requirements.txt --break-system-packages   # or use a venv
uvicorn main:app --reload   # local dev at http://localhost:8000
```

**Deploy to Render:**
1. Push this repo to GitHub.
2. Render Dashboard → New → Blueprint → point at your repo (it will read
   `backend/render.yaml`), or manually create a Web Service with root directory
   `backend`, build command `pip install -r requirements.txt`, start command
   `uvicorn main:app --host 0.0.0.0 --port $PORT`.
3. Set the environment variables from `.env.example` in Render's dashboard
   (never commit your real `.env`).
4. Set `ALLOWED_ORIGINS` to your GitHub Pages URL, e.g.
   `https://your-username.github.io`.

## 3. Frontend (static, GitHub Pages)

1. Edit `frontend/js/config.js`:
   ```js
   export const SUPABASE_URL = "https://your-project-ref.supabase.co";
   export const SUPABASE_ANON_KEY = "your-anon-public-key";
   export const API_BASE_URL = "https://your-render-app.onrender.com";
   ```
2. Local dev (ES modules require a real HTTP server, not `file://`):
   ```bash
   cd frontend
   python3 -m http.server 5173
   # open http://localhost:5173
   ```
3. Deploy: push the `frontend/` folder's contents to a `gh-pages` branch (or
   enable Pages on a `/frontend` subfolder via Settings → Pages → "Deploy from
   branch"). No build step is required — it's plain static HTML/CSS/JS.

## 4. Gemini API key

Get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
and put it in the backend's `GEMINI_API_KEY` env var. Nothing on the frontend
ever touches this key — all AI calls go through your backend.

## Security notes

- The frontend never talks to Gemini directly — only your FastAPI backend does,
  keeping `GEMINI_API_KEY` and `SUPABASE_SERVICE_KEY` server-side only.
- Every backend endpoint requires a valid Supabase session JWT (`Authorization:
  Bearer <token>`), verified against Supabase Auth on every request.
- `/scan` is rate-limited to **10 requests/minute per authenticated user** via
  `slowapi`.
- The Gemini system prompt treats the user's image and free-text "context" as
  untrusted data, not instructions, and is constrained to always return one of
  two fixed JSON shapes — see the comment block in `gemini_service.py` for the
  full prompt-injection defense reasoning.
- Manual corrections to a logged item never re-send the image: a food-name
  edit uses a **text-only** Gemini call to re-derive macros; any other edit
  (weight, calories, protein, carbs, fats) is applied directly as sent, no AI
  call.
