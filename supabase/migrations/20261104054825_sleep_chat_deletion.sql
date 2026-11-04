-- Delete conversation content while retaining only request identifiers and
-- timestamps needed for anti-replay and the existing request-rate limits.
-- No existing conversation is deleted or redacted by this migration.
begin;
alter table public.sleep_chat_conversations add column deleted_at timestamptz;
drop policy sleep_chat_conversations_read on public.sleep_chat_conversations;
create policy sleep_chat_conversations_read on public.sleep_chat_conversations
  for select to authenticated using ((select auth.uid()) = user_id and deleted_at is null);
drop policy sleep_chat_messages_read on public.sleep_chat_messages;
create policy sleep_chat_messages_read on public.sleep_chat_messages
  for select to authenticated using ((select auth.uid()) = user_id and exists (
    select 1 from public.sleep_chat_conversations c
    where c.id = sleep_chat_messages.conversation_id and c.user_id = sleep_chat_messages.user_id and c.deleted_at is null
  ));

create or replace function public.begin_sleep_chat(p_user_id uuid, p_conversation_id uuid, p_request_id uuid, p_question text, p_language text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.sleep_chat_messages%rowtype;
  owner_id uuid;
  deleted timestamptz;
  history jsonb;
begin
  if current_user <> 'service_role' then raise exception 'SERVICE_ONLY' using errcode = '42501'; end if;
  if p_user_id is null or p_conversation_id is null or p_request_id is null or p_question is null
    or char_length(btrim(p_question)) not between 1 and 800 or p_language is null or p_language not in ('zh','en') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  -- Serializes claims for one owner, including separate conversation IDs.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 7081));
  select user_id,deleted_at into owner_id,deleted from public.sleep_chat_conversations where id = p_conversation_id;
  if found and owner_id <> p_user_id then raise exception 'CONVERSATION_NOT_FOUND' using errcode = '42501'; end if;
  if deleted is not null then raise exception 'CONVERSATION_DELETED' using errcode = '55000'; end if;
  select * into existing from public.sleep_chat_messages where id = p_request_id;
  if found then
    if existing.user_id <> p_user_id or existing.conversation_id <> p_conversation_id
      or existing.question <> btrim(p_question) or existing.language <> p_language then
      raise exception 'REQUEST_ID_CONFLICT' using errcode = '22023';
    end if;
    if existing.status = 'pending' and existing.created_at < now() - interval '2 minutes' then
      update public.sleep_chat_messages set status = 'failed', error_code = 'AI_TIMEOUT', completed_at = now() where id = p_request_id;
      existing.status := 'failed'; existing.error_code := 'AI_TIMEOUT';
    end if;
    return jsonb_build_object('status', existing.status, 'answer', existing.answer, 'error', existing.error_code);
  end if;
  update public.sleep_chat_messages set status = 'failed', error_code = 'AI_TIMEOUT', completed_at = now()
    where user_id = p_user_id and status = 'pending' and created_at < now() - interval '2 minutes';
  if exists (select 1 from public.sleep_chat_messages where user_id = p_user_id and status = 'pending') then
    raise exception 'CONVERSATION_BUSY' using errcode = '55000';
  end if;
  if (select count(*) from public.sleep_chat_messages where user_id = p_user_id and created_at > now() - interval '10 minutes') >= 20
    or (select count(*) from public.sleep_chat_messages where user_id = p_user_id and created_at > now() - interval '1 day') >= 100 then
    raise exception 'RATE_LIMITED' using errcode = '54000';
  end if;
  insert into public.sleep_chat_conversations(id,user_id,title) values(p_conversation_id,p_user_id,left(btrim(p_question),80))
    on conflict (id) do update set updated_at = now() where public.sleep_chat_conversations.user_id = p_user_id;
  -- Only the latest six completed turns are context; no recording or diary query.
  select coalesce(jsonb_agg(jsonb_build_object('question', q.question, 'answer', left(q.answer,2400)) order by q.created_at),'[]'::jsonb)
    into history from (select question,answer,created_at from public.sleep_chat_messages
      where conversation_id = p_conversation_id and user_id = p_user_id and status = 'completed'
      order by created_at desc, id desc limit 6) q;
  insert into public.sleep_chat_messages(id,conversation_id,user_id,question,language)
    values(p_request_id,p_conversation_id,p_user_id,btrim(p_question),p_language);
  return jsonb_build_object('status','claimed','history',history);
end;
$$;

create function public.delete_sleep_conversation(p_user_id uuid, p_conversation_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  target public.sleep_chat_conversations%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'SERVICE_ONLY' using errcode = '42501'; end if;
  if p_user_id is null or p_conversation_id is null then raise exception 'INVALID_REQUEST' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 7081));
  select * into target from public.sleep_chat_conversations where id = p_conversation_id and user_id = p_user_id;
  if not found then raise exception 'CONVERSATION_NOT_FOUND' using errcode = '42501'; end if;
  if target.deleted_at is not null then return jsonb_build_object('status','deleted'); end if;
  -- The deployed provider request has a shorter timeout. Old abandoned claims
  -- may be cleared; a genuinely running request in this conversation blocks deletion.
  if exists (select 1 from public.sleep_chat_messages where conversation_id = p_conversation_id
      and user_id = p_user_id and status = 'pending' and created_at >= now() - interval '2 minutes') then
    raise exception 'CONVERSATION_BUSY' using errcode = '55000';
  end if;
  update public.sleep_chat_messages set question = '[Deleted]', answer = null, status = 'failed',
    error_code = 'CONVERSATION_DELETED', completed_at = now()
    where conversation_id = p_conversation_id and user_id = p_user_id;
  update public.sleep_chat_conversations set title = '[Deleted]', deleted_at = now(), updated_at = now()
    where id = p_conversation_id and user_id = p_user_id;
  return jsonb_build_object('status','deleted');
end;
$$;
revoke all on function public.delete_sleep_conversation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_sleep_conversation(uuid,uuid) to service_role;
commit;
