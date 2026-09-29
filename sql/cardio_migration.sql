-- ============================================================================
-- Iron Log — CARDIO MIGRATION (Phases 3 + 5), as one paste-able block.
--
-- WHAT THIS IS. Everything `cardio_sessions` needs, combined: the table, the
-- Phase 5 `basis` column, both indexes, the grant, RLS and its policy. It is
-- the same SQL that already lives in sql/schema.sql — extracted here so you do
-- not have to paste a 1,600-line file to apply one feature, and so a project
-- that already ran the Phase 3 half only gains the new column.
--
-- HOW TO RUN IT. Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Nothing in this repository can execute DDL against Supabase (there is no
-- exec_sql RPC), so until you run this by hand the feature is not live.
--
-- IT IS SAFE TO RE-RUN. Every statement is idempotent: `if not exists` on the
-- table, the column and the indexes, and `drop policy if exists` before the
-- policy, because Postgres has no `create policy if not exists` in any version
-- and re-running without the drop would fail on "policy already exists".
--
-- WHAT HAPPENS IF YOU DON'T RUN IT:
--   * Never ran ANY of it — logging cardio returns a clear 503 explaining why,
--     and everything else, including reading the diary, keeps working. The read
--     path uses db_tolerance.read_tolerant on purpose: the newest optional
--     feature must not take the whole diary down with it.
--   * Ran Phase 3 but not the `basis` column — the insert drops that one field
--     via db_tolerance.write_tolerant_rows and every row reads as net, which is
--     what they all are (js/workouts/cardio.js has always hardcoded it). The
--     feature is correct without the column; the column only makes each row
--     self-describing so a session total can never be a quiet sum of two
--     different bases.
-- ============================================================================

-- Used by the primary key's default below. Already present on any project that
-- has run sql/schema.sql; included so this block stands alone.
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 1. The table
--
-- One duration-based cardio effort, attached to the SAME workout_sessions row a
-- strength session uses — so a session can hold lifting and a finisher on the
-- bike, and the dashboard's Activity chip, trends and analytics all keep
-- reading calories_burned from one place.
--
-- Its own table rather than widening workout_sets, because a cardio effort has
-- no reps, no weight, no set number and no RPE-scaled category MET — it has a
-- machine and that machine's own console readings. Widening workout_sets would
-- make six columns nullable-and-meaningless for every strength set ever logged
-- and put two different calorie engines behind one row shape.
--
-- Kept indefinitely, like workout_sessions: NOT part of the 7-day retention
-- window, and deliberately absent from cleanup_service/cleanup_old_logs().
-- ---------------------------------------------------------------------------
create table if not exists public.cardio_sessions (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  session_id  uuid not null references public.workout_sessions(id) on delete cascade,
  -- 'treadmill' | 'stairmaster' | 'bike' | 'rower' | 'elliptical' | 'outdoor' |
  -- or free text for anything unrecognised, which services/cardio_service.py
  -- prices from the flat MET table instead.
  machine     text not null check (char_length(machine) between 1 and 60),
  -- Per-machine console readings. JSONB because the KEYS DIFFER BY MACHINE
  -- (speed_kmh/incline_percent vs steps_per_min vs watts vs split_seconds) and
  -- are always read and written as one whole blob, never filtered on
  -- individually — the same argument workout_routines.exercises already makes.
  params      jsonb not null default '{}'::jsonb,
  duration_minutes numeric not null check (duration_minutes > 0 and duration_minutes <= 600),
  calories_burned  numeric,
  -- Provenance, so the UI never has to guess which method produced a figure and
  -- a later equation change stays auditable against rows computed by the old
  -- one. 'acsm_walking' | 'acsm_running' | 'acsm_stepping' |
  -- 'acsm_leg_ergometry' | 'concept2_split_to_watts' | 'met_band_elliptical' |
  -- 'flat_met' — see services/cardio_service.py.
  equation_id text,
  -- True when the inputs fell outside the equation's published validity band,
  -- or when no published equation exists for that machine at all.
  is_estimate boolean not null default false,
  -- Phase 5: 'net' | 'gross' — which basis calories_burned is on. NET excludes
  -- the resting metabolism that would have happened anyway; GROSS includes it.
  -- The session's cached calories_burned is net, so a row has to say which one
  -- its own figure is. Nullable and defaulted rather than `not null`: every row
  -- written before this column existed is net, which is exactly how
  -- routers/workouts.py reads a null.
  basis       text default 'net' check (basis is null or basis in ('net','gross')),
  logged_at   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. The Phase 5 column, for a project that already ran the Phase 3 half
--
-- A no-op when the `create table` above just made the column. Not folded into
-- that statement because `create table if not exists` does NOTHING at all on an
-- existing table — including adding a column that appeared in its definition
-- later, which is exactly the case this line covers.
-- ---------------------------------------------------------------------------
alter table public.cardio_sessions
  add column if not exists basis text default 'net'
  check (basis is null or basis in ('net','gross'));

-- ---------------------------------------------------------------------------
-- 3. Indexes
--
-- The first is the one that matters: every read of a session's cardio filters
-- by session_id (routers/workouts.py::_fetch_cardio uses .in_() across a whole
-- month of sessions at once). The second backs any future per-user history
-- query in logged_at order.
-- ---------------------------------------------------------------------------
create index if not exists idx_cardio_sessions_session   on public.cardio_sessions (session_id);
create index if not exists idx_cardio_sessions_user_time on public.cardio_sessions (user_id, logged_at desc);

-- ---------------------------------------------------------------------------
-- 4. Grants — REQUIRED, not optional
--
-- A table added AFTER the initial Supabase project setup does not inherit the
-- role grants the original schema handed out. Without this the service-role
-- client gets a live 500 ("permission denied for table cardio_sessions"), not a
-- silent no-op. weight_logs and push_subscriptions carry the same note, both
-- after hitting exactly this.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.cardio_sessions to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security
--
-- Defence in depth. The backend bypasses RLS (it uses the service-role client)
-- and every query in routers/workouts.py filters by user_id explicitly — that
-- is what actually enforces isolation today. This policy covers the case of a
-- direct frontend->Supabase query, which this app does not currently make.
--
-- The drop is what makes this block re-runnable: Postgres has no
-- `create policy if not exists`, so a second run would fail without it. It is
-- safe because the policy is immediately recreated with identical terms.
-- ---------------------------------------------------------------------------
alter table public.cardio_sessions enable row level security;

drop policy if exists "cardio_sessions_owner" on public.cardio_sessions;
create policy "cardio_sessions_owner" on public.cardio_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 6. Confirm it worked
--
-- Expect one row per column: machine, params, duration_minutes,
-- calories_burned, equation_id, is_estimate, BASIS, logged_at, created_at,
-- plus id/user_id/session_id. If `basis` is missing, step 2 did not run.
-- ---------------------------------------------------------------------------
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'cardio_sessions'
order by ordinal_position;
