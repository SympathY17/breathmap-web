-- BreathMap standalone schema. Apply to the new Supabase project only.
-- Auth UUIDs are authoritative; Softr email ownership is presentation compatibility.
begin;

create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
grant usage on schema private to authenticated, service_role;

create table public.profiles (
  id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  name text not null default '' check (char_length(name) <= 160),
  relax_preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(relax_preferences) = 'object' and octet_length(relax_preferences::text) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recordings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  details text not null default '' check (char_length(details) <= 10000),
  notes text not null default '' check (char_length(notes) <= 10000),
  recorded_at timestamptz not null,
  uploaded_at timestamptz not null default now(),
  file_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_size bigint not null check (file_size between 1 and 52428800),
  input_sha256 text check (input_sha256 ~ '^[0-9a-f]{64}$'),
  trashed_at timestamptz,
  deletion_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,user_id),
  check (file_path = user_id::text || '/' || id::text || '/input.xlsx')
);

create table public.diary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '',
  date date not null,
  bed_at timestamptz,
  wake_at timestamptz,
  awakening_count integer check (awakening_count >= 0),
  sleep_quality integer check (sleep_quality between 1 and 5),
  day_sleepiness integer check (day_sleepiness between 1 and 5),
  caffeine_note text not null default '',
  notes text not null default '',
  recordings uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(recordings) <= 100),
  check (wake_at is null or bed_at is null or wake_at >= bed_at)
);

create table public.monitoring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  scheduled_at timestamptz not null,
  status text not null default 'Planned',
  notes text not null default '',
  recording_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (recording_id,user_id) references public.recordings(id,user_id)
);

create table public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  bed_time time not null,
  wake_time time not null,
  target_minutes integer not null check (target_minutes between 1 and 1440),
  wind_down_minutes integer not null check (wind_down_minutes between 0 and 1440),
  days jsonb not null default '[]'::jsonb check (jsonb_typeof(days) = 'array'),
  commitments jsonb not null default '[]'::jsonb check (jsonb_typeof(commitments) = 'array'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  appointment_at timestamptz,
  concerns text not null default '',
  questions text not null default '',
  notes text not null default '',
  after_notes text not null default '',
  status text not null default 'Preparing',
  recordings uuid[] not null default '{}',
  diary_from date,
  diary_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(recordings) <= 100),
  check (diary_from is null or diary_to is null or diary_to >= diary_from)
);

create table public.reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  completed_at timestamptz not null,
  median_ms double precision check (median_ms >= 0 and median_ms < 'Infinity'::float8),
  mean_ms double precision check (mean_ms >= 0 and mean_ms < 'Infinity'::float8),
  misses integer not null check (misses >= 0),
  false_starts integer not null check (false_starts >= 0),
  valid_trials integer not null check (valid_trials >= 0),
  trial_count integer not null check (trial_count > 0 and valid_trials <= trial_count),
  sleepiness integer check (sleepiness between 1 and 5),
  trials_json jsonb not null default '[]'::jsonb check (jsonb_typeof(trials_json) = 'array'),
  test_version text not null,
  device_class text not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,completed_at,test_version)
);

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recording_id uuid not null,
  operation text not null check (operation in ('analyse','report','chat','waveform')),
  payload jsonb not null default '{}'::jsonb,
  request_key text not null check (char_length(request_key) between 1 and 128),
  status text not null default 'queued' check (status in ('queued','running','completed','failed','interrupted')),
  lease_token uuid,
  worker_id text,
  result_sha256 text check (result_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (user_id,request_key),
  foreign key (recording_id,user_id) references public.recordings(id,user_id) on delete cascade
);

