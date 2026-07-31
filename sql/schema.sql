-- ============================================================================
-- Calorie & Macro Tracker — Supabase Schema
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- profiles — one row per auth user, holds daily targets
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id                   uuid primary key references auth.users(id) on delete cascade,
  email                text,
  -- Optional, user-set display name (e.g. "Andrew") — used only for the
  -- greeting ("Good morning, Andrew"), nothing else keys off it.
  display_name         text,
  daily_calories       numeric      not null default 2200,
  daily_protein        numeric      not null default 150,
  daily_carbs          numeric      not null default 250,
  daily_fats           numeric      not null default 70,
  daily_fiber          numeric      not null default 30,
  daily_water_ml       integer      not null default 3000,
  -- IANA timezone name (e.g. "Europe/Bucharest"), auto-detected client-side
  -- and pushed via PUT /day/timezone — see backend/services/daytime_service.py.
  -- Everything that means "today"/"midnight" for this user is computed from
  -- this, never UTC. Defaults to UTC until the frontend gets a chance to
  -- detect and send the real one.
  timezone             text         not null default 'UTC',
  -- The local calendar date (in the timezone above) on which the user last
  -- pressed "End day", or null if today hasn't been ended. A day is locked
  -- for further logging iff this equals today's local date — see
  -- backend/routers/day.py. Self-clears the moment local midnight passes:
  -- there's no persisted counter or lazy-advance step needed, unlike the
  -- current_day_number/day_boundary model this replaces.
  day_ended_date       date,
  created_at           timestamptz  not null default now(),
  updated_at           timestamptz  not null default now()
);

-- Existing projects: add the new day-tracking columns, and drop the old
-- session-counter ones they replace (current_day_number/day_boundary — see
-- the daily_logs/water_logs migration below for why "logical session" was
-- replaced with "real calendar date"). No historical timezone exists to
-- backfill from, so this can't misdate anything — UTC is just the starting
-- default until the frontend detects and sends the real one on next load.
alter table public.profiles add column if not exists timezone text not null default 'UTC';
alter table public.profiles add column if not exists day_ended_date date;
alter table public.profiles drop column if exists current_day_number;
alter table public.profiles drop column if exists day_boundary;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists daily_fiber numeric not null default 30;
-- User's stated goal (cut/maintain/bulk) — lets the dashboard's coaching
-- copy (backend/models.py's TargetsUpdate.goal_type, frontend/js/coach.js)
-- react differently to a calorie overage: a surplus is exactly the point on
-- a bulk, so it's reframed as on-plan instead of the default cautionary
-- tone. Defaults to 'maintain', which keeps today's existing tone
-- completely unchanged for anyone who never sets this.
alter table public.profiles add column if not exists goal_type text not null default 'maintain';
alter table public.profiles
  drop constraint if exists profiles_goal_type_check,
  add constraint profiles_goal_type_check check (goal_type in ('cut', 'maintain', 'bulk'));

-- ----------------------------------------------------------------------------
-- daily_logs — individual food entries. Only the last retention_days days are
-- retained (7 by default — see backend/config.py's retention_days, which
-- this must be kept in sync with; this comment previously said "3 days" and
-- had drifted out of sync with the actual configured value).
-- ----------------------------------------------------------------------------
create table if not exists public.daily_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  food_name   text not null,
  weight_g    numeric not null,
  calories    numeric not null,
  protein     numeric not null default 0,
  carbs       numeric not null default 0,
  fats        numeric not null default 0,
  fiber       numeric not null default 0,
  source      text not null default 'ai' check (source in ('ai', 'manual', 'saved_meal')),
  -- The real calendar date this entry belongs to, in the user's own timezone
  -- at the moment it was written (see backend/services/daytime_service.py) —
  -- NOT recomputed later, so a later timezone change never retroactively
  -- re-dates history. This is the entry's actual day identity now: Progress/
  -- trends/Daily History all group by this column directly, one row per
  -- date, guaranteed unique by construction (replaces the old day_number
  -- logical-session counter, which could put two "days" on the same date).
  log_date    date not null default (now() at time zone 'utc')::date,
  logged_at   timestamptz not null default now()
);

