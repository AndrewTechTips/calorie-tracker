-- ============================================================================
-- Calorie & Macro Tracker — Supabase Schema
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- profiles — one row per auth user, holds daily targets
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text,
  daily_calories    numeric      not null default 2200,
  daily_protein     numeric      not null default 150,
  daily_carbs       numeric      not null default 250,
  daily_fats        numeric      not null default 70,
  daily_water_ml    integer      not null default 3000,
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now()
);

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
  image_url   text,
  logged_at   timestamptz not null default now()
);

create index if not exists idx_daily_logs_user_time on public.daily_logs (user_id, logged_at desc);

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

create index if not exists idx_saved_meals_user on public.saved_meals (user_id);

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

-- ============================================================================
-- Row Level Security — every table is locked to its owning user
-- ============================================================================
alter table public.profiles   enable row level security;
alter table public.daily_logs enable row level security;
alter table public.saved_meals enable row level security;
alter table public.water_logs enable row level security;

create policy "profiles_owner" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "daily_logs_owner" on public.daily_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "saved_meals_owner" on public.saved_meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "water_logs_owner" on public.water_logs
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
-- Data retention — keep only the last 3 days of logs
-- ============================================================================
create or replace function public.cleanup_old_logs()
returns void as $$
begin
  delete from public.daily_logs where logged_at < now() - interval '3 days';
  delete from public.water_logs where logged_at < now() - interval '3 days';
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
