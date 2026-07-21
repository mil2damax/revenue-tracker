-- settlements: one row per payment settlement from HotelKey's
-- "Settlement By Payment Type" report — source of truth for CC reconciliation.
-- payment_detail holds the card last-4 (or "POS"/"" for non-card types).
create table if not exists settlements (
  id                 bigint generated always as identity primary key,
  property           text not null,
  date               date not null,
  row_number         int not null,
  account_category   text,   -- Reservation | House Account
  time               time,
  transaction_number text,
  folio_number       text,
  guest_name         text,
  account_name       text,   -- e.g. CLC, IHG Reward Night Reimbursements
  room_number        text,
  payment_type       text,   -- VISA | MASTER | AMEX | DISCOVER | BILL TO COMPANY | CASH | CHECK ...
  payment_detail     text,   -- card last-4
  amount             numeric(12,2),
  username           text,
  remarks            text,
  created_at         timestamptz not null default now(),
  unique (property, date, row_number)
);

create index if not exists settlements_prop_date_idx on settlements (property, date desc);
create index if not exists settlements_payment_type_idx on settlements (property, payment_type, date desc);

-- Read access for the dashboard (anon key); writes only via service role
alter table settlements enable row level security;
create policy "settlements anon read" on settlements for select using (true);
