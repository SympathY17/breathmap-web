# BreathMap local analysis worker

This worker connects the new Supabase website to the existing analysis installation. It makes outbound HTTPS requests only; no inbound port, public tunnel or Softr token is used. The original model, numerical implementation and old Softr bridge ledger are unchanged.

The website remains available when this computer is off. New analysis, report, chat and detailed waveform requests wait until the worker is running. Previously saved metrics, all analysis windows, reports and the overview waveform remain readable from the user's private cloud data.

## Requirements

- Existing project: `E:\Codex Data\学校课程\BreathMap_local_20261027` (override with `--backend-project`).
- Existing Python environment: `E:\Codex Data\学校课程\BreathMap_local_20261027\.venv\Scripts\python.exe`.
- Runtime sandbox is read from the existing project's `runtime-config.json`; currently `E:\breathmap`.
- Apply the new project's database schema and create the private `recordings` and `analysis-artifacts` buckets first.
- Process environment variables `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (preferred modern `sb_secret_...` key). `SUPABASE_SERVICE_ROLE_KEY` remains a fallback for an existing legacy service-role JWT. Server credentials must never appear in frontend `VITE_` variables, GitHub files, Netlify public build output, screenshots or command arguments.
- AI actions reuse the existing Windows-user-protected DeepSeek credential. Numeric analysis does not load it.

Run from a terminal in this folder with credentials supplied by the protected launcher or current process environment:

```powershell
& 'E:\Codex Data\学校课程\BreathMap_local_20261027\.venv\Scripts\python.exe' -B -X utf8 .\breathmap_worker.py
```

The supplied Windows launchers avoid saving a plaintext key in the project. First run `Configure-Worker.ps1 -ProjectUrl <your exact Supabase HTTPS project URL>` and enter the server secret in its hidden prompt. It saves a current-Windows-user encrypted credential under `E:\breathmap\config\supabase-web`. Then run `Run-Worker.ps1` (or `Run-Worker.ps1 -Once` for a single-job check). These scripts must run under the Windows account that saved the credential. Never paste the key into chat or include it in the `-ProjectUrl` argument.

`--once` claims at most one queued job, which is useful for controlled acceptance checks. The normal poll interval is five seconds; `--poll-seconds` accepts 2–300 seconds. Stop with Ctrl+C when no job is running. Numerical subprocesses share the Windows console, so Ctrl+C during analysis can interrupt the child as well; it is not a promise to finish the active operation. Restart the worker before explicitly retrying an interrupted task. Keep the terminal running while the website should accept new analysis work. This script does not install an automatic Windows service or startup task.

Modern secret keys are sent only on the `apikey` header. Legacy service-role JWTs use `apikey` and `Authorization: Bearer`; publishable keys and legacy anon keys are rejected for the worker. Supabase performs actual credential verification; local legacy-claim decoding only diagnoses the wrong key type. See the [official API key guide](https://supabase.com/docs/guides/getting-started/api-keys).

After constructing its transport, the worker removes both key variables from its own environment so the numeric subprocess cannot inherit either the modern or legacy server credential. The launcher restores its parent terminal environment when the worker exits.

## Durable state and recovery

The new ledger is `E:\breathmap\state\supabase-web\worker.sqlite`; the process lock is beside it. The original `state\bridge.sqlite` is never opened. Inputs, numerical output and reports stay in the existing sandbox's UUID record folders. A cloud recording is durably bound to its owner UUID, file checksum and local UUID.

An OS lock prevents two instances on this host. Before restart cleanup, a server-side row lock either confirms a previously committed completion or rotates the abandoned running job's lease. The running state blocks permanent deletion until exact unpublished artifacts have been removed and the fenced job is explicitly finished as interrupted. An uncertain publication is reconciled before any later job is claimed; published artifacts are retained.

There is no timeout-based automatic requeue or automatic repetition of paid AI calls. An explicit new analysis request reuses a successful saved numerical result. If a previous analysis is unusable, failed or interrupted without complete output, an explicit new analysis job gets its own local attempt and preserves the old artifacts. The current binding changes only after the new cloud result commits. Waveform, report and question requests never rerun numerical analysis.

A transient network error can leave a cloud task marked running until the worker is restarted. Restart marks it interrupted, after which the user can explicitly request the action again. Automatic retrying of paid calls is deliberately avoided because the provider may have processed a request even when its response was lost.

An ambiguous Storage upload is treated more strictly: the worker stops claiming work and keeps that job running. Restart can proceed only if a complete read of the exact unique object matches the journalled content hash. A missing or mismatching object produces `artifact_upload_outcome_unresolved` or `artifact_upload_content_unverified` and requires operator review; absence is not evidence that a timed-out upload was cancelled. Do not manually clear the task or delete the journal to bypass this gate.

## Data contracts

The database contract is in `..\docs\schema.md`. The worker calls:

- `claim_analysis_job(p_worker_id)`
- `fence_worker_job(p_job_id,p_worker_id)` after acquiring its exclusive lock, before restart reconciliation or cleanup
- `finish_analysis_job(p_job_id,p_lease_token,p_result,p_analysis_result,p_error_code)`

Only the service role can call these. Signed-in browser users submit checked requests through the separate `request_analysis_job` RPC.

The worker rechecks the current owner, untrashed record, exact input path, checksum and job lease before download, before artifact upload and before publication. The database checks the same binding atomically when finishing. The fixed input path is `{user_id}/{recording_id}/input.xlsx`. No signed download URL is stored as an identity or permanent file reference.

`analysis_results` contains:

- `display`: the original `breathmap-display-1` document plus `presentation`.
- `summary`: `breathmap-web-summary-1` with `metrics`, `analysis`, `report`, `versions`, `extent`, `window_counts`, `source_result_sha256` and `presentation`.
- `windows`: complete `model`, `statistics` and `attention` collections; unavailable collections have `total:null`, never a fabricated count.
- `wave_manifest`: schema `breathmap-wave-manifest-1`, immutable source result hash, `range`, optional private `overview` bucket/path and `on_demand:true`.
- `result_sha256`: fingerprint of the original saved numerical result.

The overview contains at most 5,000 actual source rows with the original gap/validity flags. Detailed waveform jobs use payload `{start,end,max_points,result_sha256}` and return `{waveform,result_sha256}`. There is no interpolation or re-analysis when zooming. Full-resolution statistical calculations always come from saved analysis results, not sampled chart rows. Precomputing every short range was avoided because the existing reader performs sequential scans.

`display.report.source` is the string `live`, `simulated` or `unknown`; `provider_model`, `source_report_sha256` and `simulated` accompany it. These fields are derived by the existing `read_saved_report_source` validator from bound saved report bytes. Changing the configured AI client's name does not relabel an unknown or simulated saved report as live.

Report jobs return `{report_status,result_sha256}`. Chat jobs return `{answer,result_sha256}`; `answer.claims` contains verified plain text, evidence IDs and exact value bindings. Render prose as text and the bound values separately. Report/chat, and analysis with `generate_report:true`, require `ai_consent:true` on that request. Analysis alone does not transmit the uploaded workbook, filename, personal notes or raw waveform to the language-model provider.

Numerical success and AI explanation status remain independent. If the AI request fails, completed numerical results are still published; a later explicit report request can retry explanation without rerunning the model. An unavailable waveform overview also does not discard valid metrics or windows.

## Verification

```powershell
& 'E:\Codex Data\学校课程\BreathMap_local_20261027\.venv\Scripts\python.exe' -B -X utf8 -m unittest -v test_worker
```

These tests use fake cloud/backend objects and isolated workspace SQLite files. They verify owner separation, file hashes and paths, cancellation, result binding, duplicate/crash handling, retained numerical results after AI failure, complete windows, waveform gap preservation and the process lock. They do not claim live Supabase, real-model, AI-provider or browser acceptance; those checks must be run against the configured development project with synthetic data.

The additional real-engine offline check runs only the supplied 60-second synthetic fixture, with cloud calls replaced by an in-memory tape and AI disabled:

```powershell
& 'E:\Codex Data\学校课程\BreathMap_local_20261027\.venv\Scripts\python.exe' -B -X utf8 .\verify_existing_backend.py --run-synthetic
```

Verified on 28 October 2026: 11 complete model windows, 2 statistics windows, 1 attention window and 741 truthful overview points were exported. The real `partial` execution status was preserved. Temporary runtime data stayed inside an isolated workspace directory and was removed afterward. This check made no cloud or AI requests; live project acceptance is separate.

`export_visual_fixture.py` is a separate read-only check helper. It reads only the explicitly identified cached synthetic QA recording, verifies the known input hash and QA markers, and writes `.tmp/visual-fixture.json` for the temporary visual harness. It makes no model, AI or cloud call and verifies that the cached source files are unchanged. The fixture intentionally omits the old simulated explanation so the ungenerated-report state can be checked. It is not used by the production application.

## Disposable cloud acceptance

`cloud_smoke.py` is the reproducible test source. It uses the same protected credential-loading code as the normal worker; the thin `Run-Cloud-Smoke.ps1` wrapper delegates to `Run-Worker.ps1`. Credentials and generated test passwords remain in memory. It is restricted to the selected development project `hboyzyzzlzkgzubpsieo`.

```powershell
# Creates two temporary, auto-confirmed synthetic test users. No AI request.
.\Run-Cloud-Smoke.ps1 -Execute