-- image_url was never populated (scanned photos are analyzed in-memory and
-- discarded, never persisted — deliberate, to avoid storage cost) — dropped
-- as dead schema. Safe/no-op if the column was never created either.
alter table public.daily_logs drop column if exists image_url;

-- Existing projects: add log_date, backfill it from logged_at's UTC date as a
-- one-time best-effort (no historical per-user timezone exists to do
-- better — any misdated legacy row ages out within retention_days regardless
-- of this), then drop the old day_number session-counter column it replaces.
alter table public.daily_logs add column if not exists log_date date;
update public.daily_logs set log_date = (logged_at at time zone 'utc')::date where log_date is null;
alter table public.daily_logs alter column log_date set not null;
alter table public.daily_logs alter column log_date set default (now() at time zone 'utc')::date;
alter table public.daily_logs add column if not exists fiber numeric not null default 0;
drop index if exists idx_daily_logs_user_day;
alter table public.daily_logs drop column if exists day_number;

-- Per-ingredient breakdown (e.g. "Porridge with banana" -> oats/banana/milk as
-- separate rows), nullable/jsonb rather than a child table: bounded to 15
-- items x ~6 small fields by backend/models.py's IngredientItem, and this
-- table is already retention-capped at 7 days, so worst-case row growth
-- self-purges quickly instead of accumulating. null means "no breakdown on
-- record" (legacy rows, or a rename that collapsed back to one item) — both
-- the API and frontend treat that the same as a single implicit ingredient
-- equal to the row's own aggregate fields. Shape: array of
-- {food_name, weight_g, calories, protein, carbs, fats, fiber}.
alter table public.daily_logs add column if not exists ingredients jsonb;

-- Defense-in-depth, mirroring backend/models.py's IngredientItem list
-- (max_length=15): the service-role backend is the only writer and already
-- enforces this via Pydantic before it ever reaches Postgres, but a SQL-level
-- bound costs nothing on a column this small and guards against a future
-- direct-write path (see CLAUDE.md's note on RLS being defense-in-depth for
-- the same reason) ever silently writing an unbounded array.
alter table public.daily_logs
  drop constraint if exists daily_logs_ingredients_bounded,
  add constraint daily_logs_ingredients_bounded
    check (ingredients is null or (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) <= 15));

create index if not exists idx_daily_logs_user_time on public.daily_logs (user_id, logged_at desc);
-- Serves the retention cleanup's `where logged_at < cutoff` (no user_id
-- predicate) — the composite index above can't be used efficiently for a
-- query that only filters on its second column.
create index if not exists idx_daily_logs_logged_at on public.daily_logs (logged_at);
-- Dropped, not created: no query actually filters daily_logs by log_date
-- (routers/trends.py fetches by logged_at and groups by log_date in Python
-- afterward) — this index only added write overhead with no read ever using
-- it. Kept as an explicit drop (not just a removed create-index line) so
-- anyone who already applied an earlier version of this file gets it
-- cleaned up too, same pattern as idx_daily_logs_user_day above.
drop index if exists idx_daily_logs_user_date;

-- ----------------------------------------------------------------------------
-- saved_meals — user favorites/templates for instant logging (no AI call)
-- ----------------------------------------------------------------------------
create table if not exists public.saved_meals (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  weight_g    numeric not null,
  calories    numeric not null,
  protein     numeric not null default 0,
  carbs       numeric not null default 0,
  fats        numeric not null default 0,
  fiber       numeric not null default 0,
  -- Lets a user separate quick single-ingredient staples (yogurt, a banana)
  -- from full multi-ingredient meals when saving — purely a client-side
  -- filter/grouping label (two tabs in the Saved view), no backend behavior
  -- differs between the two. POST /meals/{id}/log doesn't care either way.
  type        text not null default 'meal' check (type in ('meal', 'product')),
  created_at  timestamptz not null default now()
);

