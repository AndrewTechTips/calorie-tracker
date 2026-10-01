-- Iron Log — daily refund cap for AI quota (2026-10-01)
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Safe to re-run. Safe to apply before or after the backend deploy:
--   * the OLD backend calls refund_ai_feature_usage with 3 arguments, which
--     still resolve to this function (p_max_refunds defaults to NULL =
--     uncapped, i.e. exactly the old behaviour);
--   * the NEW backend falls back to that same 3-argument call if this has
--     not been applied yet.
-- Everything below is the same SQL as sql/schema.sql's ai_feature_usage /
-- refund_ai_feature_usage sections; see the comments there for the reasoning.

begin;

-- 1. Per-row counter of capped refunds handed back today.
alter table public.ai_feature_usage
  add column if not exists refund_count integer not null default 0 check (refund_count >= 0);

-- 2. The refund function gains p_max_refunds and now returns whether it
--    refunded. The return type changes (void -> boolean), so the old
--    three-argument version has to be dropped first.
drop function if exists public.refund_ai_feature_usage(uuid, text, boolean);

create or replace function public.refund_ai_feature_usage(
  p_user_id uuid,
  p_feature text,
  p_refund_monthly boolean default false,
  p_max_refunds integer default null
)
returns boolean as $$
begin
  update public.ai_feature_usage
     set call_count = call_count - 1,
         refund_count = refund_count + (case when p_max_refunds is null then 0 else 1 end),
         updated_at = now()
   where user_id = p_user_id
     and feature = p_feature
     and usage_date = (now() at time zone 'utc')::date
     and call_count > 0
     and (p_max_refunds is null or refund_count < p_max_refunds);

  if not found then
    return false;
  end if;

  if p_refund_monthly then
    update public.ai_feature_usage_monthly
       set call_count = greatest(0, call_count - 1), updated_at = now()
     where user_id = p_user_id
       and feature = p_feature
       and usage_month = date_trunc('month', now() at time zone 'utc')::date;
  end if;

  return true;
end;
$$ language plpgsql security definer set search_path = public;

-- 3. A newly created function picks up Supabase's default grants to anon and
--    authenticated again, so lock it back down to the backend only.
revoke all on function public.refund_ai_feature_usage(uuid, text, boolean, integer) from public;
revoke all on function public.refund_ai_feature_usage(uuid, text, boolean, integer) from anon, authenticated;
grant execute on function public.refund_ai_feature_usage(uuid, text, boolean, integer) to service_role;

commit;

-- 4. Make PostgREST see the new signature immediately.
notify pgrst, 'reload schema';

-- 5. Check: expect refund_count = true, anon = false, authenticated = false.
select
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'ai_feature_usage'
             and column_name = 'refund_count') as refund_count,
  has_function_privilege('anon', 'public.refund_ai_feature_usage(uuid, text, boolean, integer)', 'execute') as anon,
  has_function_privilege('authenticated', 'public.refund_ai_feature_usage(uuid, text, boolean, integer)', 'execute') as authenticated;
