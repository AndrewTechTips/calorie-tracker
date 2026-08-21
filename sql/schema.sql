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
  -- Optional profile picture. Stored as a data: URI (the image bytes
  -- themselves, base64-encoded), not a Storage bucket path — this app has no
  -- Supabase Storage bucket provisioned anywhere else, and a single small
  -- (compressed to ~200x200, see frontend/js/avatar.js) square JPEG easily
  -- fits in a text column. Null means "no custom photo" — the frontend then
  -- renders a deterministic locally-generated initials avatar instead of
  -- calling out to a third-party avatar service (same no-new-external-
  -- dependency posture as everything else in this app — see CLAUDE.md).
  avatar_url            text,
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
alter table public.profiles add column if not exists avatar_url text;
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

-- Optional biometrics for the Predictive Analytics engine
-- (backend/services/analytics_service.py) — Mifflin-St Jeor BMR needs
-- age/height/sex to be more accurate than the weight-only fallback that
-- service uses when any of these three is null. All nullable/defaulted, same
-- "existing users see no behavior change until they opt in" spirit as every
-- other optional column above. Deliberately NOT collected via a dedicated
-- onboarding form: the frontend already asks for exactly these four values
-- in the "Calculate my targets" calculator (index.html's #calculator-sheet,
-- nutritionMath.js's calculateBMR/calculateTargets) — app.js's calculator
-- submit handler now also persists them here alongside applying the
-- suggested targets, so this table fills in for free the first time a user
-- ever uses that tool, no new UI required.
alter table public.profiles add column if not exists age integer;
alter table public.profiles
  drop constraint if exists profiles_age_check,
  add constraint profiles_age_check check (age is null or (age > 0 and age < 120));
alter table public.profiles add column if not exists height_cm numeric;
alter table public.profiles
  drop constraint if exists profiles_height_cm_check,
  add constraint profiles_height_cm_check check (height_cm is null or (height_cm > 0 and height_cm < 300));
-- 'male'/'female' only, matching calculateBMR's own two-branch formula (see
-- nutritionMath.js's comment: "there's no sex-neutral version of this
-- particular formula") — null means "not provided", handled by
-- analytics_service.py's weight-only BMR fallback, not a third enum value.
alter table public.profiles add column if not exists biological_sex text;
alter table public.profiles
  drop constraint if exists profiles_biological_sex_check,
  add constraint profiles_biological_sex_check check (biological_sex is null or biological_sex in ('male', 'female'));
-- Same 5 tiers and default as nutritionMath.js's ACTIVITY_MULTIPLIERS /
-- index.html's #calc-activity options — not nullable (unlike the three
-- above): every profile already effectively has an activity assumption
-- today (the calculator defaults its own <select> to 'moderate'), so
-- defaulting the column the same way costs nothing and lets
-- analytics_service.py always compute a TDEE multiplier without a null check.
alter table public.profiles add column if not exists activity_level text not null default 'moderate';
alter table public.profiles
  drop constraint if exists profiles_activity_level_check,
  add constraint profiles_activity_level_check
    check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active'));
-- Adaptive Goals Engine's "Macro Lock" (backend/services/analytics_service.py's
-- rebalance_macros) — which single macro, if any, stays fixed at its current
-- gram value when a suggested calorie adjustment is applied, letting the
-- other two absorb the change. Null (the default) means "no lock": a
-- suggestion recomputes all three from scratch via the same formula
-- calculateTargets already uses (protein per kg by goal, fat as a fraction of
-- calories, carbs fill the remainder).
alter table public.profiles add column if not exists locked_macro text;
alter table public.profiles
  drop constraint if exists profiles_locked_macro_check,
  add constraint profiles_locked_macro_check check (locked_macro is null or locked_macro in ('protein', 'carbs', 'fats'));

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
  sugar       numeric not null default 0,
  sodium      numeric not null default 0,
  -- Optional meal-timing context relative to a workout, set by the user in
  -- the logging flow (not AI-inferred) — lets the AI Coach chat give
  -- timing-aware nudges (e.g. flagging a fatty pre-workout meal, or a
  -- post-workout meal light on fast carbs) without guessing intent from the
  -- food itself. 'regular' (the default) means "not tied to a workout" and
  -- is the only value every pre-existing row implicitly has.
  workout_tag text not null default 'regular' check (workout_tag in ('pre_workout', 'post_workout', 'regular')),
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
-- Sugar/sodium (Phase: expanded micronutrient tracking) and the pre/post-
-- workout meal-timing tag — see this table's own column comments above for
-- what each means. Same "safe to paste and re-run anytime" migration shape
-- as every other column added here.
alter table public.daily_logs add column if not exists sugar numeric not null default 0;
alter table public.daily_logs add column if not exists sodium numeric not null default 0;
alter table public.daily_logs add column if not exists workout_tag text not null default 'regular';
alter table public.daily_logs
  drop constraint if exists daily_logs_workout_tag_check,
  add constraint daily_logs_workout_tag_check check (workout_tag in ('pre_workout', 'post_workout', 'regular'));
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