alter table public.saved_meals add column if not exists fiber numeric not null default 0;
alter table public.saved_meals add column if not exists type text not null default 'meal' check (type in ('meal', 'product'));
-- Same per-ingredient breakdown as daily_logs.ingredients above — a saved
-- meal is a template, so its breakdown (if any) is what gets copied into a
-- new daily_logs row on POST /meals/{id}/log.
alter table public.saved_meals add column if not exists ingredients jsonb;
-- How many servings this saved snapshot's weight_g/macros represent — plain
-- single-serving meals/products default to 1 (identical behavior to before
-- this column existed). A recipe built from several combined saved meals
-- (frontend's Recipe Builder) can set this >1, letting the frontend log any
-- fraction of it (see nutritionMath.js's scaleMacrosByWeight) instead of only
-- ever being able to log the whole batch at once. POST /meals/{id}/log
-- itself is unaware of this — logging still writes the stored snapshot
-- as-is; the per-serving math happens client-side before that call.
alter table public.saved_meals add column if not exists servings numeric not null default 1;
alter table public.saved_meals
  drop constraint if exists saved_meals_servings_positive,
  add constraint saved_meals_servings_positive check (servings > 0);

-- Same defense-in-depth bound as daily_logs.ingredients above.
alter table public.saved_meals
  drop constraint if exists saved_meals_ingredients_bounded,
  add constraint saved_meals_ingredients_bounded
    check (ingredients is null or (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) <= 15));

-- Composite, not just (user_id): every query filters by user_id AND orders by
-- created_at desc (see backend/routers/meals.py), so one index should serve
-- both the filter and the sort instead of filtering then sorting separately.
-- (Supersedes the old single-column idx_saved_meals_user, dropped below —
-- it's redundant once the composite index exists, since any query that could
-- use a user_id-only index can use the composite one too.)
drop index if exists idx_saved_meals_user;
create index if not exists idx_saved_meals_user_created on public.saved_meals (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- water_logs — individual +ml entries. Also retained retention_days days
-- (same rolling window as daily_logs above).
-- ----------------------------------------------------------------------------
create table if not exists public.water_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  amount_ml   integer not null,
  -- Same real-calendar-date tagging as daily_logs.log_date above — see that
  -- column's comment.
  log_date    date not null default (now() at time zone 'utc')::date,
  logged_at   timestamptz not null default now()
);

-- Existing projects: same migration shape as daily_logs.log_date above.
alter table public.water_logs add column if not exists log_date date;
update public.water_logs set log_date = (logged_at at time zone 'utc')::date where log_date is null;
alter table public.water_logs alter column log_date set not null;
alter table public.water_logs alter column log_date set default (now() at time zone 'utc')::date;
drop index if exists idx_water_logs_user_day;
alter table public.water_logs drop column if exists day_number;

create index if not exists idx_water_logs_user_time on public.water_logs (user_id, logged_at desc);
create index if not exists idx_water_logs_logged_at on public.water_logs (logged_at); -- same reasoning as daily_logs above
create index if not exists idx_water_logs_user_date on public.water_logs (user_id, log_date);

-- ----------------------------------------------------------------------------
-- weight_logs — body-weight check-ins. Deliberately NOT part of the retention
-- window above: a weight trend is only useful across weeks/months (tracking a
-- cut/bulk/maintain), and a single row (one numeric + one timestamp) is tiny
-- enough that keeping it forever costs essentially nothing even at scale. The
-- cleanup job / cleanup_old_logs() below must never be extended to this table.
-- ----------------------------------------------------------------------------
create table if not exists public.weight_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  weight_kg   numeric not null check (weight_kg > 0 and weight_kg < 500),
  logged_at   timestamptz not null default now()
);

create index if not exists idx_weight_logs_user_time on public.weight_logs (user_id, logged_at desc);

-- Tables created at project setup got these grants automatically as part of
-- Supabase's initial `public` schema configuration — that doesn't apply
-- retroactively to a table created later by hand, so it's granted
-- explicitly here (this is what "permission denied for table weight_logs"
-- from the service-role client means, if you hit it before this line ran).
grant select, insert, update, delete on public.weight_logs to service_role, authenticated;

