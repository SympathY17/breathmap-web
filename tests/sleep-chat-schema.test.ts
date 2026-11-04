import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

let db: PGlite;
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const conversation = '33333333-3333-4333-8333-333333333333';
const request = '44444444-4444-4444-8444-444444444444';
const query = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql, args)).rows;
const claim = (id = request, text = 'How can I wind down?', user = owner, conv = conversation) => query('select public.begin_sleep_chat($1,$2,$3,$4,$5) as result', [user,conv,id,text,'en']).then(rows=>rows[0].result);
const finish = (id = request, user = owner) => query('select public.finish_sleep_chat($1,$2,$3,$4) as result', [user,id,'Keep a consistent routine.',null]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    insert into auth.users(id) values('${owner}'),('${other}');`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20261104035732_sleep_chat.sql', import.meta.url), 'utf8'));
}, 30000);
afterAll(async () => { await db?.close(); });

describe.sequential('sleep chat database contract and ownership', () => {
  it('enables RLS and exposes only owner reads to browser roles', async () => {
    const tables = await query("select relname,relrowsecurity from pg_class where relname in ('sleep_chat_conversations','sleep_chat_messages') order by relname");
    expect(tables).toHaveLength(2); expect(tables.every(row=>row.relrowsecurity)).toBe(true);
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${owner}'`);
    await expect(query('insert into public.sleep_chat_conversations(id,user_id,title) values($1,$2,$3)',[conversation,owner,'fake'])).rejects.toThrow(/permission denied/);
    await expect(claim()).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
  it('atomically claims once, returns pending on duplicate, and protects the request binding', async () => {
    await db.exec('set role service_role');
    expect((await claim()).status).toBe('claimed');
    expect((await claim()).status).toBe('pending');
    await expect(claim(request,'different question')).rejects.toThrow(/REQUEST_ID_CONFLICT/);
    await expect(claim('55555555-5555-4555-8555-555555555555','test',other)).rejects.toThrow(/CONVERSATION_NOT_FOUND/);
    await expect(claim('55555555-5555-4555-8555-555555555555')).rejects.toThrow(/CONVERSATION_BUSY/);
    await finish();
    expect(await claim()).toMatchObject({ status:'completed',answer:'Keep a consistent routine.' });
    await expect(finish()).rejects.toThrow(/REQUEST_NOT_PENDING/);
    await db.exec('reset role');
  });
  it('isolates conversation and answer history between accounts', async () => {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${owner}'`);
    expect(await query('select id,question,answer from public.sleep_chat_messages')).toHaveLength(1);
    expect(await query('select id from public.sleep_chat_conversations')).toHaveLength(1);
    await db.exec(`set request.jwt.claim.sub = '${other}'`);
    expect(await query('select id from public.sleep_chat_messages')).toHaveLength(0);
    expect(await query('select id from public.sleep_chat_conversations')).toHaveLength(0);
    await expect(query('update public.sleep_chat_messages set answer = $1 where id = $2',['forged answer',request])).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
  it('returns only completed turns as bounded context, preserves failure idempotency, and expires stale claims', async () => {
    await db.exec('set role service_role');
    const second = '66666666-6666-4666-8666-666666666666';
    const start = await claim(second,'What should I do next?');
    expect(start.history).toEqual([{question:'How can I wind down?',answer:'Keep a consistent routine.'}]);
    await query('select public.finish_sleep_chat($1,$2,$3,$4)',[owner,second,null,'AI_UNAVAILABLE']);
    expect(await claim(second,'What should I do next?')).toMatchObject({status:'failed',error:'AI_UNAVAILABLE'});
    const third = '77777777-7777-4777-8777-777777777777';
    await claim(third,'Try another question');
    await query("update public.sleep_chat_messages set created_at = now() - interval '3 minutes' where id = $1",[third]);
    expect(await claim(third,'Try another question')).toMatchObject({status:'failed',error:'AI_TIMEOUT'});
    await db.exec('reset role');
  });
  it('serializes duplicate claims and enforces per-user limits before a provider request', async () => {
    await db.exec('set role service_role');
    const next = '88888888-8888-4888-8888-888888888888';
    const [a,b] = await Promise.all([claim(next,'Concurrent question'),claim(next,'Concurrent question')]);
    expect([a.status,b.status].sort()).toEqual(['claimed','pending']);
    await finish(next);
    const count = Number((await query('select count(*) as n from public.sleep_chat_messages where user_id = $1',[owner]))[0].n);
    for (let i=count;i<20;i++) {
      const id = `99999999-9999-4999-8999-${String(i).padStart(12,'0')}`;
      await claim(id,'Question '+i); await finish(id);
    }
    await expect(claim('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Too many questions')).rejects.toThrow(/RATE_LIMITED/);
    expect(await claim()).toMatchObject({status:'completed'});
    await db.exec('reset role');
  });
});
