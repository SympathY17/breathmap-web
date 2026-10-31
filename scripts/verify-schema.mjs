/** Execute the real schema and role/row-policy tests in disposable PostgreSQL WASM.
 * Storage/Auth tables below are deliberately minimal Supabase stubs. No network,
 * real users, credentials or cloud database are accessed. PGlite is one connection;
 * these checks verify claim transitions, not concurrent multi-connection behavior.
 */
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const db = new PGlite();
const checks = [];
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const RA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INPUT = '1'.repeat(64), RESULT = '2'.repeat(64), NEW_RESULT = '3'.repeat(64);

async function check(name, work) {
  await work(); checks.push(name);
}
async function rows(sql, values = []) { return (await db.query(sql, values)).rows; }
async function scalar(sql, values = []) { return Object.values((await rows(sql, values))[0])[0]; }
async function role(name, user, work) {
  assert.ok(['authenticated', 'anon', 'service_role', 'postgres'].includes(name));
  await db.exec(`reset role; set role ${name};`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user ?? '']);
  try { return await work(); }
  finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)"); }
}
async function denied(work, message = '') {
  let rejected = false;
  try { await work(); } catch (error) {
    rejected = true;
    assert.ok(['42501', '23503', '23514', 'P0001'].includes(error.code), `${message}: unexpected PostgreSQL code ${error.code}: ${error.message}`);
  }
  assert.ok(rejected, `${message}: operation was unexpectedly permitted`);
}
async function enqueue(user, recording, operation, payload, key) {
  return role('authenticated', user, () => scalar('select public.request_analysis_job($1,$2,$3::jsonb,$4)', [recording, operation, JSON.stringify(payload), key]));
}
async function beginDeletion(user, recording) {
  return role('authenticated', user, () => scalar('select public.begin_recording_deletion($1)', [recording]));
}
async function claim(worker = 'local-worker') {
  return role('service_role', null, () => rows('select * from public.claim_analysis_job($1)', [worker]));
}
async function finish(job, result = {}, projection = null, error = null) {
  return role('service_role', null, () => scalar('select public.finish_analysis_job($1,$2,$3::jsonb,$4::jsonb,$5)', [job.id, job.lease_token, JSON.stringify(result), projection === null ? null : JSON.stringify(projection), error]));
}
async function fence(job, worker = 'local-worker') {
  return role('service_role', null, () => rows('select * from public.fence_worker_job($1,$2)', [job.id, worker]));
}
const projection = hash => ({
  result_sha256: hash,
  summary: { schema: 'breathmap-web-summary-1', source_result_sha256: hash },
  display: { schema: 'breathmap-display-1', source_result_sha256: hash },
  windows: { model: { source_result_sha256: hash, items: [] } },
  wave_manifest: { source_result_sha256: hash },
});

