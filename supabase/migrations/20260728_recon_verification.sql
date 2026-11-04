-- CC reconciliation: human verification sign-off (Loop 1) + bank deposits (Loop 2 foundation).

-- recon_verifications: one row per property+business-date once a reviewer signs off.
-- The India team reviews the automated PMS↔Processor match, resolves exceptions,
-- and marks the day verified. Absence of a row = "pending review".
create table if not exists recon_verifications (
  id             bigint generated always as identity primary key,
  property       text not null,
  recon_date     date not null,                 -- the business day reconciled
  status         text not null default 'verified',  -- verified | exception_cleared
  -- snapshot of the numbers at sign-off time, so a later data change is detectable
  matched_count      int,
  exception_count    int,
  hotelkey_total     numeric(12,2),
  processor_total    numeric(12,2),
  exception_notes    text,   -- how each exception was resolved
  notes              text,   -- general reviewer notes
  verified_by        text not null,             -- reviewer name/initials
  verified_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (property, recon_date)
);
create index if not exists recon_verif_prop_date_idx on recon_verifications (property, recon_date desc);

alter table recon_verifications enable row level security;
create policy "recon_verif read"   on recon_verifications for select using (true);
create policy "recon_verif insert" on recon_verifications for insert with check (true);
create policy "recon_verif update" on recon_verifications for update using (true);

-- bank_deposits: Loop 2 foundation — actual deposits that hit the bank
-- (Fiserv card settlements, Amex, etc.). Populated later from bank/Amex statements
-- or manual entry; schema may evolve once a real statement format is seen.
create table if not exists bank_deposits (
  id             bigint generated always as identity primary key,
  property       text not null,
  deposit_date   date not null,        -- date funds posted to the bank
  source         text,                 -- Fiserv | Amex | Discover | ...
  amount         numeric(12,2) not null,
  card_brands    text,                 -- brands this deposit covers, if known
  reference      text,                 -- bank/processor reference number
  covers_batch_date date,              -- processor batch this deposit settles (once matched)
  notes          text,
  created_by     text,
  created_at     timestamptz not null default now(),
  unique (property, deposit_date, source, amount, reference)
);
create index if not exists bank_dep_prop_date_idx on bank_deposits (property, deposit_date desc);

alter table bank_deposits enable row level security;
create policy "bank_dep read"   on bank_deposits for select using (true);
create policy "bank_dep insert" on bank_deposits for insert with check (true);
create policy "bank_dep update" on bank_deposits for update using (true);