create table public.analysis_results (
  recording_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  summary jsonb not null default '{}'::jsonb,
  display jsonb not null default '{}'::jsonb,
  windows jsonb not null default '{}'::jsonb,
  wave_manifest jsonb not null default '{}'::jsonb,
  result_sha256 text check (result_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  foreign key (recording_id,user_id) references public.recordings(id,user_id) on delete cascade
);

create table public.worker_heartbeat (
  id text primary key default 'main' check (id = 'main'),
  last_seen timestamptz not null default now(),
  status text not null default 'online' check (status in ('online','offline','busy'))
);

create index recordings_user_uploaded_idx on public.recordings(user_id,uploaded_at desc,id);
create index diary_user_date_idx on public.diary(user_id,date desc,id);
create index monitoring_user_scheduled_idx on public.monitoring(user_id,scheduled_at,id);
create index routines_user_idx on public.routines(user_id,id);
create index visits_user_appointment_idx on public.visits(user_id,appointment_at desc,id);
create index reactions_user_completed_idx on public.reactions(user_id,completed_at desc,id);
create index jobs_queue_idx on public.analysis_jobs(created_at,id) where status = 'queued';
create index jobs_owner_record_idx on public.analysis_jobs(user_id,recording_id,created_at desc);
create index jobs_running_worker_idx on public.analysis_jobs(worker_id) where status = 'running';
create index jobs_recording_owner_fk_idx on public.analysis_jobs(recording_id,user_id);
create index results_recording_owner_fk_idx on public.analysis_results(recording_id,user_id);
create index results_user_fk_idx on public.analysis_results(user_id);
create index monitoring_recording_owner_fk_idx on public.monitoring(recording_id,user_id);

create function private.touch_updated_at() returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
revoke all on function private.touch_updated_at() from public,anon,authenticated;

create function private.check_recording_links() returns trigger language plpgsql security invoker set search_path = '' as $$
declare linked_id uuid;
begin
  if array_position(new.recordings,null) is not null then raise exception 'Invalid recording link'; end if;
  foreach linked_id in array new.recordings loop
    if not exists (select 1 from public.recordings where id=linked_id and user_id=new.user_id) then
      raise exception 'Recording link is not available to this account';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function private.check_recording_links() from public,anon,authenticated;

create function private.unlink_deleted_recording() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  update public.diary set recordings=array_remove(recordings,old.id) where user_id=old.user_id and old.id=any(recordings);
  update public.visits set recordings=array_remove(recordings,old.id) where user_id=old.user_id and old.id=any(recordings);
  update public.monitoring set recording_id=null where user_id=old.user_id and recording_id=old.id;
  return old;
end;
$$;
revoke all on function private.unlink_deleted_recording() from public,anon,authenticated;

create function private.freeze_deleting_recording() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.deletion_started_at is not null and (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
    raise exception 'RECORDING_DELETION_STARTED';
  end if;
  return new;
end;
$$;
revoke all on function private.freeze_deleting_recording() from public,anon,authenticated;

do $$ declare tbl text; begin
  foreach tbl in array array['profiles','recordings','diary','monitoring','routines','visits','reactions'] loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',tbl);
  end loop;
end $$;
create trigger diary_owned_links before insert or update of recordings,user_id on public.diary for each row execute function private.check_recording_links();
create trigger visits_owned_links before insert or update of recordings,user_id on public.visits for each row execute function private.check_recording_links();
create trigger recordings_unlink before delete on public.recordings for each row execute function private.unlink_deleted_recording();
create trigger recordings_freeze_deleting before update on public.recordings for each row execute function private.freeze_deleting_recording();

-- Explicit grants and RLS are both required. No anonymous business access.
revoke all on public.profiles,public.recordings,public.diary,public.monitoring,public.routines,public.visits,public.reactions,public.analysis_jobs,public.analysis_results,public.worker_heartbeat from anon,authenticated;
grant select on public.profiles,public.recordings,public.diary,public.monitoring,public.routines,public.visits,public.reactions,public.analysis_results,public.worker_heartbeat to authenticated;
grant insert (id,name,relax_preferences) on public.profiles to authenticated;
grant update (id,name,relax_preferences) on public.profiles to authenticated;
grant insert (id,user_id,title,details,notes,recorded_at,file_path,file_name,file_size,input_sha256) on public.recordings to authenticated;
grant update (title,details,notes,recorded_at,trashed_at) on public.recordings to authenticated;
grant delete on public.recordings to authenticated;
grant insert,delete on public.diary,public.monitoring,public.routines,public.visits,public.reactions to authenticated;
grant update (title,date,bed_at,wake_at,awakening_count,sleep_quality,day_sleepiness,caffeine_note,notes,recordings) on public.diary to authenticated;
grant update (title,scheduled_at,status,notes,recording_id) on public.monitoring to authenticated;
grant update (title,bed_time,wake_time,target_minutes,wind_down_minutes,days,commitments,active) on public.routines to authenticated;
grant update (title,appointment_at,concerns,questions,notes,after_notes,status,recordings,diary_from,diary_to) on public.visits to authenticated;
grant update (title,completed_at,median_ms,mean_ms,misses,false_starts,valid_trials,trial_count,sleepiness,trials_json,test_version,device_class,notes) on public.reactions to authenticated;
grant select (id,user_id,recording_id,operation,payload,request_key,status,result_sha256,result,error_code,created_at,started_at,finished_at) on public.analysis_jobs to authenticated;
grant all on public.profiles,public.recordings,public.diary,public.monitoring,public.routines,public.visits,public.reactions,public.analysis_jobs,public.analysis_results,public.worker_heartbeat to service_role;

alter table public.profiles enable row level security;
create policy profile_read on public.profiles for select to authenticated using ((select auth.uid())=id);
create policy profile_create on public.profiles for insert to authenticated with check ((select auth.uid())=id);
create policy profile_update on public.profiles for update to authenticated using ((select auth.uid())=id) with check ((select auth.uid())=id);

do $$ declare tbl text; begin
  foreach tbl in array array['recordings','diary','monitoring','routines','visits','reactions','analysis_jobs','analysis_results'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid())=user_id)',tbl);
  end loop;
  foreach tbl in array array['recordings','diary','monitoring','routines','visits','reactions'] loop
    execute format('create policy owner_create on public.%I for insert to authenticated with check ((select auth.uid())=user_id)',tbl);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id)',tbl);
  end loop;
  foreach tbl in array array['diary','monitoring','routines','visits','reactions'] loop
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select auth.uid())=user_id)',tbl);
  end loop;
