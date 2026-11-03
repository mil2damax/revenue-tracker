-- STR (Smith Travel Research) Monthly STAR benchmarking data.
-- One tidy row per (hotel, report month, metric, period) parsed from the
-- "Glance" tab of a Monthly STAR report. Metrics: occ, adr, revpar.
-- Periods: current (the report month), ytd, run3 (running 3 month),
-- run12 (running 12 month). Values are My Property vs Competitive Set,
-- plus the STR index (MPI/ARI/RGI) and the year-over-year % change of each.
create table if not exists public.str_monthly (
  hotel_code   text not null,
  report_month date not null,   -- first day of the reporting month (e.g. 2026-09-01)
  metric       text not null,   -- 'occ' | 'adr' | 'revpar'
  period       text not null,   -- 'current' | 'ytd' | 'run3' | 'run12'
  my_value     numeric,         -- My Property value (Occ %, ADR $, RevPAR $)
  comp_value   numeric,         -- Competitive Set value
  idx          numeric,         -- STR index: MPI (occ), ARI (adr), RGI (revpar); 100 = fair share
  my_chg       numeric,         -- YoY % change, My Property
  comp_chg     numeric,         -- YoY % change, Competitive Set
  idx_chg      numeric,         -- YoY % change in the index
  str_id       text,            -- STR property ID (75702 = Tru Wake Forest / RDURM)
  date_created date,            -- date STR generated the report
  updated_at   timestamptz not null default now(),
  primary key (hotel_code, report_month, metric, period)
);

create index if not exists str_monthly_hotel_month_idx
  on public.str_monthly (hotel_code, report_month);

-- Read access for the dashboard (anon key); writes only via service role.
alter table public.str_monthly enable row level security;
drop policy if exists "str_monthly anon read" on public.str_monthly;
create policy "str_monthly anon read" on public.str_monthly for select using (true);
