-- STR competitive-set membership, parsed from the "Response Report" tab of a
-- Monthly STAR report. One row per member property per report month (so comp-set
-- changes over time are tracked). is_subject = true for the report's own hotel.
create table if not exists public.str_compset (
  hotel_code    text not null,   -- subject property this comp set belongs to (e.g. RDURM)
  report_month  date not null,   -- first day of the reporting month
  member_str_id text not null,   -- STR id of the member hotel
  member_name   text,
  city_state    text,
  rooms         integer,
  open_date     text,            -- YYYYMM string as reported by STR
  is_subject    boolean not null default false,
  str_id        text,            -- subject property's STR id
  updated_at    timestamptz not null default now(),
  primary key (hotel_code, report_month, member_str_id)
);

create index if not exists str_compset_hotel_month_idx
  on public.str_compset (hotel_code, report_month);

alter table public.str_compset enable row level security;
drop policy if exists "str_compset anon read" on public.str_compset;
create policy "str_compset anon read" on public.str_compset for select using (true);