end $$;
create policy recording_delete_trashed on public.recordings for delete to authenticated using (
  (select auth.uid())=user_id and trashed_at is not null and deletion_started_at is not null
  and not exists(select 1 from public.analysis_jobs j where j.recording_id=recordings.id and j.user_id=recordings.user_id and j.status in ('queued','running'))
);
alter table public.worker_heartbeat enable row level security;
create policy worker_status_read on public.worker_heartbeat for select to authenticated using (true);

-- Privileged implementation lives outside the API-exposed schema. The public
-- wrapper uses invoker security; only this checked function may create jobs.
create function private.request_analysis_job(p_recording_id uuid,p_operation text,p_payload jsonb,p_request_key text)
returns public.analysis_jobs language plpgsql security definer set search_path = '' as $$
declare account_id uuid := auth.uid(); rec public.recordings; prior public.analysis_jobs; saved public.analysis_jobs; source_sha text;
begin
  if account_id is null then raise exception 'Sign in before requesting analysis'; end if;
  if p_operation not in ('analyse','report','chat','waveform') or p_operation is null then raise exception 'Unsupported operation'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>32768 then raise exception 'Invalid request payload'; end if;
  if p_payload ?| array['_input_sha256','_file_path','_result_sha256'] then raise exception 'Reserved request field'; end if;
  if p_request_key is null or char_length(p_request_key) not between 1 and 128 then raise exception 'Invalid request key'; end if;
  select * into rec from public.recordings where id=p_recording_id and user_id=account_id and trashed_at is null and deletion_started_at is null for share;
  if not found then raise exception 'Recording is not available to this account'; end if;
  if rec.input_sha256 is null then raise exception 'File checksum is required before analysis'; end if;
  if p_payload ? 'generate_report' and jsonb_typeof(p_payload->'generate_report') is distinct from 'boolean' then raise exception 'Invalid report option'; end if;
  if (p_operation in ('report','chat') or (p_operation='analyse' and p_payload->'generate_report'='true'::jsonb)) and p_payload->'ai_consent' is distinct from 'true'::jsonb then raise exception 'AI consent is required'; end if;
  if p_payload ? 'language' and (p_payload->>'language') not in ('en','zh') then raise exception 'Unsupported language'; end if;
  if p_operation='chat' and (jsonb_typeof(p_payload->'question') is distinct from 'string' or char_length(btrim(p_payload->>'question')) not between 1 and 2000) then raise exception 'Question must contain 1 to 2000 characters'; end if;
  select result_sha256 into source_sha from public.analysis_results where recording_id=rec.id and user_id=account_id;
  if p_operation<>'analyse' and source_sha is null then raise exception 'Saved analysis is required for this operation'; end if;
  if p_operation<>'analyse' and (
      jsonb_typeof(p_payload->'result_sha256') is distinct from 'string'
      or (p_payload->>'result_sha256') !~ '^[0-9a-f]{64}$'
      or (p_payload->>'result_sha256') is distinct from source_sha
    ) then raise exception 'The displayed analysis has changed; refresh before continuing'; end if;
  select * into prior from public.analysis_jobs where user_id=account_id and request_key=p_request_key;
  if found then
    if prior.recording_id<>rec.id or prior.operation<>p_operation or (prior.payload - array['_input_sha256','_file_path','_result_sha256'])<>p_payload then raise exception 'Request key already used for different content'; end if;
    return prior;
  end if;
  insert into public.analysis_jobs(user_id,recording_id,operation,payload,request_key)
    values(account_id,rec.id,p_operation,p_payload || jsonb_build_object('_input_sha256',rec.input_sha256,'_file_path',rec.file_path,'_result_sha256',source_sha),p_request_key)
    on conflict(user_id,request_key) do nothing
    returning * into saved;
  if not found then
    select * into saved from public.analysis_jobs where user_id=account_id and request_key=p_request_key;
    if saved.recording_id<>rec.id or saved.operation<>p_operation or (saved.payload - array['_input_sha256','_file_path','_result_sha256'])<>p_payload then raise exception 'Request key already used for different content'; end if;
  end if;
  return saved;
