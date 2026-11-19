-- LY-YTD (last-year year-to-date) columns on monthly_revenue.
--
-- Every Hotel Statistics report (HotelKey + PEP) carries a dedicated LY-T-D
-- column: the PMS's own last-year year-to-date figure, through the same
-- calendar date as the current Y-T-D. We now capture it at parse time
-- (process-night-audit) onto the running current-month row, so the dashboard
-- can show an authoritative LY YTD comparison for EVERY property — including
-- Tru (RDURM) and Home2 (RDUTT), which have no prior-year monthly rows loaded
-- and previously showed no last-year numbers at all.

ALTER TABLE monthly_revenue
  ADD COLUMN IF NOT EXISTS ly_ytd_room_revenue  numeric,
  ADD COLUMN IF NOT EXISTS ly_ytd_total_revenue numeric,
  ADD COLUMN IF NOT EXISTS ly_ytd_occ_pct       numeric,
  ADD COLUMN IF NOT EXISTS ly_ytd_adr           numeric,
  ADD COLUMN IF NOT EXISTS ly_ytd_revpar        numeric;
