-- Read-only post-deployment structural checks. These do not substitute for
-- two-user API tests: run those with real user JWTs and synthetic files.
select tablename,rowsecurity from pg_tables where schemaname='public'
  and tablename in ('profiles','recordings','diary','monitoring','routines','visits','reactions','analysis_jobs','analysis_results','worker_heartbeat') order by tablename;
select tablename,policyname,cmd,roles,qual,with_check from pg_policies
  where schemaname='public' order by tablename,policyname;
select grantee,table_name,privilege_type from information_schema.role_table_grants
  where table_schema='public' and grantee in ('anon','authenticated') order by table_name,grantee,privilege_type;
select grantee,table_name,column_name,privilege_type from information_schema.role_column_grants
  where table_schema='public' and grantee='authenticated' and table_name in ('recordings','analysis_jobs','analysis_results') order by table_name,column_name,privilege_type;
select n.nspname,p.proname,p.prosecdef,p.proacl,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and p.proname in ('request_analysis_job','claim_analysis_job','finish_analysis_job','recover_worker_jobs') order by n.nspname,p.proname;
select id,public,file_size_limit,allowed_mime_types from storage.buckets where id in ('recordings','analysis-artifacts');
select policyname,cmd,roles,qual,with_check from pg_policies where schemaname='storage' and tablename='objects'
  and policyname in ('recording_file_insert','owned_file_read','owned_file_delete') order by policyname;
