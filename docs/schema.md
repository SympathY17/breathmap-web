# BreathMap database contract

This schema is for the new Supabase project. It does not read or modify the Softr database or the existing local analysis ledger. `supabase/schema.sql` is the reviewable source; the root implementation will use the Supabase CLI to create the migration filename before deployment.

## Existing business fields

All business rows use UUID keys. `profiles.id` is the Supabase Auth user ID; it has no separate `user_id` column. Other tables have `user_id`, set from Auth and protected by RLS. Email is read from Auth and projected into the compatibility adapter; it is not a user-editable authorization field in `profiles`.

| Table | Logical fields exposed through the legacy adapter |
| --- | --- |
| `profiles` | `name`, `relax_preferences` JSON object |
| `recordings` | `title`, `details`, `notes`, `recorded_at`, server `uploaded_at`, `trashed_at`, read-only `deletion_started_at`, immutable file metadata |
| `diary` | `title`, `date`, `bed_at`, `wake_at`, `awakening_count`, `sleep_quality`, `day_sleepiness`, `caffeine_note`, `notes`, `recordings` UUID array |
| `monitoring` | `title`, `scheduled_at`, `status`, `notes`, nullable scalar `recording_id` |
| `routines` | `title`, `bed_time`, `wake_time`, `target_minutes`, `wind_down_minutes`, `days` JSON array, `commitments` JSON array, `active` |
| `visits` | `title`, `appointment_at`, `concerns`, `questions`, `notes`, `after_notes`, `status`, `recordings` UUID array, `diary_from`, `diary_to` |
| `reactions` | `title`, `completed_at`, nullable `median_ms`/`mean_ms`, `misses`, `false_starts`, `valid_trials`, `trial_count`, nullable `sleepiness`, `trials_json` JSON array, `test_version`, `device_class`, `notes` |

The adapter converts camelCase to snake_case and converts the old single-item `monitoring.recording` array into `recording_id`. It parses JSON strings for reaction trials and relaxation preferences on write and serializes where the old UI expects strings. Time-of-day values use PostgreSQL `time`; date-only fields use `date`; actual events use `timestamptz`. Multiple diary entries for one date are intentionally allowed. Missing numerical values remain null, not zero.

UUID arrays preserve the existing UI without new join-table calls. Insert/update triggers verify that every linked recording belongs to the same user. A recording-delete trigger removes its IDs from diary/visit arrays and clears monitoring links. This also works for linked recordings in the recycle bin.

## File creation and deletion

1. Generate `recordings.id` in the browser before uploading.
2. Calculate SHA-256 over the actual XLSX bytes.
3. Upload with `upsert:false` to the private `recordings` bucket at `{user_id}/{recording_id}/input.xlsx`. Upload policy allows this exact own-user path before the metadata row exists.
4. Create the metadata row with the same ID and `file_path`, original `file_name`, byte `file_size`, and `input_sha256`. Failed metadata writes retain the uploaded attachment for retry or explicitly remove the orphan; they must not silently create a new path on every retry.
5. Client updates are limited to title, notes, details, recorded date and recycle-bin date. Input file metadata/checksum cannot be changed through the browser.
6. Before permanent deletion, the row must already be in the recycle bin. Call the owner-checked `begin_recording_deletion` RPC. It locks the row and related jobs, rejects running work, cancels queued work and sets a server-controlled deletion marker. A busy task lock returns a retryable refusal before Storage cleanup. Once marked, restore/edit/new requests are forbidden. Remove its private input and analysis objects, then freshly list both origin prefixes and confirm they are empty before deleting the row. A failed or uncertain cleanup keeps the marked row for retry. Database deletion cascades cloud jobs/results; provider backups and previously processed local copies have separate retention.

The second bucket is private `analysis-artifacts`; only the worker uploads outputs. Owners can read/download their own paths; deletion requires the matching frozen, trashed record and no active job. Use signed URLs with short expiry or authenticated downloads; do not store expiring URLs as permanent metadata. No public file bucket is created.

## Analysis commands and results

`analysis_jobs` fields: `id`, `user_id`, `recording_id`, `operation`, `payload`, `request_key`, `status`, `lease_token`, `worker_id`, `result_sha256`, `result`, `error_code`, `created_at`, `started_at`, `finished_at`.

- Operations: `analyse`, `report`, `chat`, `waveform`.
- Statuses: `queued`, `running`, `completed`, `failed`, `interrupted`.
- `request_key` is unique per user and must be reused for network retries of the same action. A reused key with different content is rejected.
- The browser cannot insert/update/delete job rows directly and cannot read worker/lease identifiers. Select explicit permitted columns, not `*`.
- `request_analysis_job(p_recording_id,p_operation,p_payload,p_request_key)` returns a JSON job object with worker/lease fields removed.
- Payload is a JSON object, maximum 32 KiB. `language`, when supplied, is `en` or `zh`. `report` and `chat` require the JSON boolean `ai_consent:true`; so does `analyse` with `generate_report:true`. `generate_report`, when supplied, must be a JSON boolean. Chat requires a trimmed question of 1–2000 characters, matching the existing local service.
- The checked RPC binds the request to the authenticated owner and an active recording, and stamps `_input_sha256`, `_file_path`, `_result_sha256` from stored server data. No processing request is permitted until the input checksum exists. Non-analysis operations require saved numerical results and a client `result_sha256` containing the exact complete hash currently displayed to that user. Missing, malformed or stale hashes are rejected before creating work, so consent for an old view cannot silently authorize AI processing of a newer result.
- Upload alone creates no processing request. Diaries, visit notes, reaction checks and routine preferences are not automatically included in analysis or AI requests.

