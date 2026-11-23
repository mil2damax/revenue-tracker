-- EV (Tesla Wall Connector) pay-per-use charging, monthly per property.
--
-- Source: Tesla for Business "Charging Statement" CSV exports, one file per
-- site per month (SiteLocationName -> property code; see below). Each session
-- row carries kWh (Quantity), Gross Revenue, Tesla Service Fee, and Net Revenue
-- (the hotel's actual payout = gross - sales tax - Tesla fee - fee tax).
-- Rows are aggregated per statement month. BAD_SESSION / INVENTORY_SESSION rows
-- are included because Tesla still credits them.
--
-- Site -> property: Candlewood Suites Wake Forest Raleigh N = WKFCW,
--   Tru by Hilton Wake Forest Raleigh North = RDURM,
--   Home2 Suites by Hilton Raleigh North I-540 = RDUTT.
--
-- Revenue values are loaded from the SQL editor, not committed to the repo.

create table if not exists ev_charging (
  property      text not null,
  period_start  date not null,          -- first of the statement month
  kwh           numeric,
  gross_revenue numeric,
  net_revenue   numeric,                -- hotel payout
  tesla_fee     numeric,
  tax           numeric,
  sessions      integer,
  updated_at    timestamptz default now(),
  primary key (property, period_start)
);