# Additionally runs exactly one consented report and one question on synthetic input.
# This uses the existing DeepSeek account and incurs its normal API usage.
.\Run-Cloud-Smoke.ps1 -Execute -WithAI
```

The test uploads only the known synthetic workbook. It verifies the seven business domains, persistent owner changes, foreign-user denials, private file access, immutable input metadata, queue consent/idempotency, numerical output, complete windows, overview and interval waveforms, result hashes, and recycle-bin/permanent-deletion boundaries. Profile deletion remains an account boundary; the test does not add generic UI deletion features. It refuses to run the worker while an unrelated queued/running job exists. Only this run's tracked cloud paths, rows and users are cleaned up. Newly generated local synthetic analysis artifacts remain in `E:\breathmap` for audit.

Verified on 28 October 2026: the full seven-domain/live-AI run passed 127 checks. DeepSeek's official API processed four successful completions using `deepseek-flash`: one report evidence request, its explanation, one question evidence request and its answer. The only tool was `get_record_evidence`; numerical artifact hashes did not change. Report provenance and exact report/question citation bindings passed validation. No real user account, password or participant data was involved. Two test users and their cloud resources were removed; a separate read-only SQL check confirmed zero remaining rows/objects across Auth, all seven business tables, jobs, results and Storage.

Sanitized reports are written to `.tmp/cloud-smoke-<run-id>.json`, outside production assets. The full run's report is `cloud-smoke-fbf48f74-5785-4b5b-897c-13676ee299d8.json`. The earlier numeric-only cloud run passed 53 checks before the seven-domain extension. Provider-failure preservation is covered by deterministic unit fault injection, without spending extra API calls to simulate an outage. API acceptance does not establish browser signup, SMTP delivery, password-reset email links or mobile-browser acceptance; those are separate checks.

## Tracked synthetic browser session

`prepare_browser_qa.py` can seed one fresh confirmed test user with the known synthetic workbook, a previously verified saved result/report and a private overview. It does not rerun the model or call AI. A local alias maps the new test record to those same immutable synthetic outputs for interval waveform checks. It never changes a real user's password or email-confirmation settings.

Run `Run-Worker.ps1 -BrowserQA prepare` to create the tracked test resources. The nonsecret cleanup state is `.tmp/browser-qa-state.json`. After the browser checks, run `Run-Worker.ps1 -BrowserQA cleanup`; it verifies the test-user marker, deletes only that user's private object prefixes and Auth account, and removes the new local alias while preserving the source analysis files.

Cleanup includes every recording and business row created under that temporary QA user during browser testing, not just the initially seeded record. It refuses to start while that user's jobs are queued/running, recursively removes both private Storage prefixes, deletes the marked temporary Auth account with its row cascades, verifies all nine owned cloud table scopes/Auth/Storage are empty, then removes all local binding aliases and tracked job entries for that QA user. Shared or newly generated local synthetic numerical files remain as audit evidence; other users' bindings and jobs are untouched.

If the user retains a fixture for manual acceptance, set `manual_retention_requested` in its tracked state. Cleanup refuses before any mutation while that marker is present; it has no bypass flag. Clear it only after the user authorizes the later cleanup. Local cleanup enables SQLite foreign keys and includes exact-owner attempts and artifact journals for records already deleted through the website. It rejects foreign-owner links, verifies the scoped rows are gone and preserves scientific artifact folders.

Use `Run-Worker.ps1 -BrowserQA set-password` in a TTY to set a new disposable QA fixture password that the controller already knows, supplied through the hidden `getpass` prompt. Use that same new value for the normal production sign-in form; do not extract protected browser credentials or use the clipboard. The helper verifies the tracked QA-user marker and accepts only 24–128 printable ASCII characters containing upper/lowercase letters, a digit and a symbol. It refuses nonhidden input, modifies only that test account, and outputs only status, email and user ID. No password is accepted through arguments or files, and production Auth settings remain unchanged. The helper has only three actions: `prepare`, `set-password`, and `cleanup`.
