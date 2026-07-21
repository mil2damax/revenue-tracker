-- Add room statistics columns to daily_revenue
alter table daily_revenue
  add column if not exists rooms_total         int,
  add column if not exists rooms_ooo           int,
  add column if not exists rooms_comp          int,
  add column if not exists rooms_house         int,
  add column if not exists no_shows            int,
  add column if not exists walk_ins            int,
  add column if not exists cancellations       int,
  add column if not exists tomorrow_arrivals   int,
  add column if not exists tomorrow_departures int;