try {
  const bootstrap = `
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema storage;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
    grant all on storage.buckets to service_role;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name,'/'))[1:cardinality(string_to_array(name,'/'))-1];
    $$;
    -- Reproduce broad Supabase function defaults to catch missing explicit revokes.
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
  `;
  await db.exec(bootstrap);
  await db.query('insert into auth.users(id,email) values($1,$2),($3,$4)', [A, 'synthetic-a@example.invalid', B, 'synthetic-b@example.invalid']);
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await check('schema parses and executes on PostgreSQL', () => db.exec(schema));
  await check('new migration upgrades deployed schema without rewriting existing recording data', async () => {
    const upgrade = new PGlite();
    try {
      await upgrade.exec(bootstrap);
      const directory = new URL('../supabase/migrations/', import.meta.url);
      const migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
      const deletionIndex = migrations.findIndex(name => name.endsWith('_recording_deletion_lifecycle.sql'));
      assert.ok(deletionIndex >= 1);
      assert.ok(migrations.at(-1).endsWith('_assistant_context_capability.sql'));
      for (const name of migrations.slice(0,deletionIndex)) await upgrade.exec(await readFile(new URL(name,directory),'utf8'));
      await upgrade.query('insert into auth.users(id,email) values($1,$2)', [A,'synthetic-upgrade@example.invalid']);
      await upgrade.query('insert into public.recordings(id,user_id,title,recorded_at,file_path,file_name,file_size,input_sha256) values($1,$2,$3,now(),$4,$5,100,$6)', [RA,A,'Preserved legacy recording',`${A}/${RA}/input.xlsx`,'synthetic.xlsx',INPUT]);
      await upgrade.query("insert into public.worker_heartbeat(id,last_seen,status) values('main','2026-10-28T13:57:53Z','offline')");
      for (const name of migrations.slice(deletionIndex)) await upgrade.exec(await readFile(new URL(name,directory),'utf8'));
      const [record] = (await upgrade.query('select title,input_sha256,deletion_started_at from public.recordings where id=$1',[RA])).rows;
      assert.deepEqual(record,{ title:'Preserved legacy recording',input_sha256:INPUT,deletion_started_at:null });
      const [heartbeat] = (await upgrade.query('select status,assistant_protocol,assistant_seen_at,last_seen from public.worker_heartbeat')).rows;
      assert.equal(heartbeat.status,'offline');
      assert.equal(heartbeat.assistant_protocol,0);
      assert.equal(heartbeat.assistant_seen_at,null);
      assert.equal(new Date(heartbeat.last_seen).toISOString(),'2026-10-28T13:57:53.000Z');
    } finally { await upgrade.close(); }
  });

  for (const user of [A, B]) {
    await role('authenticated', user, async () => {
      await db.query('insert into public.profiles(id,name) values($1,$2)', [user, `Synthetic ${user === A ? 'A' : 'B'}`]);
    });
  }
  await check('profile upsert and own-only read', () => role('authenticated', A, async () => {
    await db.query("insert into public.profiles(id,name) values($1,'Renamed') on conflict(id) do update set id=excluded.id,name=excluded.name", [A]);
    assert.equal(await scalar('select count(*)::integer from public.profiles'), 1);
    assert.equal(await scalar('select name from public.profiles'), 'Renamed');
  }));
  await check('profile identity cannot be moved to another account', () => role('authenticated', A, () => denied(() => db.query('update public.profiles set id=$1 where id=$2', [B, A]))));
  await check('anonymous business data is denied', () => role('anon', null, () => denied(() => db.query('select * from public.recordings'))));

  await check('private input upload works before the metadata row exists', () => role('authenticated', A, () => db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['recordings', `${A}/${RA}/input.xlsx`])));
  await check('cross-user upload path is denied', () => role('authenticated', A, () => denied(() => db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['recordings', `${B}/${RB}/input.xlsx`]))));
  await check('unexpected input filename is denied', () => role('authenticated', A, () => denied(() => db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['recordings', `${A}/${RA}/wrong.xlsx`]))));
  await check('owners cannot upload forged analysis artifacts', () => role('authenticated', A, () => denied(() => db.query('insert into storage.objects(bucket_id,name) values($1,$2)', ['analysis-artifacts', `${A}/${RA}/${RESULT}/forged.json`]))));
  for (const [user, id] of [[A, RA], [B, RB]]) {
    await role('authenticated', user, () => db.query('insert into public.recordings(id,title,recorded_at,file_path,file_name,file_size,input_sha256) values($1,$2,now(),$3,$4,100,$5)', [id, 'Synthetic recording', `${user}/${id}/input.xlsx`, 'synthetic.xlsx', INPUT]));
  }
  await check('record owner filter is enforced by RLS', () => role('authenticated', A, async () => {
    assert.deepEqual((await rows('select id from public.recordings')).map(row => row.id), [RA]);
    assert.deepEqual(await rows("update public.recordings set title='forged' where id=$1 returning id", [RB]), []);
  }));
  await check('file identity and ownership columns are immutable to the browser', () => role('authenticated', A, async () => {
    await denied(() => db.query('update public.recordings set input_sha256=$1 where id=$2', [NEW_RESULT, RA]));
    await denied(() => db.query('update public.recordings set user_id=$1 where id=$2', [B, RA]));
  }));
  await check('cross-user recording association is denied', () => role('authenticated', A, async () => {
    await denied(() => db.query("insert into public.diary(date,recordings) values(current_date,array[$1::uuid])", [RB]));
    await denied(() => db.query("insert into public.monitoring(title,scheduled_at,recording_id) values('Bad link',now(),$1)", [RB]));
  }));
  await check('own recording associations and optional null ratings save', () => role('authenticated', A, async () => {
    await db.query("insert into public.diary(date,recordings) values(current_date,array[$1::uuid])", [RA]);
    await db.query("insert into public.visits(title,recordings) values('Synthetic visit',array[$1::uuid])", [RA]);
    await db.query("insert into public.monitoring(title,scheduled_at,recording_id) values('Synthetic plan',now(),$1)", [RA]);
  }));
  await check('private files are invisible to other accounts', () => role('authenticated', B, async () => {
    assert.equal(await scalar('select count(*)::integer from storage.objects'), 0);
    assert.deepEqual(await rows('delete from storage.objects where name=$1 returning id', [`${A}/${RA}/input.xlsx`]), []);
  }));
  await check('both buckets are private', async () => {
    const buckets = await rows('select id,public from storage.buckets order by id');
    assert.equal(buckets.length, 2); assert.ok(buckets.every(item => item.public === false));
  });
  await check('browser cannot forge results or queue state', () => role('authenticated', A, async () => {
    await denied(() => db.query('insert into public.analysis_results(recording_id,user_id) values($1,$2)', [RA, A]));
    await denied(() => db.query("insert into public.analysis_jobs(user_id,recording_id,operation,request_key) values($1,$2,'analyse','forged')", [A, RA]));
    await denied(() => db.query("update public.analysis_jobs set status='completed'"));
  }));
  await check('authenticated and anonymous users cannot claim or finish jobs', async () => {
    for (const name of ['authenticated', 'anon']) {
      await role(name, name === 'authenticated' ? A : null, async () => {
        await denied(() => db.query("select * from public.claim_analysis_job('intruder')"));
        await denied(() => db.query('select public.finish_analysis_job($1,$2,$3::jsonb)', [RA, RB, '{}']));
        await denied(() => db.query("select public.recover_worker_jobs('intruder')"));
        await denied(() => db.query('select * from public.fence_worker_job($1,$2)', [RA,'intruder']));
      });
    }
  });
  await check('cross-account task request is denied', () => denied(() => enqueue(A, RB, 'analyse', {}, 'cross-owner')));
  await check('AI consent is required for combined analysis and report', () => denied(() => enqueue(A, RA, 'analyse', { generate_report: true }, 'no-consent')));
  await check('client cannot inject trusted source bindings', () => denied(() => enqueue(A, RA, 'analyse', { _input_sha256: INPUT }, 'forged-binding')));
  const first = await enqueue(A, RA, 'analyse', { language: 'en' }, 'analysis-1');
  await check('enqueue stamps hashes and hides lease identity', async () => {
    assert.equal(first.payload._input_sha256, INPUT);
    assert.equal(first.payload._file_path, `${A}/${RA}/input.xlsx`);
    assert.equal(first.status, 'queued');
    assert.ok(!('lease_token' in first)); assert.ok(!('worker_id' in first));
  });
  await check('idempotency key returns the same job and rejects different content', async () => {
    assert.equal((await enqueue(A, RA, 'analyse', { language: 'en' }, 'analysis-1')).id, first.id);
    await denied(() => enqueue(A, RA, 'analyse', { language: 'zh' }, 'analysis-1'));
  });
  await check('owners cannot read private lease columns', () => role('authenticated', A, () => denied(() => db.query('select lease_token,worker_id from public.analysis_jobs'))));
  const claimed = (await claim())[0];
  await check('claim moves one queued job to running and never claims it twice', async () => {
    assert.equal(claimed.id, first.id); assert.equal(claimed.status, 'running');
    assert.match(claimed.lease_token, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await claim('another-worker'), []);
  });
  await check('wrong lease cannot complete or publish a result', async () => {
    assert.equal(await finish({ ...claimed, lease_token: RB }, {}, projection(RESULT)), false);
    assert.equal(await scalar('select count(*)::integer from public.analysis_results'), 0);
  });
  await check('finish atomically publishes bound analysis and completes the job once', async () => {
    assert.equal(await finish(claimed, { result_sha256: RESULT }, projection(RESULT)), true);
    assert.equal(await scalar('select result_sha256 from public.analysis_results where recording_id=$1', [RA]), RESULT);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1', [first.id]), 'completed');
    assert.equal(await finish(claimed, {}, projection(NEW_RESULT)), false);
  });
  await check('cross-user results remain hidden', () => role('authenticated', B, async () => {
    assert.equal(await scalar('select count(*)::integer from public.analysis_results'), 0);
    assert.equal(await scalar('select count(*)::integer from public.analysis_jobs'), 0);
  }));
  await check('report and chat require AI consent', async () => {
    await denied(() => enqueue(A, RA, 'report', { result_sha256: RESULT }, 'report-no-consent'));
    await denied(() => enqueue(A, RA, 'chat', { result_sha256: RESULT, question: 'Explain the window.' }, 'chat-no-consent'));
    await denied(() => enqueue(A, RA, 'chat', { result_sha256: RESULT, ai_consent: true, question: 'q'.repeat(2001) }, 'chat-too-long'));
  });
  await check('operations cannot silently substitute a result unseen by the user', async () => {
    for (const operation of ['report','chat','waveform']) {
      const content = { ai_consent: true, question: 'Explain this result.', start: 0, end: 10 };
      await denied(() => enqueue(A, RA, operation, content, `${operation}-missing-view-hash`));
      await denied(() => enqueue(A, RA, operation, { ...content, result_sha256: 'same-label' }, `${operation}-malformed-view-hash`));
      await denied(() => enqueue(A, RA, operation, { ...content, result_sha256: NEW_RESULT }, `${operation}-stale-view-hash`));
    }
  });
  await enqueue(A, RA, 'report', { result_sha256: RESULT, ai_consent: true, language: 'en' }, 'report-1');
  const reportJob = (await claim())[0];
  await check('report cannot replace numerical result version', () => denied(() => finish(reportJob, {}, projection(NEW_RESULT))));
  await check('failed AI request can preserve numerical data', async () => {
    assert.equal(await finish(reportJob, { report_status: 'unavailable' }, projection(RESULT), 'provider_timeout'), true);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1', [reportJob.id]), 'failed');
    assert.equal(await scalar('select result_sha256 from public.analysis_results where recording_id=$1', [RA]), RESULT);
  });
  await enqueue(A, RA, 'chat', { result_sha256: RESULT, ai_consent: true, question: 'Explain the current results.' }, 'chat-stale');
  const chatJob = (await claim())[0];
  await role('service_role', null, () => db.query('update public.analysis_results set result_sha256=$1 where recording_id=$2', [NEW_RESULT, RA]));
  await check('changed saved result rejects stale chat publication', async () => {
    assert.equal(await finish(chatJob, { answer: 'stale' }), false);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1',[chatJob.id]),'running');
    assert.equal(await finish(chatJob,{},null,'result_changed'),true);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1', [chatJob.id]), 'interrupted');
    assert.equal(await scalar('select error_code from public.analysis_jobs where id=$1', [chatJob.id]), 'result_changed');
  });
  await enqueue(A, RA, 'waveform', { result_sha256: NEW_RESULT, start: 0, end: 10 }, 'wave-recovery');
  const interrupted = (await claim())[0];
  await check('worker restart fences stale completion while keeping the deletion gate running', async () => {
    await role('service_role', null, () => denied(() => scalar("select public.recover_worker_jobs('local-worker')")));
    assert.deepEqual(await fence(interrupted,'different-worker'), []);
    const [fenced] = await fence(interrupted);
    assert.equal(fenced.status,'running');
    assert.notEqual(fenced.lease_token,interrupted.lease_token);
    assert.equal(await finish(interrupted,{artifact:'late-old-response'}),false);
    await role('authenticated',A,() => db.query('update public.recordings set trashed_at=now() where id=$1',[RA]));
    await denied(() => beginDeletion(A,RA));
    assert.equal(await scalar('select deletion_started_at from public.recordings where id=$1',[RA]),null);
    // Artifact rollback occurs here in the worker before this explicit error.
    assert.equal(await finish(fenced,{},null,'worker_restarted'),true);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1', [interrupted.id]), 'interrupted');
    await role('authenticated',A,() => db.query('update public.recordings set trashed_at=null where id=$1',[RA]));
    assert.deepEqual(await claim(), []);
  });
  await enqueue(A, RA, 'waveform', { result_sha256: NEW_RESULT, start: 0, end: 10 }, 'wave-completion-before-fence');
  const completedBeforeFence = (await claim())[0];
  await check('completion winning the lock is preserved by subsequent restart fencing', async () => {
    const published={artifact:'published-overview'};
    assert.equal(await finish(completedBeforeFence,published),true);
    const [settled] = await fence(completedBeforeFence);
    assert.equal(settled.status,'completed');
    assert.equal(settled.lease_token,completedBeforeFence.lease_token);
    assert.deepEqual(settled.result,published);
    assert.equal(await finish(settled,{},null,'worker_restarted'),false);
  });
  await check('active recording cannot be permanently deleted', () => role('authenticated', A, async () => {
    assert.deepEqual(await rows('delete from public.recordings where id=$1 returning id', [RA]), []);
    assert.equal(await scalar('select count(*)::integer from public.recordings where id=$1', [RA]), 1);
  }));
  await check('deletion preparation is owner-only and requires the recycle bin', async () => {
    await denied(() => beginDeletion(B,RA));
    await denied(() => beginDeletion(A,RA));
    await role('anon',null,() => denied(() => db.query('select public.begin_recording_deletion($1)',[RA])));
    await role('authenticated',A,() => denied(() => db.query('update public.recordings set deletion_started_at=now() where id=$1',[RA])));
  });
  await enqueue(A,RA,'waveform',{ result_sha256:NEW_RESULT,start:0,end:10 },'wave-running-before-delete');
  const runningBeforeDelete = (await claim())[0];
  await enqueue(A, RA, 'waveform', { result_sha256: NEW_RESULT, start: 0, end: 10 }, 'wave-trashed');
  await role('authenticated', A, () => db.query('update public.recordings set trashed_at=now() where id=$1', [RA]));
  await check('old clients cannot remove files or delete rows before deletion preparation', () => role('authenticated',A,async () => {
    assert.deepEqual(await rows('delete from storage.objects where name=$1 returning id',[`${A}/${RA}/input.xlsx`]),[]);
    assert.equal(await scalar('select count(*)::integer from storage.objects where name=$1',[`${A}/${RA}/input.xlsx`]),1);
    assert.deepEqual(await rows('delete from public.recordings where id=$1 returning id',[RA]),[]);
  }));
  await check('running work blocks deletion and rejected publication remains running until cleanup is acknowledged', async () => {
    await denied(() => beginDeletion(A,RA));
    assert.equal(await scalar('select deletion_started_at from public.recordings where id=$1',[RA]),null);
    assert.equal(await scalar("select status from public.analysis_jobs where request_key='wave-trashed'"),'queued');
    assert.equal(await finish(runningBeforeDelete,{}),false);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1',[runningBeforeDelete.id]),'running');
    await denied(() => beginDeletion(A,RA));
    assert.equal(await finish(runningBeforeDelete,{},null,'record_unavailable'),true);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1',[runningBeforeDelete.id]),'interrupted');
  });
  const deletion = await beginDeletion(A,RA);
  await check('deletion preparation cancels queued work and is idempotent across cleanup retries', async () => {
    assert.equal(deletion.id,RA); assert.equal(deletion.file_path,`${A}/${RA}/input.xlsx`);
    assert.ok(deletion.deletion_started_at);
    assert.equal((await beginDeletion(A,RA)).deletion_started_at,deletion.deletion_started_at);
    assert.equal(await scalar("select error_code from public.analysis_jobs where request_key='wave-trashed'"),'deletion_requested');
  });
  await check('deleting recording cannot be restored, edited, newly queued or reclaimed', async () => {
    await role('authenticated',A,async () => {
      await denied(() => db.query('update public.recordings set trashed_at=null where id=$1',[RA]));
      await denied(() => db.query("update public.recordings set title='Cannot edit' where id=$1",[RA]));
    });
    await denied(() => enqueue(A, RA, 'analyse', {}, 'analyse-trashed'));
    assert.deepEqual(await claim(), []);
    assert.equal(await scalar("select status from public.analysis_jobs where request_key='wave-trashed'"), 'interrupted');
  });
  await check('permanent deletion cleans associated UUID arrays, scalar link and cloud results', () => role('authenticated', A, async () => {
    await db.query('delete from storage.objects where name=$1', [`${A}/${RA}/input.xlsx`]);
    assert.deepEqual((await rows('delete from public.recordings where id=$1 returning id', [RA])).map(row => row.id), [RA]);
    assert.deepEqual(await scalar('select recordings from public.diary'), []);
    assert.deepEqual(await scalar('select recordings from public.visits'), []);
    assert.equal(await scalar('select recording_id from public.monitoring'), null);
    assert.equal(await scalar('select count(*)::integer from public.analysis_results'), 0);
    assert.equal(await scalar('select count(*)::integer from public.analysis_jobs'), 0);
  }));
  await check('heartbeat is read-only for signed-in users', async () => {
    await role('service_role', null, () => db.query("insert into public.worker_heartbeat(id,status) values('main','online')"));
    await role('authenticated', A, async () => {
      assert.equal(await scalar('select status from public.worker_heartbeat'), 'online');
      await denied(() => db.query("update public.worker_heartbeat set status='offline'"));
    });
  });
  await check('assistant capability requires a matching new-worker heartbeat, and a legacy update invalidates it', async () => {
    await role('service_role', null, () => db.query("update public.worker_heartbeat set assistant_protocol=1,assistant_seen_at='2026-10-31T10:00:00Z',last_seen='2026-10-31T10:00:00Z' where id='main'"));
    await role('authenticated', A, async () => {
      assert.equal(await scalar('select assistant_protocol=1 and assistant_seen_at=last_seen from public.worker_heartbeat'),true);
      await denied(() => db.query('update public.worker_heartbeat set assistant_protocol=1,assistant_seen_at=now()'));
    });
    await role('service_role', null, () => db.query("update public.worker_heartbeat set last_seen='2026-10-31T10:00:05Z',status='online' where id='main'"));
    assert.equal(await scalar('select assistant_protocol=1 and assistant_seen_at=last_seen from public.worker_heartbeat'),false);
    await role('service_role', null, () => denied(() => db.query('update public.worker_heartbeat set assistant_protocol=2')));
  });
  await enqueue(B, RB, 'analyse', {}, 'changed-input');
  const changedInput = (await claim())[0];
  await role('service_role', null, () => db.query('update public.recordings set input_sha256=$1 where id=$2', [NEW_RESULT, RB]));
  await check('source checksum changed after claim prevents result publication', async () => {
    assert.equal(await finish(changedInput, {}, projection(RESULT)), false);
    assert.equal(await scalar('select status from public.analysis_jobs where id=$1',[changedInput.id]),'running');
    assert.equal(await finish(changedInput,{},null,'source_changed'),true);
    assert.equal(await scalar('select error_code from public.analysis_jobs where id=$1', [changedInput.id]), 'recording_changed');
    assert.equal(await scalar('select count(*)::integer from public.analysis_results where recording_id=$1', [RB]), 0);
  });
  console.log(JSON.stringify({ status: 'passed', engine: 'PGlite PostgreSQL (ephemeral)', passed: checks.length, checks, limits: ['Supabase Auth and Storage are minimal stubs; cloud API verification is still required.', 'Single connection; concurrent SKIP LOCKED race testing requires real Postgres connections.'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', passed: checks.length, checks, code: error.code, message: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await db.close();
}
