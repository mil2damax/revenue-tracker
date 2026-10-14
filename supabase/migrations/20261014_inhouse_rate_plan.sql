-- Add rate_plan (SRP code) to inhouse_balances so reward/comp can be
-- distinguished by the PMS rate plan code (e.g. L-CMP = complimentary,
-- L-HHNSRR = Standard Reward) instead of inferring "comp" from a zero rate.
-- PEP (Tru/RDURM) in-house reports carry a Rate Plan column; WKFCW HotelKey
-- in-house reports do not, so this is left null for those rows.
alter table public.inhouse_balances
  add column if not exists rate_plan text;
