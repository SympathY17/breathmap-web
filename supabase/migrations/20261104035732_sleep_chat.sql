-- General sleep conversations are independent of recording analysis jobs.
-- Browsers may read only their own conversations. Server-authenticated RPCs
-- are the only writers, so users cannot forge assistant answers or bypass limits.
begin;

create table public.sleep_chat_conversations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.sleep_chat_messages (
  id uuid primary key,
  conversation_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(question) between 1 and 800),
  answer text check (char_length(answer) between 1 and 12000),
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  language text not null check (language in ('zh','en')),
  error_code text check (char_length(error_code) <= 80),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (conversation_id, user_id) references public.sleep_chat_conversations(id, user_id) on delete cascade,
  check ((status = 'completed' and answer is not null) or (status <> 'completed' and answer is null))
);

create index sleep_chat_conversations_owner_updated on public.sleep_chat_conversations(user_id, updated_at desc);
create index sleep_chat_messages_owner_created on public.sleep_chat_messages(user_id, created_at desc);
create index sleep_chat_messages_conversation_created on public.sleep_chat_messages(conversation_id, user_id, created_at);
alter table public.sleep_chat_conversations enable row level security;
alter table public.sleep_chat_messages enable row level security;
create policy sleep_chat_conversations_read on public.sleep_chat_conversations for select to authenticated using ((select auth.uid()) = user_id);
create policy sleep_chat_messages_read on public.sleep_chat_messages for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.sleep_chat_conversations, public.sleep_chat_messages from public, anon, authenticated;
grant select on public.sleep_chat_conversations, public.sleep_chat_messages to authenticated;
grant all on public.sleep_chat_conversations, public.sleep_chat_messages to service_role;

create function public.begin_sleep_chat(p_user_id uuid, p_conversation_id uuid, p_request_id uuid, p_question text, p_language text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.sleep_chat_messages%rowtype;
  owner_id uuid;
  history jsonb;
begin
  if current_user <> 'service_role' then raise exception 'SERVICE_ONLY' using errcode = '42501'; end if;
  if p_user_id is null or p_conversation_id is null or p_request_id is null or p_question is null
    or char_length(btrim(p_question)) not between 1 and 800 or p_language is null or p_language not in ('zh','en') then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  -- Serializes claims for one owner, including separate conversation IDs.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 7081));
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
  select user_id into owner_id from public.sleep_chat_conversations where id = p_conversation_id;
  if found and owner_id <> p_user_id then raise exception 'CONVERSATION_NOT_FOUND' using errcode = '42501'; end if;
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

create function public.finish_sleep_chat(p_user_id uuid, p_request_id uuid, p_answer text, p_error text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result public.sleep_chat_messages%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'SERVICE_ONLY' using errcode = '42501'; end if;
  if (p_answer is null and (p_error is null or char_length(p_error) not between 1 and 80))
    or (p_answer is not null and (char_length(btrim(p_answer)) not between 1 and 12000 or p_error is not null)) then
    raise exception 'INVALID_RESULT' using errcode = '22023';
  end if;
  update public.sleep_chat_messages set answer = p_answer, error_code = p_error,
    status = case when p_answer is null then 'failed' else 'completed' end, completed_at = now()
    where id = p_request_id and user_id = p_user_id and status = 'pending' returning * into result;
  if not found then raise exception 'REQUEST_NOT_PENDING' using errcode = '22023'; end if;
  update public.sleep_chat_conversations set updated_at = now() where id = result.conversation_id and user_id = p_user_id;
  return jsonb_build_object('status',result.status,'answer',result.answer,'error',result.error_code);
end;
$$;

revoke all on function public.begin_sleep_chat(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.finish_sleep_chat(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.begin_sleep_chat(uuid,uuid,uuid,text,text), public.finish_sleep_chat(uuid,uuid,text,text) to service_role;
commit;
