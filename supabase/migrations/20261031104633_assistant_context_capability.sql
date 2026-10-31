-- Additive metadata only: the existing service-role writes and authenticated
-- read policy are unchanged. Apply before running the updated worker.
alter table public.worker_heartbeat
  add column assistant_protocol smallint not null default 0
    check (assistant_protocol between 0 and 1),
  add column assistant_seen_at timestamptz;

comment on column public.worker_heartbeat.assistant_protocol is
  'Assistant context protocol supported by the last capability-aware heartbeat; 0 is legacy.';
comment on column public.worker_heartbeat.assistant_seen_at is
  'Must equal last_seen for the capability to apply. Legacy heartbeats do not advance this value.';
