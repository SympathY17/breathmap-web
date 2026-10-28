create index jobs_recording_owner_fk_idx on public.analysis_jobs(recording_id,user_id);
create index results_recording_owner_fk_idx on public.analysis_results(recording_id,user_id);
create index results_user_fk_idx on public.analysis_results(user_id);
create index monitoring_recording_owner_fk_idx on public.monitoring(recording_id,user_id);
