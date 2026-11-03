-- Add STR competitive-set rank to str_monthly. Rank is the subject property's
-- position within the comp set for that metric/period, parsed from the "Comp"
-- (Competitive Set Report) tab's performance Rank row (e.g. "1 of 5").
-- rank = our position, rank_total = number of hotels in the set.
alter table public.str_monthly
  add column if not exists rank       smallint,
  add column if not exists rank_total smallint;
