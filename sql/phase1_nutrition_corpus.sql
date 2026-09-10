-- ===========================================================================
-- Phase 1 — local nutrition corpus + hybrid (vector + full-text) retrieval
--
-- HOW TO APPLY: paste this whole file into the Supabase SQL editor and run it
-- once. Nothing in this repo can execute DDL against the live project (the
-- service-role REST client has no exec_sql RPC), so this is a manual step —
-- the backend keeps working on the old remote-API path until you run it AND
-- flip NUTRITION_DB_LOCAL_CORPUS=true. Idempotent: safe to re-run.
--
-- WHAT THIS REPLACES. Today every ingredient lookup fans out to USDA
-- FoodData Central and Open Food Facts over HTTP — 4 calls per ingredient
-- (two names x two sources), up to 24 per six-component scan, against a USDA
-- key capped at 1,000 requests/hour. Each source returns only its own
-- top-25 lexical matches, so the correct entry is frequently never in the
-- candidate pool at all. This table holds both corpora locally so retrieval
-- is one indexed query over EVERYTHING, with no quota and no network leg.
--
-- WHAT THE VECTOR COLUMN IS FOR, AND WHAT IT IS NOT FOR. Read this before
-- changing how the RPC ranks, because it was measured, not assumed:
--
--   Embeddings here are a RECALL device only. They exist to get the right
--   row into the candidate pool. They are NOT a ranking signal and must not
--   become one. Cosine similarity over short food names cannot separate a
--   food from its fried/dried/composite variants, because that distinction
--   is a domain rule about macros, not a semantic distance. Measured on real
--   USDA descriptions, 2026-09-10:
--
--     paraphrase-multilingual-MiniLM-L12-v2 (the model in use)
--       'peanut butter' -> "Cookie, peanut butter" 0.908
--                          "Peanut butter, smooth style, with salt" 0.832
--       'olive oil'     -> "Olive tapenade" 0.743
--                          "Oil, olive, salad or cooking" 0.667
--       'salmon'        -> "Fish oil, salmon" 0.783   (902 kcal/100g)
--                          "Fish, salmon, Atlantic, cooked" 0.650
--
--     intfloat/multilingual-e5-large (tested as the alternative)
--       'banana' -> "Banana pudding" 0.847 / "Bananas, raw" 0.846
--                   / "Banana chips" 0.845      <- a 0.002 spread, i.e. noise
--       'piept de pui' -> "Beef, ground" 0.824 outranks the correct
--                         chicken-breast entry at 0.800
--
--   In every one of those, the composite dish or the form-changed product
--   outranks the plain ingredient. So the existing lexical gates in
--   services/nutrition_db_service.py::_score — including the allowlist gate
--   that rejects a candidate naming an ingredient the query never asked for
--   — STAY EXACTLY AS THEY ARE and run as filters over whatever this RPC
--   returns. They are the precision layer; this table is the recall layer.
--
-- WHY RECIPROCAL RANK FUSION, NOT A WEIGHTED SUM of cosine + ts_rank: the
-- two scores live on incompatible scales, and the cosine band above is
-- narrow (0.65-0.91 across both right and wrong answers) while ts_rank is
-- unbounded and sparse. Any weighted sum is therefore dominated by whichever
-- signal happens to have more spread on that query, which is not a property
-- you want deciding a calorie count. RRF uses only each result's RANK within
-- its own list, so it is scale-free by construction. Raw ts_rank and cosine
-- similarity are still returned per row for debugging, they just do not
-- decide the winner here.
-- ===========================================================================

create extension if not exists vector;