end;
$$;
revoke all on function private.request_analysis_job(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function private.request_analysis_job(uuid,text,jsonb,text) to authenticated;

create function public.request_analysis_job(p_recording_id uuid,p_operation text,p_payload jsonb,p_request_key text)
returns jsonb language sql security invoker set search_path = '' as $$
  select to_jsonb(j) - array['lease_token','worker_id'] from private.request_analysis_job(p_recording_id,p_operation,p_payload,p_request_key) j;
$$;
revoke all on function public.request_analysis_job(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.request_analysis_job(uuid,text,jsonb,text) to authenticated;

-- Quiesce work before file removal. NOWAIT avoids a record->job wait cycle
-- with the existing finisher's job->record lock order; callers retry safely.
create function private.begin_recording_deletion(p_recording_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare account_id uuid := auth.uid(); rec public.recordings;
begin
  if account_id is null then raise exception 'RECORDING_NOT_AVAILABLE'; end if;
  select * into rec from public.recordings where id=p_recording_id and user_id=account_id for update;
  if not found then raise exception 'RECORDING_NOT_AVAILABLE'; end if;
  if rec.trashed_at is null then raise exception 'RECORDING_NOT_TRASHED'; end if;
  if exists(select 1 from public.analysis_jobs where recording_id=rec.id and user_id=account_id and status='running') then
    raise exception 'RECORDING_ANALYSIS_RUNNING';
  end if;
  begin
    perform 1 from public.analysis_jobs where recording_id=rec.id and user_id=account_id for update nowait;
  exception when lock_not_available then raise exception 'RECORDING_TASK_BUSY';
  end;
  if exists(select 1 from public.analysis_jobs where recording_id=rec.id and user_id=account_id and status='running') then
    raise exception 'RECORDING_ANALYSIS_RUNNING';
  end if;
  update public.analysis_jobs set status='interrupted',error_code='deletion_requested',finished_at=now()
    where recording_id=rec.id and user_id=account_id and status='queued';
  update public.recordings set deletion_started_at=coalesce(deletion_started_at,now()) where id=rec.id and user_id=account_id returning * into rec;
  return jsonb_build_object('id',rec.id,'file_path',rec.file_path,'deletion_started_at',rec.deletion_started_at);
end;
$$;
revoke all on function private.begin_recording_deletion(uuid) from public,anon,authenticated;
grant execute on function private.begin_recording_deletion(uuid) to authenticated;
create function public.begin_recording_deletion(p_recording_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.begin_recording_deletion(p_recording_id);
$$;
revoke all on function public.begin_recording_deletion(uuid) from public,anon,authenticated;
grant execute on function public.begin_recording_deletion(uuid) to authenticated;

create function public.claim_analysis_job(p_worker_id text)
returns setof public.analysis_jobs language plpgsql security invoker set search_path = '' as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 then raise exception 'Invalid worker ID'; end if;
  update public.analysis_jobs j set status='interrupted',error_code='recording_unavailable',finished_at=now()
    where j.status='queued' and not exists(select 1 from public.recordings r where r.id=j.recording_id and r.user_id=j.user_id and r.trashed_at is null and r.deletion_started_at is null and r.input_sha256=j.payload->>'_input_sha256' and r.file_path=j.payload->>'_file_path');
  return query with candidate as (
    select j.id from public.analysis_jobs j where j.status='queued' order by j.created_at,j.id limit 1 for update skip locked
  ) update public.analysis_jobs j set status='running',worker_id=p_worker_id,lease_token=gen_random_uuid(),started_at=now(),finished_at=null,error_code=null
      from candidate c where j.id=c.id returning j.*;
end;
$$;
revoke all on function public.claim_analysis_job(text) from public,anon,authenticated;
grant execute on function public.claim_analysis_job(text) to service_role;

create function public.finish_analysis_job(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_analysis_result jsonb default null,p_error_code text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare task public.analysis_jobs; rec public.recordings; current_sha text; output_sha text;
begin
  select * into task from public.analysis_jobs where id=p_job_id and status='running' and lease_token=p_lease_token for update;
  if not found then return false; end if;
  if p_error_code is not null and (p_error_code !~ '^[a-zA-Z0-9_.-]{1,128}$') then raise exception 'Invalid error code'; end if;
  select * into rec from public.recordings where id=task.recording_id and user_id=task.user_id for share;
  if not found or rec.trashed_at is not null or rec.deletion_started_at is not null or rec.input_sha256 is distinct from task.payload->>'_input_sha256' or rec.file_path is distinct from task.payload->>'_file_path' then
    -- Keep the lease running until the worker has removed its unpublished
    -- objects; only its subsequent explicit error completion releases deletion.
    if p_error_code is not null and p_analysis_result is null then
      update public.analysis_jobs set status='interrupted',error_code='recording_changed',finished_at=now() where id=task.id;
      return true;
    end if;
    return false;
  end if;
  select result_sha256 into current_sha from public.analysis_results where recording_id=rec.id and user_id=rec.user_id;
  if task.operation<>'analyse' and current_sha is distinct from task.payload->>'_result_sha256' then
    if p_error_code is not null and p_analysis_result is null then
      update public.analysis_jobs set status='interrupted',error_code='result_changed',finished_at=now() where id=task.id;
      return true;
    end if;
    return false;
  end if;
  if p_result is not null and octet_length(p_result::text)>10485760 then raise exception 'Result exceeds size limit'; end if;
  if p_analysis_result is not null then
    if task.operation not in ('analyse','report') or jsonb_typeof(p_analysis_result)<>'object' or octet_length(p_analysis_result::text)>20971520 then raise exception 'Invalid analysis projection'; end if;
    output_sha := p_analysis_result->>'result_sha256';
    if output_sha is null or output_sha !~ '^[0-9a-f]{64}$' then raise exception 'Invalid result checksum'; end if;
    if task.operation='report' and output_sha is distinct from current_sha then raise exception 'Report cannot replace numerical analysis'; end if;
    insert into public.analysis_results(recording_id,user_id,summary,display,windows,wave_manifest,result_sha256)
      values(rec.id,rec.user_id,coalesce(p_analysis_result->'summary','{}'::jsonb),coalesce(p_analysis_result->'display','{}'::jsonb),coalesce(p_analysis_result->'windows','{}'::jsonb),coalesce(p_analysis_result->'wave_manifest','{}'::jsonb),output_sha)
      on conflict(recording_id) do update set summary=excluded.summary,display=excluded.display,windows=excluded.windows,wave_manifest=excluded.wave_manifest,result_sha256=excluded.result_sha256,updated_at=now();
  end if;
  update public.analysis_jobs set status=case when p_error_code is null then 'completed' when p_error_code='worker_restarted' and p_analysis_result is null then 'interrupted' else 'failed' end,result=p_result,result_sha256=coalesce(output_sha,current_sha),error_code=p_error_code,finished_at=now() where id=task.id;
  return true;
end;
$$;
revoke all on function public.finish_analysis_job(uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_analysis_job(uuid,uuid,jsonb,jsonb,text) to service_role;

-- Restart recovery must first fence an old in-flight completion under the same
-- job lock. A rotated lease keeps deletion blocked until artifact rollback and
-- explicit error completion. If completion won the lock, return its terminal
-- row unchanged so recovery preserves the published artifact.
create function public.fence_worker_job(p_job_id uuid,p_worker_id text)
returns setof public.analysis_jobs language plpgsql security invoker set search_path = '' as $$
declare task public.analysis_jobs;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 then raise exception 'Invalid worker ID'; end if;
  select * into task from public.analysis_jobs where id=p_job_id and worker_id=p_worker_id for update;
  if not found then return; end if;
  if task.status='running' then
    update public.analysis_jobs set lease_token=gen_random_uuid() where id=task.id returning * into task;
  end if;
  return next task;
end;
$$;
revoke all on function public.fence_worker_job(uuid,text) from public,anon,authenticated;
grant execute on function public.fence_worker_job(uuid,text) to service_role;

-- Retained only for migration compatibility. Its old terminal transition is
-- unreachable by workers: it would release the deletion gate before rollback.
create function public.recover_worker_jobs(p_worker_id text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  update public.analysis_jobs set status='interrupted',error_code='worker_restarted',finished_at=now()
    where status='running' and worker_id=p_worker_id;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.recover_worker_jobs(text) from public,anon,authenticated,service_role;

-- Private files. Upload precedes metadata creation, so the immutable input path
-- is restricted to the signed-in UUID but need not have a row yet.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('recordings','recordings',false,52428800,array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream']),
       ('analysis-artifacts','analysis-artifacts',false,52428800,array['application/json','application/octet-stream'])
on conflict(id) do nothing;
create policy recording_file_insert on storage.objects for insert to authenticated with check (
  bucket_id='recordings' and (storage.foldername(name))[1]=(select auth.uid())::text
  and cardinality(string_to_array(name,'/'))=3 and split_part(name,'/',3)='input.xlsx'
  and split_part(name,'/',2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);
create policy owned_file_read on storage.objects for select to authenticated using (
  bucket_id in ('recordings','analysis-artifacts') and (storage.foldername(name))[1]=(select auth.uid())::text
);
create policy owned_file_delete on storage.objects for delete to authenticated using (
  bucket_id in ('recordings','analysis-artifacts') and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.recordings r where r.user_id=(select auth.uid()) and r.id::text=(storage.foldername(name))[2]
    and r.trashed_at is not null and r.deletion_started_at is not null
    and not exists(select 1 from public.analysis_jobs j where j.recording_id=r.id and j.user_id=r.user_id and j.status in ('queued','running')))
);

commit;