-- Defense-in-depth numeric bounds, mirroring backend/models.py's
-- DailyLogCreate/DailyLogCorrection Field(...) limits exactly (same
-- generous-upper-bound-only-to-stop-absurd-values spirit as those comments
-- explain) — the service-role backend already enforces these via Pydantic
-- before a request ever reaches Postgres, but a column this cheap to bound
-- costs nothing and guards against a future direct-write path (an admin
-- script, a Supabase dashboard edit, a bug in write_tolerant's column-drop
-- retry) ever silently writing a negative or absurd value that then
-- corrupts every trends/analytics aggregation reading this table.
alter table public.daily_logs
  drop constraint if exists daily_logs_weight_g_bounded,
  add constraint daily_logs_weight_g_bounded check (weight_g > 0 and weight_g <= 10000);
alter table public.daily_logs
  drop constraint if exists daily_logs_calories_bounded,
  add constraint daily_logs_calories_bounded check (calories >= 0 and calories <= 20000);
alter table public.daily_logs
  drop constraint if exists daily_logs_protein_bounded,
  add constraint daily_logs_protein_bounded check (protein >= 0 and protein <= 2000);
alter table public.daily_logs
  drop constraint if exists daily_logs_carbs_bounded,
  add constraint daily_logs_carbs_bounded check (carbs >= 0 and carbs <= 2000);
alter table public.daily_logs
  drop constraint if exists daily_logs_fats_bounded,
  add constraint daily_logs_fats_bounded check (fats >= 0 and fats <= 2000);
alter table public.daily_logs
  drop constraint if exists daily_logs_fiber_bounded,
  add constraint daily_logs_fiber_bounded check (fiber >= 0 and fiber <= 500);
alter table public.daily_logs
  drop constraint if exists daily_logs_sugar_bounded,
  add constraint daily_logs_sugar_bounded check (sugar >= 0 and sugar <= 2000);
alter table public.daily_logs
  drop constraint if exists daily_logs_sodium_bounded,
  add constraint daily_logs_sodium_bounded check (sodium >= 0 and sodium <= 20000);

create index if not exists idx_daily_logs_user_time on public.daily_logs (user_id, logged_at desc);
-- Serves the retention cleanup's `where logged_at < cutoff` (no user_id
-- predicate) — the composite index above can't be used efficiently for a
-- query that only filters on its second column.
create index if not exists idx_daily_logs_logged_at on public.daily_logs (logged_at);
-- Re-added (this file previously dropped it, on the claim that nothing
-- filtered by log_date — that's no longer true): routers/coach.py's
-- _remaining_macros() (shared by POST /coach/damage-control and POST
-- /coach/suggest-meals) filters daily_logs by exactly (user_id, log_date)
-- to total up "today so far", so this composite index serves that query
-- directly instead of falling back to a per-user scan over
-- idx_daily_logs_user_time.
create index if not exists idx_daily_logs_user_date on public.daily_logs (user_id, log_date);

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
  sugar       numeric not null default 0,
  sodium      numeric not null default 0,
  -- Lets a user separate quick single-ingredient staples (yogurt, a banana)
  -- from full multi-ingredient meals when saving — purely a client-side
  -- filter/grouping label (two tabs in the Saved view), no backend behavior
  -- differs between the two. POST /meals/{id}/log doesn't care either way.
  type        text not null default 'meal' check (type in ('meal', 'product')),
  created_at  timestamptz not null default now()
);

alter table public.saved_meals add column if not exists fiber numeric not null default 0;
-- Same sugar/sodium addition as daily_logs above — a saved meal is a
-- template, so its snapshot should carry the same nutrient fields a fresh
-- log of it would.
alter table public.saved_meals add column if not exists sugar numeric not null default 0;
alter table public.saved_meals add column if not exists sodium numeric not null default 0;
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
  add constraint saved_meals_servings_positive check (servings > 0 and servings <= 100);

-- Same defense-in-depth bound as daily_logs.ingredients above.
alter table public.saved_meals
  drop constraint if exists saved_meals_ingredients_bounded,
  add constraint saved_meals_ingredients_bounded
    check (ingredients is null or (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) <= 15));

-- Same defense-in-depth numeric bounds as daily_logs above, mirroring
-- backend/models.py's SavedMealCreate Field(...) limits exactly — a saved
-- meal is a template that gets copied verbatim into daily_logs on
-- POST /meals/{id}/log, so an unbounded value here would corrupt every
-- future log made from it, not just this row.
alter table public.saved_meals
  drop constraint if exists saved_meals_weight_g_bounded,
  add constraint saved_meals_weight_g_bounded check (weight_g > 0 and weight_g <= 10000);