`analysis_results` has one row per recording: `recording_id`, `user_id`, `summary`, `display`, `windows`, `wave_manifest`, `result_sha256`, `updated_at`. The worker alone writes it. The standalone summary uses `breathmap-web-summary-1` with `metrics`, `analysis`, `report`, `versions`, `extent`, `window_counts`, `source_result_sha256`, and `presentation`. `display` holds the complete display document, `windows` the complete typed collections, and `wave_manifest` private artifact metadata. The new analysis panel reads these documents directly. Any old-page `analysisSummary` compatibility projection must deliberately translate this contract into its expected old schema; simply relabeling the web summary is invalid. The derived status and summary are not client-writable recording columns.

Numerical and AI-report statuses remain separate. Old Softr summaries containing five-row previews must not be treated as complete windows; the new panel uses the complete `windows` collections instead. Synthetic input and simulated AI flags remain distinct. SHA-256 binds displayed windows, reports and waveform artifacts to the saved result version.

## Current-computer worker

The worker makes outbound Supabase requests with its protected server credential. It does not expose the local Python API to the internet.

1. After acquiring its local exclusive lock, enumerate its running jobs and pending local journals. Call `fence_worker_job(p_job_id,p_worker_id)` for each before cleanup. The database job lock preserves a completed outcome or rotates the running lease while keeping the deletion gate closed. Reconcile committed outputs; otherwise remove only exact unpublished job-owned objects before explicitly finishing the fenced job as interrupted. An unresolved upload remains running for verified readback or operator review. This never requeues or repeats paid requests.
2. `claim_analysis_job(p_worker_id)` atomically claims at most one queued row with `FOR UPDATE SKIP LOCKED`, assigns a UUID `lease_token`, and returns a set containing zero or one job. Unavailable/changed source recordings are marked interrupted.
3. Check ownership, untrashed status and input hash before downloading/processing. Use `E:\breathmap` as the existing runtime sandbox.
4. Write `worker_heartbeat` with `{id:'main',last_seen,status:'online'|'busy'|'offline'}` periodically. It contains no hostnames, credentials or local paths. Signed-in users may read it; a stale timestamp means the worker's availability is unknown/offline, not that its task should automatically rerun.
5. Upload private waveform artifacts under `{user_id}/{recording_id}/{result_sha256}/...`.
6. Call `finish_analysis_job(p_job_id,p_lease_token,p_result,p_analysis_result,p_error_code)`. It checks current source and result bindings and atomically upserts a supplied complete analysis projection and finishes the job. `p_analysis_result` is null for chat/waveform, otherwise an object with `summary`, `display`, `windows`, `wave_manifest`, `result_sha256`. A report cannot replace the numerical result hash. A non-null safe `p_error_code` marks the job failed while still allowing an already calculated numeric projection to be saved.
7. A changed/deleted/trashed source or changed result rejects stale publication. A deleted row also cascades its pending job and result rows. Interrupted jobs require an explicit new request; lease expiry never automatically authorizes duplicate analysis or AI.

`claim_analysis_job`, `finish_analysis_job` and `fence_worker_job` are executable only by `service_role`; their SQL uses invoker security. Execution of the obsolete broad `recover_worker_jobs` function is revoked. The authenticated public enqueue and deletion wrappers use invoker security and call tightly checked definer functions in the non-exposed `private` schema. Every function has a fixed empty search path and explicit execute grants.

## Verification

`node scripts/verify-schema.mjs` executes the exact schema in an in-memory PGlite PostgreSQL engine with disposable Auth/Storage stubs and two UUID users. It checks schema execution, row/column permissions, private Storage policies, checked enqueue, claim/finish lease and hash binding, interrupted recovery, and linked-record deletion. It uses no real credentials or cloud data. PGlite has one connection, so these tests do not establish concurrent multi-worker locking or the behavior of hosted Auth/Storage APIs.

Run `supabase/verify.sql` and Supabase advisors after applying the migration. Then test two real user sessions with synthetic files: cross-owner selects/updates/links/storage/tasks must fail; an owner cannot change `user_id`, input metadata, job state or result documents. Verify immutable upload paths, duplicate-request keys, two simultaneous worker claims, stale lease rejection, interrupted recovery, trash-before-delete and cleanup failure retention. Confirm all window collections remain complete and null metrics remain null. Structural inspection alone is not successful runtime validation.
