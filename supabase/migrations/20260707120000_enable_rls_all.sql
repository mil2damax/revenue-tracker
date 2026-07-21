-- Enable Row-Level Security on every public table (Supabase security advisor:
-- "rls_disabled_in_public"). Policy model:
--   - anon may SELECT everything (the dashboard reads with the embedded anon key;
--     PINs are Edge Function env secrets, never in tables)
--   - anon may write ONLY where the app writes directly with the anon key:
--       transaction_notes  (accountability notes: insert)
--       medallia_surveys   (upload-medallia.ps1: insert)
--       monthly_revenue    (History editor: upsert = insert+update, delete)
--   - all other writes go through Edge Functions using the service role,
--     which bypasses RLS entirely.

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t.tablename and cmd = 'SELECT'
    ) then
      execute format('create policy "anon read" on public.%I for select using (true)', t.tablename);
    end if;
  end loop;
end $$;

-- Targeted write access for direct anon-key writes from the app/scripts
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='transaction_notes' and cmd='INSERT') then
    create policy "anon insert" on public.transaction_notes for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='medallia_surveys' and cmd='INSERT') then
    create policy "anon insert" on public.medallia_surveys for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='monthly_revenue' and cmd='INSERT') then
    create policy "anon insert" on public.monthly_revenue for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='monthly_revenue' and cmd='UPDATE') then
    create policy "anon update" on public.monthly_revenue for update using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='monthly_revenue' and cmd='DELETE') then
    create policy "anon delete" on public.monthly_revenue for delete using (true);
  end if;
end $$;