alter table public.saved_meals
  drop constraint if exists saved_meals_calories_bounded,
  add constraint saved_meals_calories_bounded check (calories >= 0 and calories <= 20000);
alter table public.saved_meals
  drop constraint if exists saved_meals_protein_bounded,
  add constraint saved_meals_protein_bounded check (protein >= 0 and protein <= 2000);
alter table public.saved_meals
  drop constraint if exists saved_meals_carbs_bounded,
  add constraint saved_meals_carbs_bounded check (carbs >= 0 and carbs <= 2000);
alter table public.saved_meals
  drop constraint if exists saved_meals_fats_bounded,
  add constraint saved_meals_fats_bounded check (fats >= 0 and fats <= 2000);
alter table public.saved_meals
  drop constraint if exists saved_meals_fiber_bounded,
  add constraint saved_meals_fiber_bounded check (fiber >= 0 and fiber <= 500);
alter table public.saved_meals
  drop constraint if exists saved_meals_sugar_bounded,
  add constraint saved_meals_sugar_bounded check (sugar >= 0 and sugar <= 2000);
alter table public.saved_meals
  drop constraint if exists saved_meals_sodium_bounded,
  add constraint saved_meals_sodium_bounded check (sodium >= 0 and sodium <= 20000);

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

-- Defense-in-depth bound, mirroring backend/models.py's WaterLogCreate.amount_ml
-- (Field(gt=0, le=5000)) exactly — see daily_logs' equivalent bounds above
-- for the full reasoning. Also keeps a single row incapable of blowing past
-- routers/water.py's own MAX_DAILY_WATER_ML=10000 daily-total guard by
-- itself (5000 is still comfortably under that per-entry).
alter table public.water_logs
  drop constraint if exists water_logs_amount_ml_bounded,
  add constraint water_logs_amount_ml_bounded check (amount_ml > 0 and amount_ml <= 5000);

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

-- Tightened to match backend/models.py's MeasurementCreate.value
-- (Field(gt=0, lt=1000)) exactly — the inline check above (value > 0) only
-- ever guarded the lower bound; this closes the same upper-bound gap
-- daily_logs/saved_meals/water_logs' bounds above close for their own
-- numeric fields.
alter table public.body_measurements
  drop constraint if exists body_measurements_value_bounded,
  add constraint body_measurements_value_bounded check (value > 0 and value < 1000);

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

