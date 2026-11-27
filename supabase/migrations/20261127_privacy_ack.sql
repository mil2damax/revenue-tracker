-- Privacy / confidentiality acknowledgments.
--
-- Captured BEFORE login (no authenticated user), once per device. A random
-- device token in the browser's localStorage decides whether the gate is shown;
-- this table is the permanent "on file" record of each acceptance.
--
-- Written ONLY by the `log-acknowledgment` edge function (service role, which
-- bypasses RLS). RLS is enabled with NO anon/authenticated policies, so the log
-- is not readable or writable through the public anon key — the owner reads it
-- from the SQL editor (or a future owner-only view / edge function).

create table if not exists privacy_acknowledgments (
  id              bigint generated always as identity primary key,
  device_id       text not null,          -- per-device token (localStorage)
  clause_version  text not null,          -- which version of the notices was accepted
  ip_address      text,                   -- public IP, captured server-side from x-forwarded-for
  user_agent      text,                   -- browser/device string
  acknowledged_at timestamptz not null default now()
);

create index if not exists privacy_ack_device_idx on privacy_acknowledgments(device_id);
create index if not exists privacy_ack_time_idx   on privacy_acknowledgments(acknowledged_at desc);

alter table privacy_acknowledgments enable row level security;
-- No policies on purpose: anon/authenticated get no access; the edge function's
-- service-role key bypasses RLS to insert.
