-- Tighten RLS: some tables were created early with permissive "for all" policies,
-- which still allowed anon writes after RLS was enabled. Drop every INSERT/
-- UPDATE/DELETE/ALL policy in public, then re-create only the writes the app
-- actually performs with the anon key. SELECT policies are left untouched.
-- (Edge Functions use the service role and bypass RLS regardless.)

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and cmd in ('INSERT','UPDATE','DELETE','ALL')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Re-create the three sanctioned anon write paths
create policy "anon insert" on public.transaction_notes for insert with check (true);
create policy "anon insert" on public.medallia_surveys  for insert with check (true);
create policy "anon insert" on public.monthly_revenue   for insert with check (true);
create policy "anon update" on public.monthly_revenue   for update using (true);
create policy "anon delete" on public.monthly_revenue   for delete using (true);
