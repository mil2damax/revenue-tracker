-- ============================================================================
-- THE LOCK: replace every "anyone can read" policy with per-hotel access.
--
--   SELECT  -> public.can_see(<hotel col>)   (owner: all; manager: their hotel)
--   writes  -> the two browser-write paths now require the logged-in user to
--              have access to that hotel.
--
-- Hotel column is auto-detected per table: `property` (most), `hotel_code`
-- (STR tables), or neither -> owner-only (empty/meta tables).
--
-- ⚠️ COUPLED CUTOVER: once applied, anonymous reads return NOTHING, so the app
-- only works for logged-in users. Apply this TOGETHER with the auth-enabled
-- frontend (not standalone). Tested on a Pro preview branch first.
--
-- NOTE: medallia_surveys INSERT (from upload-medallia.ps1, which uses the anon
-- key) is intentionally left as-is here; it moves to a service-role edge
-- function in a follow-up migration so the script keeps working.
-- ============================================================================

-- 1. SELECT: drop whatever open read policy each table has, add per-hotel read
do $$
declare
  t record;
  p record;
  has_prop  boolean;
  has_hotel boolean;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename not in ('profiles','user_properties')   -- have their own policies
  loop
    -- remove existing SELECT policies (names vary: "anon read", "str_monthly anon read", ...)
    for p in
      select policyname from pg_policies
      where schemaname='public' and tablename=t.tablename and cmd='SELECT'
    loop
      execute format('drop policy %I on public.%I', p.policyname, t.tablename);
    end loop;

    select exists(select 1 from information_schema.columns
                  where table_schema='public' and table_name=t.tablename and column_name='property')
      into has_prop;
    select exists(select 1 from information_schema.columns
                  where table_schema='public' and table_name=t.tablename and column_name='hotel_code')
      into has_hotel;

    if has_prop then
      execute format('create policy "hotel read" on public.%I for select using (public.can_see(property))', t.tablename);
    elsif has_hotel then
      execute format('create policy "hotel read" on public.%I for select using (public.can_see(hotel_code))', t.tablename);
    else
      -- empty/meta tables with no hotel column: owner-only until built out
      execute format('create policy "owner read" on public.%I for select using (public.is_owner())', t.tablename);
    end if;
  end loop;
end $$;

-- 2. Browser write paths: require the logged-in user to have access to the hotel
--    (these are entered in the dashboard UI, so they ride the user's session).

-- transaction_notes: accountability notes (insert)
drop policy if exists "anon insert" on public.transaction_notes;
create policy "hotel insert" on public.transaction_notes
  for insert with check (public.can_see(property));

-- monthly_revenue: History editor (insert / update / delete)
drop policy if exists "anon insert" on public.monthly_revenue;
drop policy if exists "anon update" on public.monthly_revenue;
drop policy if exists "anon delete" on public.monthly_revenue;
create policy "hotel insert" on public.monthly_revenue
  for insert with check (public.can_see(property));
create policy "hotel update" on public.monthly_revenue
  for update using (public.can_see(property)) with check (public.can_see(property));
create policy "hotel delete" on public.monthly_revenue
  for delete using (public.can_see(property));