-- ----------------------------------------------------------------------------
-- workout_sessions / workout_sets — the Workout Diary: one row per gym
-- session, with per-set granularity (reps/weight/RPE) underneath it. This
-- supersedes workout_logs above (kept in place, unused going forward, so no
-- existing data is lost — see the guarded migration below; safe to drop
-- workout_logs manually later once you've verified the migration in
-- production). Kept indefinitely like workout_logs was, same reasoning: a
-- training log is only useful across weeks/months of history and the
-- storage cost is negligible.
--
-- calories_burned is a cached, server-computed estimate (see
-- backend/services/workout_service.py — a MET-based formula using the
-- user's latest weight_logs entry and an RPE-scaled effort factor),
-- recomputed on every set mutation rather than derived on read, so
-- trends_service and the dashboard's Activity Burn stat can read it
-- directly without recomputing.
-- ----------------------------------------------------------------------------
create table if not exists public.workout_sessions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  session_date    date not null default (now()::date),
  name            text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  notes           text,
  calories_burned numeric,
  -- Non-null only for rows created by the one-time workout_logs migration
  -- below — an idempotency marker (not a real foreign key: the source row
  -- lives in a table this feature no longer writes to) so re-running this
  -- script never re-migrates the same old entry twice.
  migrated_from_log_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_workout_sessions_user_date on public.workout_sessions (user_id, session_date desc);

grant select, insert, update, delete on public.workout_sessions to service_role, authenticated;

create table if not exists public.workout_sets (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  session_id    uuid not null references public.workout_sessions(id) on delete cascade,
  exercise_name text not null,
  -- Muscle-group/category snapshot from the exercise library
  -- (backend/data/discover_data.py / wger.de) at the moment this set was
  -- logged, used to look up a MET value — kept as its own copy per set
  -- rather than joined live, since the exercise library isn't a real table
  -- (curated data + a live external proxy) and a snapshot survives that
  -- data changing shape later.
  category      text,
  set_number    integer not null check (set_number > 0 and set_number <= 50),
  reps          integer not null check (reps > 0 and reps <= 200),
  weight_kg     numeric not null default 0 check (weight_kg >= 0 and weight_kg < 500),
  -- Rate of Perceived Exertion, 1-10, half-point increments allowed (e.g.
  -- 7.5) — null means the user skipped it for this set.
  rpe           numeric check (rpe is null or (rpe >= 1 and rpe <= 10)),
  logged_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists idx_workout_sets_session on public.workout_sets (session_id);
create index if not exists idx_workout_sets_user_time on public.workout_sets (user_id, logged_at desc);

grant select, insert, update, delete on public.workout_sets to service_role, authenticated;

-- One-time migration of pre-existing workout_logs rows into the new
-- session/set shape, guarded by migrated_from_log_id so it's safe to leave
-- in this script permanently (like every other `if not exists` migration
-- here) — re-running it after the first successful pass is a no-op. Each
-- old row (a single exercise entry with a uniform sets/reps/weight_kg)
-- becomes one session plus N generated per-set rows; RPE is left null
-- since the old schema never captured it.
do $$
declare
  log record;
  new_session_id uuid;
begin
  for log in
    select wl.* from public.workout_logs wl
    where not exists (
      select 1 from public.workout_sessions ws where ws.migrated_from_log_id = wl.id
    )
  loop
    insert into public.workout_sessions
      (user_id, session_date, started_at, migrated_from_log_id, created_at)
    values
      (log.user_id, log.logged_at::date, log.logged_at, log.id, log.created_at)
    returning id into new_session_id;

    insert into public.workout_sets
      (user_id, session_id, exercise_name, set_number, reps, weight_kg, logged_at, created_at)
    select
      log.user_id, new_session_id, log.exercise_name, gs, log.reps, log.weight_kg, log.logged_at, log.created_at
    from generate_series(1, log.sets) as gs;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- ai_feature_usage — per-user, per-feature, per-UTC-day AI call counters.
-- This is the enforcement backbone for backend/services/ai_usage_service.py
-- (every AI-calling route's server-side quota guard) and the Settings → AI
-- Limits section in the frontend. Deliberately a real table, not in-memory
-- like services/quota_service.py / the old coach-chat-only counter it
-- replaces: those track shared PROVIDER-side capacity (same number for
-- every user, fine to lose on a restart), this tracks a PER-USER
-- entitlement that must survive a Render restart/redeploy without silently
-- resetting everyone's daily allowance back to full.
--
-- `feature` is a small fixed set of string keys owned by ai_usage_service.py
-- (e.g. "scan", "scan_describe", "log_correction", "coach_chat",
-- "weekly_recap", "damage_control", "suggest_meals") — not a foreign key to
-- anything, since the set is tiny and defined in code, not user data.
-- (user_id, feature, usage_date) is the primary key so a single atomic
-- upsert (see increment_ai_feature_usage below) is all a call needs.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_feature_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  feature     text not null,
  usage_date  date not null,
  call_count  integer not null default 0 check (call_count >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, feature, usage_date)
);

create index if not exists idx_ai_feature_usage_user_date on public.ai_feature_usage (user_id, usage_date);

grant select, insert, update, delete on public.ai_feature_usage to service_role, authenticated;

-- Atomic increment-or-insert for one (user, feature, today) row — the plain
-- Supabase REST client can't do a race-free "read count, +1, write" itself,
-- so this is a real RPC. Superseded as the enforcement path by
-- try_consume_ai_feature_usage() below (which closes the check-then-act race
-- a bare increment still leaves for the caller to introduce) but kept as a
-- standalone primitive.
-- SECURITY DEFINER because the backend always calls this off its
-- service-role client anyway; kept explicit here so the function's own
-- permissions aren't accidentally dependent on which role calls it.
--
-- IMPORTANT: PostgreSQL grants EXECUTE on every newly created function to
-- PUBLIC by default (unlike tables) — that default silently survives a
-- later `create or replace function` too, since replacing a function does
-- not touch its existing grants. A bare `grant ... to service_role,
-- authenticated` line therefore does NOT stop other roles (anon, or PUBLIC
-- generally) from also calling it; only an explicit `revoke ... from
-- public` actually removes the default. This matters a lot here
-- specifically: this function is SECURITY DEFINER (bypasses RLS) and takes
-- an arbitrary p_user_id with no check that it matches the caller's own
-- auth.uid() — it trusts the backend to only ever pass the authenticated
-- user's own id (see ai_usage_service.py). Previously granted to
-- `authenticated` too, which let ANY logged-in user call this directly via
-- the public anon key + their own session and pass a DIFFERENT user's id,
-- inflating a stranger's quota counters to lock them out of AI features —
-- entirely bypassing the FastAPI backend. Restricted to service_role only:
-- this RPC is never meant to be reachable from the frontend.
--
-- NOTE on statement order: the `revoke` below must come AFTER `create or
-- replace function`, not before — on a brand-new database (this script's
-- very first run) the function doesn't exist yet at the top of the file, and
-- `revoke ... on function <not-yet-existing>` errors out, breaking this
-- script's "safe to paste and re-run anytime, even on a fresh project"
-- property (see this file's own comment on `create policy` above for the
-- same idempotency goal).
create or replace function public.increment_ai_feature_usage(p_user_id uuid, p_feature text)
returns integer as $$
declare
  new_count integer;
begin
  insert into public.ai_feature_usage (user_id, feature, usage_date, call_count, updated_at)
  values (p_user_id, p_feature, (now() at time zone 'utc')::date, 1, now())
  on conflict (user_id, feature, usage_date)
  do update set call_count = public.ai_feature_usage.call_count + 1, updated_at = now()
  returning call_count into new_count;
  return new_count;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function public.increment_ai_feature_usage(uuid, text) from public;
grant execute on function public.increment_ai_feature_usage(uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- ai_feature_usage_monthly — same shape and purpose as ai_feature_usage
-- above, one calendar-month bucket instead of one UTC day. Only a handful of
-- features actually need this (currently just "weekly_recap" —
-- backend/services/ai_usage_service.py's _FEATURE_MONTHLY_LIMIT_SETTINGS):
-- a feature whose real, product-level cadence is "roughly weekly" (already
-- cached 7 days server-side, see coach_cache_service.py) makes little sense
-- gated by a DAILY count alone — "N times a day" was never a real usage
-- pattern for it, only a monthly ceiling actually matches how often it's
-- meant to be regenerated. Kept as a genuinely separate table rather than
-- computed by summing ai_feature_usage's daily rows over a month: that
-- table's own cleanup job only keeps ~2 days of history (it only ever needs
-- "today"), so a month-long SUM would silently undercount once those rows
-- age out. `usage_month` is always the first-of-month date (never the exact
-- day), so (user_id, feature, usage_month) stays a stable primary key
-- regardless of which day within the month a call lands on.
-- ----------------------------------------------------------------------------
create table if not exists public.ai_feature_usage_monthly (
  user_id      uuid not null references auth.users(id) on delete cascade,
  feature      text not null,
  usage_month  date not null,
  call_count   integer not null default 0 check (call_count >= 0),
  updated_at   timestamptz not null default now(),
  primary key (user_id, feature, usage_month)
);

create index if not exists idx_ai_feature_usage_monthly_user_month on public.ai_feature_usage_monthly (user_id, usage_month);

grant select, insert, update, delete on public.ai_feature_usage_monthly to service_role, authenticated;

-- Same atomic upsert-increment shape as increment_ai_feature_usage above,
-- just bucketed to the first of the current UTC month instead of today.
-- Same "service_role only, explicit revoke from public" reasoning too —
-- see increment_ai_feature_usage's comment above (including the note on why
-- the revoke must come AFTER create, not before).
create or replace function public.increment_ai_feature_usage_monthly(p_user_id uuid, p_feature text)
returns integer as $$
declare
  new_count integer;
begin
  insert into public.ai_feature_usage_monthly (user_id, feature, usage_month, call_count, updated_at)
  values (p_user_id, p_feature, date_trunc('month', now() at time zone 'utc')::date, 1, now())
  on conflict (user_id, feature, usage_month)
  do update set call_count = public.ai_feature_usage_monthly.call_count + 1, updated_at = now()
  returning call_count into new_count;
  return new_count;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function public.increment_ai_feature_usage_monthly(uuid, text) from public;
grant execute on function public.increment_ai_feature_usage_monthly(uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- try_consume_ai_feature_usage — the real enforcement primitive every AI
-- route should call instead of the old has_capacity()-then-record_usage()
-- two-step. That two-step is a classic check-then-act race: two concurrent
-- requests from the same user can both run the has_capacity() SELECT and
-- both see "1 remaining" before either has recorded its own call, so both
-- proceed — a user with exactly 1 call left could fire N concurrent
-- requests and get up to N of them through. A bare increment RPC's own
-- upsert is individually atomic (no lost updates to the counter itself),
-- but nothing serialized the CHECK against the INCREMENT as one unit, which
-- is what actually enforces the cap.
--
-- This function closes that gap by doing the check and the increment (both
-- the daily counter, and — when p_monthly_limit is not null — the monthly
-- one too) as a single statement sequence inside one round trip. The
-- `insert ... on conflict (...) do update ... returning` pattern takes a
-- real row-level lock on the target (user, feature, day) row for the
-- duration of this function call, so a second concurrent caller for the
-- SAME row blocks until the first one commits or rolls back and only then
-- sees the post-increment count — there is no window where two callers can
-- both observe "room available" before either has actually spent it.
--
-- If either axis is over its limit, the RAISE below is caught by the
-- EXCEPTION block, which — because it's the same PL/pgSQL block that made
-- the writes — rolls back every insert/update this call made (daily AND
-- monthly, if both were attempted) via an implicit savepoint, releasing the
-- row lock(s) along with it. A rejected call therefore never costs the user
-- any quota, and the two axes move together or not at all (never a daily
-- increment with no matching monthly one, or vice versa).
create or replace function public.try_consume_ai_feature_usage(
  p_user_id uuid,
  p_feature text,
  p_daily_limit integer,
  p_monthly_limit integer default null
)
returns table(allowed boolean, daily_count integer, monthly_count integer) as $$
declare
  v_daily_count integer;
  v_monthly_count integer := null;
begin
  insert into public.ai_feature_usage (user_id, feature, usage_date, call_count, updated_at)
  values (p_user_id, p_feature, (now() at time zone 'utc')::date, 1, now())
  on conflict (user_id, feature, usage_date)
  do update set call_count = public.ai_feature_usage.call_count + 1, updated_at = now()
  returning call_count into v_daily_count;

  if v_daily_count > p_daily_limit then
    raise exception 'ai_feature_usage_over_limit';
  end if;

  if p_monthly_limit is not null then
    insert into public.ai_feature_usage_monthly (user_id, feature, usage_month, call_count, updated_at)
    values (p_user_id, p_feature, date_trunc('month', now() at time zone 'utc')::date, 1, now())
    on conflict (user_id, feature, usage_month)
    do update set call_count = public.ai_feature_usage_monthly.call_count + 1, updated_at = now()
    returning call_count into v_monthly_count;

    if v_monthly_count > p_monthly_limit then
      raise exception 'ai_feature_usage_over_limit';
    end if;
  end if;

  return query select true, v_daily_count, v_monthly_count;
exception
  when raise_exception then
    -- Every write this call made above is rolled back automatically here
    -- (this EXCEPTION block is what makes the enclosing statements act as
    -- one all-or-nothing unit) — the caller spent nothing on a rejected
    -- attempt.
    return query select false, null::integer, null::integer;
end;
$$ language plpgsql security definer set search_path = public;

-- Same reasoning as increment_ai_feature_usage above: service_role only,
-- never `authenticated` — this takes a caller-supplied p_user_id and must
-- only ever be invoked by the trusted backend on the authenticated user's
-- own behalf, never directly by a client.
revoke all on function public.try_consume_ai_feature_usage(uuid, text, integer, integer) from public;
grant execute on function public.try_consume_ai_feature_usage(uuid, text, integer, integer) to service_role;

-- ----------------------------------------------------------------------------
-- push_subscriptions — one row per browser/device a user has granted Web
-- Push permission on (a user can have several: phone + laptop + a second
-- browser). `endpoint` (the push service's own per-registration URL, e.g.
-- https://fcm.googleapis.com/fcm/send/<id> or Apple/Mozilla's equivalent) is
-- globally unique by construction — the browser mints a fresh one per
-- (device, browser profile, origin), never reused across devices — so it
-- alone is the natural upsert key for POST /notifications/subscribe: a
-- resubscribe (e.g. after the browser silently rotates the endpoint via its
-- own `pushsubscriptionchange` event) simply updates the existing row's keys
-- in place instead of accumulating a stale duplicate. p256dh/auth_key are
-- the subscription's own public key + auth secret (PushSubscriptionJSON.keys
-- from the browser), required by the Web Push encryption spec (RFC 8291) —
-- both opaque, non-secret-to-us blobs the push service itself needs, not
-- credentials for this app. Deliberately no RLS-bypassing read path from the
-- frontend: subscriptions are written/read only by this user's own browser
-- (via the backend) and consumed only by the backend's own scheduler
-- (service-role client), never listed back to the frontend.
-- ----------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth_key     text not null,
  -- Free-text browser UA at subscribe time — purely a debugging aid for
  -- "why didn't my phone get a notification", never parsed/branched on.
  user_agent   text,
  created_at   timestamptz not null default now(),
  -- Bumped on every successful send (see backend/services/push_service.py) —
  -- not currently used for eviction (the 410-Gone self-cleaning path below
  -- handles genuinely dead subscriptions), but kept so a future "prune
  -- anything untouched for N months" pass has the data to do it without a
  -- schema change.
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_user_id on public.push_subscriptions(user_id);

-- Tables created after initial project setup don't automatically inherit
-- Supabase's default `public`-schema grants (see weight_logs' identical
-- comment above, first hit with this exact "permission denied for table X"
-- error from the service-role client) — granted explicitly here for the
-- same reason.
grant select, insert, update, delete on public.push_subscriptions to service_role, authenticated;

-- ----------------------------------------------------------------------------
-- notification_preferences — one row per user, account configuration (same
-- category as profiles itself, not history) so it's deliberately excluded
-- from backend/routers/account.py's RESET_TABLES the same way profiles is.
-- The last_*_sent columns are the server-side equivalent of the old
-- frontend-only localStorage "have I already reminded today" keys
-- (frontend/js/reminders.js's KEY_LAST_FIRED etc.) — they have to live here
-- now instead, since the whole point of real Web Push is firing while no
-- tab is open to hold that state client-side.
-- ----------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  -- Master switch — distinct from the browser's own Notification permission
  -- grant. Flipped on only after a real PushManager.subscribe() succeeds
  -- (frontend/js/notifications.js). Turning it back OFF deliberately does a
  -- full teardown (browser-side subscription.unsubscribe() + DELETE
  -- /notifications/subscribe), not just this flag — a subscription this
  -- user has switched off would otherwise never be attempted again, so it
  -- would never hit the 410-Gone self-cleaning path in
  -- backend/services/push_service.py either, leaving a permanently-idle row
  -- behind forever. Re-enabling later costs one fresh, instant
  -- pushManager.subscribe() call, no new permission prompt (browser
  -- Notification permission and the push subscription itself are two
  -- separate things — permission, once granted, stays granted).
  push_enabled             boolean not null default false,
  daily_reminder_enabled   boolean not null default true,
  -- "fixed" = one reminder at daily_reminder_time; "interval" = a repeating
  -- check-in every reminder_interval_hours instead of a single daily time —
  -- the "or an interval" option from the product ask. Both modes still
  -- respect quiet_hours_start/end below.
  reminder_mode            text not null default 'fixed' check (reminder_mode in ('fixed', 'interval')),
  -- "HH:MM" 24h, interpreted in the user's own profiles.timezone — validated
  -- by backend/models.py, not a DB constraint (keeping the validation regex
  -- in one place). Only meaningful when reminder_mode = 'fixed'.
  daily_reminder_time      text not null default '19:00',
  -- Only meaningful when reminder_mode = 'interval'. Bounded 1-12: below 1
  -- is indistinguishable from spam, above 12 is indistinguishable from once
  -- a day (which 'fixed' already covers better, with a time the user
  -- actually chose).
  reminder_interval_hours  integer not null default 4 check (reminder_interval_hours between 1 and 12),
  smart_nudges_enabled     boolean not null default true,
  weekly_recap_enabled     boolean not null default true,
  -- Quiet hours suppress every push type below, not just the smart nudges —
  -- a user picking a daily-reminder time that lands inside their own quiet
  -- hours is an intentional choice already reflected in daily_reminder_time,
  -- but a computed "how far off are you today" nudge always defers to this
  -- window instead. May wrap midnight (e.g. 22:00 -> 08:00) — see
  -- services/notification_service.py::in_quiet_hours for the wraparound
  -- handling.
  quiet_hours_start        text not null default '22:00',
  quiet_hours_end          text not null default '08:00',
  -- Drives which of frontend/js/i18n.js's two dictionaries the PUSH BODY
  -- TEXT itself is generated in (backend/services/notification_copy.py) —
  -- deliberately a stored column, not derived per-request, because a
  -- background sweep has no live request/Accept-Language header to read;
  -- the frontend pushes its current UI language here on every save (see
  -- notifications.js) and again via onLanguageChange so a language switch
  -- takes effect on the next scheduled push, not just the in-app UI.
  language                 text not null default 'en' check (language in ('en', 'ro')),
  last_daily_reminder_sent_at timestamptz,
  last_food_nudge_sent     date,
  last_water_nudge_sent    date,
  last_weekly_recap_sent   date,
  updated_at               timestamptz not null default now()
);

-- Existing projects: last_daily_reminder_sent was a `date` (one fixed-time
-- reminder/day was the only mode that existed) — 'interval' mode needs a
-- real timestamp to measure "how long since the last one" against, so this
-- migrates to timestamptz. Best-effort backfill (midnight UTC on the old
-- date) rather than left null: a null reads as "never sent," which for an
-- interval-mode user who just migrated would send one reminder immediately
-- instead of waiting out a full interval — a harmless one-time nudge, but
-- the backfill avoids it being the common case for every existing user at
-- once.
alter table public.notification_preferences add column if not exists last_daily_reminder_sent_at timestamptz;
alter table public.notification_preferences add column if not exists last_daily_reminder_sent date;
update public.notification_preferences
  set last_daily_reminder_sent_at = last_daily_reminder_sent::timestamptz
  where last_daily_reminder_sent_at is null and last_daily_reminder_sent is not null;
alter table public.notification_preferences drop column if exists last_daily_reminder_sent;
alter table public.notification_preferences add column if not exists reminder_mode text not null default 'fixed';
alter table public.notification_preferences
  drop constraint if exists notification_preferences_reminder_mode_check,
  add constraint notification_preferences_reminder_mode_check check (reminder_mode in ('fixed', 'interval'));
alter table public.notification_preferences add column if not exists reminder_interval_hours integer not null default 4;
alter table public.notification_preferences
  drop constraint if exists notification_preferences_reminder_interval_hours_check,
  add constraint notification_preferences_reminder_interval_hours_check check (reminder_interval_hours between 1 and 12);
alter table public.notification_preferences add column if not exists language text not null default 'en';
alter table public.notification_preferences
  drop constraint if exists notification_preferences_language_check,
  add constraint notification_preferences_language_check check (language in ('en', 'ro'));

-- Same "granted explicitly, doesn't apply retroactively" reasoning as
-- push_subscriptions' identical grant just above.
grant select, insert, update, delete on public.notification_preferences to service_role, authenticated;

-- Existing projects: the trigger below only fires for auth.users rows
-- inserted AFTER this migration runs, so every already-existing user needs a
-- one-time backfill here too (all-defaults, push_enabled false — nobody is
-- silently opted into push by re-running this script).
insert into public.notification_preferences (user_id)
select id from auth.users
on conflict (user_id) do nothing;

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
alter table public.workout_sessions enable row level security;
alter table public.workout_sets enable row level security;
alter table public.ai_feature_usage enable row level security;
alter table public.ai_feature_usage_monthly enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_preferences enable row level security;

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

drop policy if exists "workout_sessions_owner" on public.workout_sessions;
create policy "workout_sessions_owner" on public.workout_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "workout_sets_owner" on public.workout_sets;
create policy "workout_sets_owner" on public.workout_sets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Read-only for direct frontend access, unlike the "_owner" policies above:
-- these counters are a server-enforced quota, so a user should be able to
-- see their own usage (if this table were ever queried client-side) but
-- never write to it directly — every write goes through
-- increment_ai_feature_usage(), which runs as SECURITY DEFINER regardless
-- of this policy.
drop policy if exists "ai_feature_usage_owner_read" on public.ai_feature_usage;
create policy "ai_feature_usage_owner_read" on public.ai_feature_usage
  for select using (auth.uid() = user_id);

drop policy if exists "ai_feature_usage_monthly_owner_read" on public.ai_feature_usage_monthly;
create policy "ai_feature_usage_monthly_owner_read" on public.ai_feature_usage_monthly
  for select using (auth.uid() = user_id);

drop policy if exists "push_subscriptions_owner" on public.push_subscriptions;
create policy "push_subscriptions_owner" on public.push_subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "notification_preferences_owner" on public.notification_preferences;
create policy "notification_preferences_owner" on public.notification_preferences
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
  -- Every user gets a preferences row up front (all-defaults, push_enabled
  -- false) so GET /notifications/preferences and the scheduler's own query
  -- never need a "row doesn't exist yet" branch — same reasoning as
  -- profiles itself being auto-created here rather than lazily on first use.
  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

-- Trigger firing doesn't require EXECUTE privilege on the function for the
-- inserting role (the trigger manager invokes it directly, not via an
-- explicit SQL call), so revoking PUBLIC's default execute grant here is
-- free hardening, not a functional change: it just stops this
-- SECURITY DEFINER function from ALSO being callable directly (e.g. via
-- `supabase.rpc("handle_new_user")`) by any authenticated or even
-- unauthenticated client — see try_consume_ai_feature_usage's comment above
-- for why PostgreSQL's default-grant-to-PUBLIC-on-create behavior matters
-- for every SECURITY DEFINER function in this file, not just the quota ones.
revoke all on function public.handle_new_user() from public;

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
-- Also revoked from PUBLIC (see handle_new_user's comment just above) — this
-- one otherwise WOULD be directly callable by anyone, authenticated or not,
-- since it takes no parameters and doesn't error outside a trigger context
-- the way handle_new_user does. Each individual delete stays correctly
-- bounded to already-expired rows even if triggered early, so this was never
-- a data-integrity risk, but leaving a bulk-delete RPC world-callable is
-- still an unnecessary DB-load/DoS surface for zero benefit — it's only ever
-- meant to run from pg_cron or cleanup_service.py's APScheduler job, both of
-- which use the service-role/superuser connection, not a client role. (The
-- revoke below comes AFTER create, not before — see
-- increment_ai_feature_usage's comment on why order matters for a
-- from-scratch run of this script.)
create or replace function public.cleanup_old_logs()
returns void as $$
begin
  delete from public.daily_logs where logged_at < now() - interval '7 days';
  delete from public.water_logs where logged_at < now() - interval '7 days';
  -- ai_feature_usage rows are only ever read for "today" (see
  -- ai_usage_service.py) — a couple of days of slack (not just "today") so
  -- a run of this job that lands right at a UTC-day boundary never races
  -- a still-in-use row.
  delete from public.ai_feature_usage where usage_date < (now() at time zone 'utc')::date - interval '2 days';
  -- ai_feature_usage_monthly rows are only ever read for "this calendar
  -- month" — keeping the current AND previous month (not just current)
  -- means this can never race a row still being read right at a
  -- month-boundary job run, same reasoning as the 2-day slack above.
  delete from public.ai_feature_usage_monthly
    where usage_month < date_trunc('month', now() at time zone 'utc')::date - interval '1 month';
end;
$$ language plpgsql security definer;

revoke all on function public.cleanup_old_logs() from public;
grant execute on function public.cleanup_old_logs() to service_role;

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