-- ---------------------------------------------------------------------------
-- The corpus itself. One row per (source, source_id) food.
--
-- Column types mirror what services/nutrition_db_service.py already hands its
-- callers, so a row from here drops straight into the existing pipeline with
-- no reshaping: per-100g macros, sodium in MILLIGRAMS (not grams — matches
-- this app's own sodium unit everywhere else), and fiber/sugar/sodium
-- NULLABLE on purpose. A null there means "the source is silent on this
-- nutrient", which lookup() deliberately keeps distinguishable from a
-- verified zero (see its docstring, and gemini_service._fill_missing_micros
-- which backfills exactly that case). Never default these to 0 on ingest.
-- ---------------------------------------------------------------------------
create table if not exists public.nutrition_corpus (
  id                bigint generated always as identity primary key,
  source            text not null check (source in ('usda', 'openfoodfacts')),
  source_id         text not null,
  food_name         text not null,
  -- Lowercased, diacritic-stripped, punctuation-flattened form of food_name.
  -- Produced at ingest time by scripts/ingest_nutrition_corpus.py using the
  -- backend's OWN nutrition_db_service._normalize(), so the text indexed here
  -- and the text a query is normalized to can never drift apart.
  search_text       text not null,
  calories_per_100g real not null,
  protein_per_100g  real not null,
  carbs_per_100g    real not null,
  fats_per_100g     real not null,
  fiber_per_100g    real,
  sugar_per_100g    real,
  sodium_per_100g   real,
  embedding         vector(384),
  -- 'simple', deliberately not 'english': this corpus is mixed English (USDA)
  -- and Romanian (Open Food Facts' RO slice), and an English stemmer applied
  -- to Romanian produces nonsense tokens that match nothing. 'simple' only
  -- lowercases and splits, which is the correct behaviour for a bilingual
  -- index. Singular/plural is already handled upstream by _canonical_tokens'
  -- own _singularize, on both the query and candidate side.
  fts               tsvector generated always as (to_tsvector('simple', search_text)) stored,
  updated_at        timestamptz not null default now(),
  unique (source, source_id)
);

comment on table public.nutrition_corpus is
  'Local mirror of USDA FoodData Central (Foundation/SR Legacy/FNDDS) and the '
  'Romanian slice of Open Food Facts. Reference data, not user data: no user_id, '
  'readable by every authenticated user, written only by the ingest script via '
  'the service-role key. Refresh quarterly; nutrition facts do not move fast.';


-- HNSW over cosine distance. HNSW (not IVFFlat) because it needs no training
-- step and no "rebuild after bulk load" ritual, which matters for a table
-- that is refreshed by re-running an ingest script rather than by continuous
-- writes. m/ef_construction left at pgvector's defaults (16/64): at ~25k rows
-- this index is small and the defaults are already well past the point of
-- diminishing returns.
create index if not exists idx_nutrition_corpus_embedding
  on public.nutrition_corpus using hnsw (embedding vector_cosine_ops);

create index if not exists idx_nutrition_corpus_fts
  on public.nutrition_corpus using gin (fts);

-- Supports the exact-name fast path in _search_local before it bothers with
-- either ranked search.
create index if not exists idx_nutrition_corpus_search_text
  on public.nutrition_corpus (search_text);


-- ---------------------------------------------------------------------------
-- Custom foods join the same index.
--
-- A user's own saved food is the HIGHEST trust tier in this app — they read
-- that exact product's label, versus USDA's category average or the model's
-- recall (see ingredientsList.js's four-tier trust ordering). It was also the
-- source with the LEAST forgiving matcher: custom_food_service looks up
-- .eq("normalized_name", key), so "piept de pui la gratar" saved and "piept
-- pui gratar" typed simply missed, and the user's own verified number was
-- silently ignored in favour of a generic estimate.
--
-- Adding the embedding here (rather than copying custom foods into
-- nutrition_corpus) keeps them where RLS already protects them and where the
-- existing CRUD already lives. The exact-name path in custom_food_service is
-- untouched and still runs first — this only adds a fuzzy second chance.
-- ---------------------------------------------------------------------------
alter table public.custom_foods
  add column if not exists embedding vector(384);

alter table public.custom_foods
  add column if not exists fts tsvector
  generated always as (to_tsvector('simple', coalesce(normalized_name, ''))) stored;

-- Partial index: rows whose embedding has not been generated yet (every row
-- that existed before this migration, until scripts/backfill_custom_food_embeddings.py
-- runs) are simply absent from the vector index rather than being a null-
-- distance landmine inside it.
create index if not exists idx_custom_foods_embedding
  on public.custom_foods using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

create index if not exists idx_custom_foods_fts
  on public.custom_foods using gin (fts);


-- ---------------------------------------------------------------------------
-- The hybrid search function.
--
-- Returns at most p_match_count rows, fused from two independently-ranked
-- lists (vector nearest-neighbour, full-text ts_rank) by Reciprocal Rank
-- Fusion. Every returned row still has to survive the caller's own gates —
-- this function deliberately applies NO plausibility, state or allowlist
-- filtering of its own. Keeping all of that in Python is what lets the
-- offline eval (backend/tests/test_retrieval_eval.py) exercise the real
-- decision logic against frozen candidates with no database at all.
--
-- p_user_id: when non-null, that user's custom_foods are searched alongside
-- the corpus and returned with source='custom'. Null searches the public
-- corpus only. This is a SECURITY DEFINER function so it can read
-- custom_foods regardless of the caller's RLS context, which makes the
-- p_user_id filter in the custom-food branch the ONLY thing separating one
-- user's saved foods from another's — it is not optional and must never be
-- made to default to "all users".
-- ---------------------------------------------------------------------------
create or replace function public.match_nutrition_corpus(
  p_query_embedding vector(384),
  p_query_text      text,
  p_match_count     integer default 40,
  p_user_id         uuid     default null
)
returns table (
  source            text,
  source_id         text,
  food_name         text,
  calories_per_100g real,
  protein_per_100g  real,
  carbs_per_100g    real,
  fats_per_100g     real,
  fiber_per_100g    real,
  sugar_per_100g    real,
  sodium_per_100g   real,
  similarity        real,
  text_rank         real,
  rrf_score         real
)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- RRF's smoothing constant. 60 is the value from the original Cormack et
  -- al. paper and the de-facto default; it flattens the gap between ranks 1
  -- and 2 enough that a single list cannot dominate the fusion on its own.
  k_rrf constant real := 60;
  -- How deep to go in each individual list before fusing. Wider than
  -- p_match_count on purpose: a row ranked 30th by vector and 30th by text
  -- is a better fused answer than one ranked 5th by text and absent from the
  -- vector list, and it can only be found if both lists are read past the
  -- final cut.
  per_list_limit constant integer := greatest(p_match_count * 2, 80);
  ts_q tsquery;
begin
  -- websearch_to_tsquery never raises on arbitrary user text (plain
  -- to_tsquery does), which matters because p_query_text is ultimately
  -- derived from a food name a model produced or a user typed. It yields
  -- AND semantics; that is intentional here. The full-text list is the
  -- high-precision half of the fusion and the vector list is the recall
  -- half, so making FTS looser would just have both halves return the same
  -- vague matches.
  ts_q := websearch_to_tsquery('simple', coalesce(p_query_text, ''));

  return query
  with vector_hits as (
    select
      c.id,
      'corpus'::text as origin,
      row_number() over (order by c.embedding <=> p_query_embedding) as rnk,
      (1 - (c.embedding <=> p_query_embedding))::real as sim
    from public.nutrition_corpus c
    where p_query_embedding is not null
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit per_list_limit
  ),
  text_hits as (
    select
      c.id,
      'corpus'::text as origin,
      row_number() over (order by ts_rank(c.fts, ts_q) desc) as rnk,
      ts_rank(c.fts, ts_q)::real as tr
    from public.nutrition_corpus c
    where ts_q is not null
      and c.fts @@ ts_q
    order by ts_rank(c.fts, ts_q) desc
    limit per_list_limit
  ),
  fused as (
    select
      coalesce(v.id, t.id) as id,
      coalesce(v.sim, 0)::real as sim,
      coalesce(t.tr, 0)::real as tr,
      (coalesce(1.0 / (k_rrf + v.rnk), 0)
       + coalesce(1.0 / (k_rrf + t.rnk), 0))::real as rrf
    from vector_hits v
    full outer join text_hits t on t.id = v.id
  ),
  corpus_rows as (
    select
      c.source,
      c.source_id,
      c.food_name,
      c.calories_per_100g,
      c.protein_per_100g,
      c.carbs_per_100g,
      c.fats_per_100g,
      c.fiber_per_100g,
      c.sugar_per_100g,
      c.sodium_per_100g,
      f.sim,
      f.tr,
      f.rrf
    from fused f
    join public.nutrition_corpus c on c.id = f.id
  ),
  -- The user's own saved foods, searched the same two ways. Ranked within
  -- their own (much smaller) lists, so a custom food competes on its own
  -- merits rather than being drowned by 25k corpus rows; the caller applies
  -- the trust-tier preference that puts a real label above a category
  -- average.
  custom_rows as (
    select
      'custom'::text as source,
      cf.id::text    as source_id,
      -- display_name, not normalized_name: this is what the user typed and
      -- what every trust badge and ingredient row will show them.
      cf.display_name as food_name,
      cf.calories_per_100g::real,
      cf.protein_per_100g::real,
      cf.carbs_per_100g::real,
      cf.fats_per_100g::real,
      cf.fiber_per_100g::real,
      cf.sugar_per_100g::real,
      cf.sodium_per_100g::real,
      case
        when cf.embedding is null or p_query_embedding is null then 0::real
        else (1 - (cf.embedding <=> p_query_embedding))::real
      end as sim,
      case when ts_q is not null and cf.fts @@ ts_q then ts_rank(cf.fts, ts_q)::real else 0::real end as tr,
      -- Custom foods bypass RRF and are handed a score above anything the
      -- fused corpus lists can produce (max possible RRF is 2/(60+1) ~= 0.033),
      -- so an eligible custom food is always offered to the caller. The caller
      -- still runs every gate over it.
      1.0::real as rrf
    from public.custom_foods cf
    where p_user_id is not null
      and cf.user_id = p_user_id
      and (
        (cf.embedding is not null and p_query_embedding is not null
         and (cf.embedding <=> p_query_embedding) < 0.45)
        or (ts_q is not null and cf.fts @@ ts_q)
      )
  )
  select * from (
    select * from corpus_rows
    union all
    select * from custom_rows
  ) all_rows
  order by all_rows.rrf desc, all_rows.sim desc
  limit p_match_count;
end;
$$;

comment on function public.match_nutrition_corpus is
  'Hybrid recall over the local nutrition corpus: vector kNN fused with '
  'full-text ts_rank by Reciprocal Rank Fusion. Applies NO plausibility or '
  'state filtering — that is the caller''s job (see '
  'backend/services/nutrition_db_service.py). Embeddings are a recall device, '
  'not a ranking signal; see this file''s header for the measurements behind '
  'that.';


-- ---------------------------------------------------------------------------
-- Grants. Tables and functions added AFTER the initial Supabase project setup
-- do NOT inherit the project's default grants — skipping this produces a live
-- 500 ("permission denied for table nutrition_corpus") from the service-role
-- client, not a silent no-op. Same footgun weight_logs and push_subscriptions
-- already carry their own comments about.
-- ---------------------------------------------------------------------------
grant select on public.nutrition_corpus to service_role, authenticated;
grant insert, update, delete on public.nutrition_corpus to service_role;
grant execute on function public.match_nutrition_corpus(vector, text, integer, uuid)
  to service_role, authenticated;

-- RLS on a public reference table: every authenticated user may read it, and
-- nobody but the service role may write it. Defence-in-depth for the
-- (currently unused) direct frontend->Supabase path, exactly like the rest of
-- the policies in schema.sql.
alter table public.nutrition_corpus enable row level security;

drop policy if exists "nutrition_corpus is readable by authenticated users" on public.nutrition_corpus;
create policy "nutrition_corpus is readable by authenticated users"
  on public.nutrition_corpus for select
  to authenticated
  using (true);


-- ---------------------------------------------------------------------------
-- Verification — run these after the ingest script finishes.
-- ---------------------------------------------------------------------------
-- Expect roughly 13k-14k usda rows and up to 10k openfoodfacts rows:
--   select source, count(*), count(embedding) as embedded from public.nutrition_corpus group by source;
--
-- Expect zero (every row must be embedded before the backend is switched on):
--   select count(*) from public.nutrition_corpus where embedding is null;
--
-- Smoke-test the RPC with a zero vector — the text half should still answer:
--   select food_name, calories_per_100g, text_rank
--   from public.match_nutrition_corpus(
--     array_fill(0::real, array[384])::vector(384), 'cooked white rice', 10, null)
--   order by text_rank desc;
