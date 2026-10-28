-- Quiesce a trashed recording before private-file cleanup. Existing migrations are unchanged.

begin;

alter table public.recordings add column deletion_started_at timestamptz;

create function private.freeze_deleting_recording() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.deletion_started_at is not null and (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
    raise exception 'RECORDING_DELETION_STARTED';
  end if;
  return new;
end;
$$;
revoke all on function private.freeze_deleting_recording() from public,anon,authenticated;


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


create trigger recordings_freeze_deleting before update on public.recordings for each row execute function private.freeze_deleting_recording();

drop policy recording_delete_trashed on public.recordings;
create policy recording_delete_trashed on public.recordings for delete to authenticated using (
  (select auth.uid())=user_id and trashed_at is not null and deletion_started_at is not null
  and not exists(select 1 from public.analysis_jobs j where j.recording_id=recordings.id and j.user_id=recordings.user_id and j.status in ('queued','running'))
);

drop policy owned_file_delete on storage.objects;
create policy owned_file_delete on storage.objects for delete to authenticated using (
  bucket_id in ('recordings','analysis-artifacts') and (storage.foldername(name))[1]=(select auth.uid())::text
  and exists(select 1 from public.recordings r where r.user_id=(select auth.uid()) and r.id::text=(storage.foldername(name))[2]
    and r.trashed_at is not null and r.deletion_started_at is not null
    and not exists(select 1 from public.analysis_jobs j where j.recording_id=r.id and j.user_id=r.user_id and j.status in ('queued','running')))
);

create or replace function private.request_analysis_job(p_recording_id uuid,p_operation text,p_payload jsonb,p_request_key text)
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


create or replace function public.claim_analysis_job(p_worker_id text)
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


create or replace function public.finish_analysis_job(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_analysis_result jsonb default null,p_error_code text default null)
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

-- The prior worker process may have died while its finish HTTP request was
-- still executing. Fence under that RPC's job lock before touching artifacts.
-- Keep running until the new lease has rolled back and explicitly finished.
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
revoke all on function public.recover_worker_jobs(text) from public,anon,authenticated,service_role;


commit;