-- ----------------------------------------------------------------------------
-- body_measurements — free-form body-part measurements (waist, chest, arm,
-- etc. — the user names the measurement themselves, there's no fixed list).
-- Same "kept indefinitely" reasoning as weight_logs above: a body-measurement
-- trend is only useful across weeks/months, and the storage cost is
-- negligible. Unlike weight_logs, logged_at is user-specified (not always
-- "now") — measurements are often logged after the fact, so the frontend's
-- add/edit form lets the user pick the actual day and time.
-- ----------------------------------------------------------------------------
create table if not exists public.body_measurements (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  value       numeric not null check (value > 0),
  unit        text not null default 'cm',
  logged_at   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_body_measurements_user_time on public.body_measurements (user_id, logged_at desc);

grant select, insert, update, delete on public.body_measurements to service_role, authenticated;

-- ----------------------------------------------------------------------------
-- workout_logs — training log: one row per exercise entry (sets/reps/weight).
-- Same "kept indefinitely" reasoning as weight_logs/body_measurements above —
-- a training log is only useful across weeks/months of progressive-overload
-- history, and the storage cost per row is negligible. Like body_measurements
-- (and unlike weight_logs), logged_at is user-specified: workouts are almost
-- always logged after the fact (at the gym, then reviewed later), not always
-- "right now". reps/weight_kg are per-set values assumed uniform across a
-- given entry's sets — a session with genuinely different reps per set (e.g.
-- a drop set) is logged as separate entries, same as how a user would write
-- it down on paper, rather than modeling arbitrary per-set variation.
-- ----------------------------------------------------------------------------
create table if not exists public.workout_logs (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  exercise_name text not null,
  sets          integer not null check (sets > 0 and sets <= 50),
  reps          integer not null check (reps > 0 and reps <= 200),
  weight_kg     numeric not null default 0 check (weight_kg >= 0 and weight_kg < 500),
  logged_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_workout_logs_user_time on public.workout_logs (user_id, logged_at desc);

grant select, insert, update, delete on public.workout_logs to service_role, authenticated;

-- ============================================================================
-- Row Level Security — every table is locked to its owning user
-- ============================================================================
alter table public.profiles   enable row level security;
alter table public.daily_logs enable row level security;
alter table public.saved_meals enable row level security;
alter table public.water_logs enable row level security;
alter table public.weight_logs enable row level security;
alter table public.body_measurements enable row level security;
alter table public.workout_logs enable row level security;

-- create policy has no "if not exists" option in Postgres (unlike the tables/
-- indexes above), so each one is dropped first — this is what makes the whole
-- script safe to paste and re-run anytime, not just on a fresh project.
drop policy if exists "profiles_owner" on public.profiles;
create policy "profiles_owner" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "daily_logs_owner" on public.daily_logs;
create policy "daily_logs_owner" on public.daily_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "saved_meals_owner" on public.saved_meals;
create policy "saved_meals_owner" on public.saved_meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "water_logs_owner" on public.water_logs;
create policy "water_logs_owner" on public.water_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "weight_logs_owner" on public.weight_logs;
create policy "weight_logs_owner" on public.weight_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "body_measurements_owner" on public.body_measurements;
create policy "body_measurements_owner" on public.body_measurements
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "workout_logs_owner" on public.workout_logs;
create policy "workout_logs_owner" on public.workout_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Note: the FastAPI backend uses the Supabase service-role key, which bypasses
-- RLS by design — the backend itself enforces ownership (see backend/auth.py).
-- RLS above is defense-in-depth in case the frontend ever queries Supabase directly.

-- ============================================================================
-- Auto-create a profile row whenever a new auth user signs up
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================================
-- Data retention — keep only the last 7 days of logs (rolling window: a row
-- is purged 7 days after it was written, not on a calendar-week boundary —
-- must match backend/config.py's retention_days). weight_logs is
-- intentionally NOT included here — see its table comment above.
-- ============================================================================
create or replace function public.cleanup_old_logs()
returns void as $$
begin
  delete from public.daily_logs where logged_at < now() - interval '7 days';
  delete from public.water_logs where logged_at < now() - interval '7 days';
end;
$$ language plpgsql security definer;

-- Requires the pg_cron extension: Supabase Dashboard → Database → Extensions → enable "pg_cron"
-- Then run this once (it schedules the cleanup to run daily at 03:00 UTC):
--
-- select cron.schedule(
--   'cleanup-old-logs-daily',
--   '0 3 * * *',
--   $$select public.cleanup_old_logs();$$
-- );
--
-- If you'd rather not enable pg_cron, the FastAPI backend also runs this same
-- cleanup itself on a daily APScheduler job (see backend/services/cleanup_service.py) —
-- you only need one of the two, not both.
