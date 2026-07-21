-- processor_transactions: one row per card transaction from Fiserv Business
-- Track's "daily settlement report" (Settlement / Search export, CSV or XLSX).
-- Loop 1 of CC reconciliation: matched against `settlements` (HotelKey) on
-- invoice_number == settlements.transaction_number + amount.
create table if not exists processor_transactions (
  id                 bigint generated always as identity primary key,
  property           text not null,
  tran_uid           text not null,  -- Fiserv "Tran UID" (PTCT...); fallback batch_no-rowN
  txn_date           date,           -- when the guest was charged
  batch_date         date,           -- when the batch settled
  funded_date        date,           -- when it hits the bank
  batch_no           text,
  invoice_number     text,           -- == HotelKey transaction_number (match key)
  network            text,           -- Visa | Mastercard | Amex | Discover ...
  account_last4      text,
  amount             numeric(12,2),
  transaction_type   text,           -- Purchase | Refund ...
  transaction_status text,           -- Processed | Rejected ...
  auth_code          text,
  created_at         timestamptz not null default now(),
  unique (property, tran_uid)
);

create index if not exists proctx_prop_batch_idx on processor_transactions (property, batch_date desc);
create index if not exists proctx_prop_invoice_idx on processor_transactions (property, invoice_number);
create index if not exists proctx_prop_funded_idx on processor_transactions (property, funded_date desc);

alter table processor_transactions enable row level security;
create policy "processor_transactions anon read" on processor_transactions for select using (true);
