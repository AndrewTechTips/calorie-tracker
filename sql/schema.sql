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
  daily_water_ml       integer      not null default 3000,
  -- "Day N" counter + the cutoff that currently defines "today" for this
  -- user — see backend/services/day_service.py. day_boundary starts equal
  -- to created_at's midnight; it only ever moves forward, either because a
  -- real midnight passed (read-time lazy update) or the user pressed
  -- "End day" (moves it to that exact moment instead of waiting for
  -- midnight). Trends/streak are unaffected by this — they key off each
  -- log's own calendar date, not this cutoff.
  current_day_number  integer      not null default 1,
  day_boundary         timestamptz  not null default now(),
  created_at           timestamptz  not null default now(),
  updated_at           timestamptz  not null default now()
);

-- Existing projects (created before current_day_number/day_boundary
-- existed) won't get new columns from `create table if not exists` above —
-- these two statements are what actually add them there.
alter table public.profiles add column if not exists current_day_number integer not null default 1;
alter table public.profiles add column if not exists day_boundary timestamptz not null default now();
alter table public.profiles add column if not exists display_name text;

-- ----------------------------------------------------------------------------
-- daily_logs — individual food entries. Only the last 3 days are retained.
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
  source      text not null default 'ai' check (source in ('ai', 'manual', 'saved_meal')),
  logged_at   timestamptz not null default now()
);

-- image_url was never populated (scanned photos are analyzed in-memory and
-- discarded, never persisted — deliberate, to avoid storage cost) — dropped
-- as dead schema. Safe/no-op if the column was never created either.
alter table public.daily_logs drop column if exists image_url;

create index if not exists idx_daily_logs_user_time on public.daily_logs (user_id, logged_at desc);
-- Serves the retention cleanup's `where logged_at < cutoff` (no user_id
-- predicate) — the composite index above can't be used efficiently for a
-- query that only filters on its second column.
create index if not exists idx_daily_logs_logged_at on public.daily_logs (logged_at);

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
  created_at  timestamptz not null default now()
);

-- Composite, not just (user_id): every query filters by user_id AND orders by
-- created_at desc (see backend/routers/meals.py), so one index should serve
-- both the filter and the sort instead of filtering then sorting separately.
-- (Supersedes the old single-column idx_saved_meals_user, dropped below —
-- it's redundant once the composite index exists, since any query that could
-- use a user_id-only index can use the composite one too.)
drop index if exists idx_saved_meals_user;
create index if not exists idx_saved_meals_user_created on public.saved_meals (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- water_logs — individual +ml entries. Also retained 3 days.
-- ----------------------------------------------------------------------------
create table if not exists public.water_logs (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  amount_ml   integer not null,
  logged_at   timestamptz not null default now()
);

create index if not exists idx_water_logs_user_time on public.water_logs (user_id, logged_at desc);
create index if not exists idx_water_logs_logged_at on public.water_logs (logged_at); -- same reasoning as daily_logs above

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

-- ============================================================================
-- Row Level Security — every table is locked to its owning user
-- ============================================================================
alter table public.profiles   enable row level security;
alter table public.daily_logs enable row level security;
alter table public.saved_meals enable row level security;
alter table public.water_logs enable row level security;
alter table public.weight_logs enable row level security;

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
