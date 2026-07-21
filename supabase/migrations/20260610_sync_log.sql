-- sync_log: records every run of the sync-sharepoint Edge Function
create table if not exists sync_log (
  id            bigint generated always as identity primary key,
  ran_at        timestamptz not null default now(),
  property      text not null,
  date          date,
  files_found   int default 0,
  files_processed int default 0,
  skipped       boolean default false,
  status        text,   -- OK | PARTIAL | NO_FILES | ERROR
  message       text,
  results       jsonb
);

-- Index for quick lookup of most recent sync
create index if not exists sync_log_ran_at_idx on sync_log (ran_at desc);

-- Schedule is configured via Supabase Dashboard → Edge Functions → sync-sharepoint → Schedule
-- or via cron-job.org pointing at:
--   POST https://ltbjavxegskmhyjqpext.supabase.co/functions/v1/sync-sharepoint
--   Header: Authorization: Bearer <service_role_key>
--   Cron: 0 11 * * *  (11:00 UTC = 7:00am ET, daily)
