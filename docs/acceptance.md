# Rebuild acceptance record

Date: 2026-10-28 (Asia/Shanghai).

## Verified locally

| Area | Evidence | Scope |
|---|---|---|
| Production compilation | TypeScript + Vite passed | Ten copied pages, new Auth and connected analysis UI compile; no hosted login implied |
| Frontend boundaries and forms | 75 Vitest checks passed | UUID filtering, safe writes, Auth callbacks, private downloads, result replacement, 25-window pagination, retained results during AI failure/offline state, wellbeing form persistence and deletion readback |
| Database execution | 43 PGlite PostgreSQL checks passed | Schema upgrade, RLS, grants, storage policy stubs, queue transitions, stale leases, restart fencing and frozen deletion lifecycle |
| Worker | 70 Python checks passed | Ownership, hashes, explicit numeric retries, publication reconciliation, exact artifact rollback, ambiguous upload handling, consent, scoped cleanup and manual-retention protection |
| Existing model integration | Synthetic 60-second input, isolated transport | Real model: 11 model windows, 2 statistics windows, 1 attention window; no real cloud or AI calls |
| Read-only browser checks | Actual React pages with cached synthetic fixture | Home, recordings, upload, recycle bin, preferences, security, guide, seven wellbeing views, account/login/signup/password reset, report/analysis display |
| Responsive checks | Browser viewport 320/390/768 px | Main pages showed no document horizontal overflow; analysis displayed three waveforms and actual fixture metrics |
| Browser console | No warning/error entries in the checked QA session | Isolated read-only fixture, not hosted acceptance |
| Dependencies | npm audit: 0 reported vulnerabilities | Installed lockfile; not a claim that the entire application has no possible security issues |

The browser fixture is under `.tmp`, visibly labelled read-only synthetic QA, and excluded from the repository and production build. Its database, storage and authentication are substitutes. Buttons that would write or call AI are intentionally rejected there.

## Cloud state

- Netlify project created: `breathmap-sympathy`, ID `8b0b3927-4327-48d2-a34d-948d5e6613ce`.
- Netlify production is ready at `https://breathmap-sympathy.netlify.app`, connected to GitHub `main`. UI release `8710743f5c32349808114dcfb10874f3a6b2e76a` was verified ready in deploy `6ae1843ae720627a733e68bb`. A prior successful build lacked the public frontend settings; this was found in the actual browser and corrected through the project UI.
- The user explicitly authorized opening the website. Only this project's production entry is public; previews remain private. A broad `all-projects` connector mutation was rejected and did not apply; the narrower per-project production setting was then verified in the UI.
- Supabase project `hboyzyzzlzkgzubpsieo` is healthy in Singapore on the user-approved free plan. Three migrations were applied, including the deletion/restart lifecycle fix; all ten public tables have RLS. The security advisor was rerun and reports one Auth warning: leaked-password protection is disabled. Supabase makes that feature available on Pro and above, so the free plan was retained. See [password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No other security lint was returned. Initial performance advice contained unused-index information for the new tables.
- Private GitHub repository `SympathY17/breathmap-web` contains the full source and follow-up fixes. The Codex connector was explicitly authorized for this repository only. Git CLI connectivity subsequently recovered; the local branch now has the existing remote history and can push through the existing authorization.
- The two frontend publishable settings are configured. The worker credential was saved with Windows encryption for this account; an actual cloud empty-queue poll completed successfully (`processed: 0`).
- Existing backend, model, runtime records, Softr website and Obsidian files were not migrated or deleted.
- Supabase Auth Site URL and its exact production `/` and `/reset-password` redirect URLs were saved and read back. Email confirmation was retained; custom SMTP is absent and the user explicitly deferred it.

## Actual cloud API and worker acceptance

The extended run passed 127 checks using two disposable, confirmed synthetic users and the known synthetic XLSX. Seven business domains, persisted edits, cross-owner denials, private files, immutable input metadata, task consent/idempotency, complete model/statistics/attention windows, overview and interval waveforms, recycling and permanent cleanup were exercised against the hosted project. Numeric output contained 11 valid model windows, 2 statistics windows and 1 attention window; the overview had 741 source points.

Exactly one report and one question were requested. DeepSeek's official API completed their four evidence/explanation calls using `deepseek-flash`; report provenance and exact citation/value bindings passed, and numerical artifact hashes remained unchanged. Provider-failure preservation was checked by deterministic unit fault injection, not by creating extra paid failures.

The two users and all their cloud resources were removed. Independent SQL confirmed zero remaining temporary Auth, business, job, result and Storage objects. The sanitized evidence is `.tmp/cloud-smoke-fbf48f74-5785-4b5b-897c-13676ee299d8.json`; reproducible source is `worker/cloud_smoke.py`. Newly generated synthetic local artifacts remain in the runtime sandbox for traceability. This proves API/worker behavior, not delivery of real email or browser completion of every form.

## Hosted browser acceptance

The actual Netlify website and hosted Supabase project were exercised with one separate disposable synthetic account. These checks used the production application, not the read-only fixture:

- Native password sign-in, session restoration over full-page navigation and sign-out passed.
- A synthetic XLSX passed the two-sheet format check, saved its private file and metadata, and remained unanalysed until **Start analysis** was clicked. The real worker then published 60-second results: 15.03 breaths/min, 5.1 L/min and 11/11 valid model windows.
- The saved report, all 11 model windows, both statistics windows, and a report citation's corresponding interval were displayed. A separate 10–20 second waveform request returned 1,000 actual source rows across three signals.
- Recording notes survived refresh. Recording title and collection details were edited through the live form; the original timestamp, notes, input hash and numerical-result hash remained unchanged. A dirty metadata draft survived background polling.
- A linked sleep diary saved its times and ratings, and its rating appeared on the overview. Private original-file download produced a real browser download.
- A separate, consented question on the newly analysed synthetic recording completed through the website and displayed grounded answer text, exact values and clickable evidence references. No diagnosis was requested.
- Moving the analysed recording to the recycle bin and restoring it passed. Rechecked overview, history and recycle-bin badges now retain the real analysis status. Permanent deletion was exercised in API acceptance; its irreversible browser confirmation was not submitted.
- The upload success instructions now describe explicit user-triggered analysis, rather than the old Softr operator-approval workflow.
- The final Auth release (`4c19f37f36687c15323506ad311f94f2d254d82f`, ready deploy `6ae187508ecc81a7fe1125b5`) was checked with an unusable recovery-code URL. It displays the explicit invalid/expired-link notice and a new-link request entry, rather than silently showing a password form.

The browser account was signed out and removed. Cleanup deleted its two cloud recordings, linked diary, four private objects, two local aliases and three local job-ledger entries. Independent SQL confirmed all five temporary users from both API runs and browser acceptance had zero Auth/business/job/result/Storage resources, with no queued or running tasks. See `.tmp/final-cleanup-verification.json`. Local synthetic scientific artifacts were retained; no real user's credentials or participant data were used.

The temporary read-only Vite preview and one-use handoff listeners were stopped. Unused magic-link/HTTP/credential-page test paths were removed; the reusable browser helper keeps only prepare, hidden-input test-password setup and scoped cleanup. The normal outbound worker remains online.

The earlier hosted viewport attempt did not change the measured 1280-pixel viewport. A subsequent run applied the override to the currently visible test tab and verified the actual dimensions. The resulting hosted width checks are recorded below; they still do not replace physical-device acceptance.

## Remaining acceptance, in order

1. Custom SMTP and actual confirmation/password-reset email delivery are deferred by the user. Email confirmation remains enabled.
2. Actual phone/device acceptance remains for the user; do not treat desktop or fixture checks as a real-device result.
3. Native print-preview content and a real window/tab-blur interaction remain manual checks. The print action invoked the native flow, which this browser controller could not inspect; its temporary tab was closed. Component tests cover selected print content and blur cancellation, but are not native-dialog evidence.
4. The user explicitly declined the final irreversible browser deletion and retained that synthetic record for manual acceptance. API deletion passed previously; the browser confirmation was cancelled. Do not delete the retained fixture through a different interface.

No remaining item is marked completed merely because a matching source file exists.

## Follow-up correctness review

Independent review reproduced and fixed two races: an old interval waveform blocking a new result overview, and recovery deleting an overview while a delayed finish request committed. Result-version changes now clear the old waveform task and evidence view. Server-side lease fencing decides committed versus abandoned work before cleanup. Permanent deletion freezes a trashed recording, quiesces its tasks and verifies both origin Storage prefixes are empty before removing the row. A cleanup failure leaves a marked record with a safe retry, rather than allowing restore over missing files.

Fresh component tests use the actual production wellbeing components with substitute persistence hooks: monitoring transitions, exact relaxation/routine/reaction data shapes, template conflicts and dirty edits, selected visit printing, reaction practice versus formal trials, blur cancellation and one-time saves. These are deterministic component checks, not a claim of hosted browser completion.

A second disposable hosted browser session verified five-minute quiet-timer preferences and favourites across refresh, timer start/pause/stop, a weekday routine with a structured class commitment across refresh, and linked visit notes across refresh. Hosted database readback matched the real saved JSON shapes. No model or AI call was needed for this session; it reused the verified synthetic result. The screenshot is `.tmp/hosted-visit-persistence.png`.

The first expanded lifecycle smoke run passed 127 checks and then failed an immediate post-delete download assertion. Edge logs confirmed `cf_cache_status=HIT`; the assertion had reused an already cached URL. The test now requires an exact deletion response, an empty origin Storage listing and a unique cache-bypass download. The failed report is retained as `.tmp/cloud-smoke-49a80484-8d8e-4967-b6cf-a6b1999c5bb4.json`; it is not counted as a successful full run.

The next run verified the actual removal but exposed a second harness error: selecting `*` from jobs includes server-only lease fields. The check now selects only permitted public columns and independently verifies the cascade as the service role. The final run passed **134 cloud checks**, with no AI calls and successful cleanup: `.tmp/cloud-smoke-9e0d1bd2-29e6-4357-9950-823a633d461c.json`. These checks include actual private-file deletion, origin listing, cache-bypassed denial, both lease outcomes and the running deletion gate. They do not claim exhaustive simultaneous connection or network-failure injection.

Storage POST timeouts have a separate operational limit. The worker retains the running task and pending content-hash journal and stops claiming work. Restart proceeds only after reading a complete matching object; missing or mismatching content requires operator review. It does not assume a timed-out upload was cancelled. See `worker/README.md` for stop/restart guidance.

## Additional hosted forms and responsive acceptance

The production release `4c2bebdfdb2a10bdb58dd7eceaee6cc83bca6352` was exercised with a fresh, confirmed synthetic QA account. A second uploaded XLSX was independently analysed by the real worker without AI: the page displayed 15.03 breaths/min, 5.1 L/min and 11/11 valid model windows.

- A past recording plan retained its date, linked record and edits over refresh. Complete, reopen and skip transitions passed, and the skipped status persisted. A future plan's complete action was disabled. Native keyboard input committed date changes correctly; no production date bug was found.
- Two distinct analysed records displayed their real metrics and matching model/configuration notice. The first-record diary action selected the correct UUID and date. A saved diary subsequently appeared in the trend chart/table with 23:00–07:00, 8.0 hours in bed, quality 4/5 and sleepiness 2/5.
- Three practice trials and ten formal trials completed. A test started while viewing 20 October was saved under its actual 28 October completion date. The save acknowledgement prevented saving it again, and today's history retained one result after navigation. Its 1 valid/9 missed outcomes are explicitly labelled automated UI acceptance, not a human reaction measurement. The IAB tab switch did not establish a real blur event, so no hosted blur claim is made.
- Saved visit notes reopened with only the chosen recording and the selected one-day diary range. Printing invoked the native flow, but its preview could not be read by this controller; this remains manual rather than being counted as a passed print preview.
- Sixty actual viewport measurements covered twenty views at 320, 390 and 768 pixels: ten principal pages, the remaining wellbeing views and four public Auth views. Every measured viewport matched its requested width, and document width did not exceed it. This checks document overflow, not every touch interaction or physical phone. Evidence: `.tmp/hosted-responsive-measurements.json`, `.tmp/mobile-analysis-390.png`, `.tmp/mobile-monitoring-390.png` and `.tmp/mobile-trends-390.png`.

The user chose to retain this account, its two synthetic recordings and associated test entries for manual acceptance. One recording remains recoverable in the recycle bin; the permanent-delete dialog was cancelled. `.tmp/browser-qa-state.json` records `manual_retention_requested`, and cleanup refuses to proceed while that marker is present. Earlier cleanup reports still describe their own completed runs; they do not imply this retained account was removed.

## 2026-10-31 responsive interface update

This release adapts the existing application for desktop, tablet and phone browsers.
It adds no native app package, PWA installation, database migration, worker change or AI request.

- Below 48rem, five bottom destinations and a modal More menu replace the full primary navigation. Related tool links retain date/record context and use the existing unsaved-edit and in-flight-save guards. The menu restores focus and closes when resized to the wider layout.
- History uses phone-sized cards; the connected analysis workbench uses labeled two-column window cards on phones and tables from 48rem. Waveform axes use the actual plot width, preserving readable text and the original signal data.
- Login/account forms, upload forms, dialogs and all seven wellbeing modules adapt to available space. Diary links can be selected with checkboxes, without desktop modifier keys. The existing green visual identity is retained.
- `npm test`: **80 passed**. The existing reaction tests explicitly schedule animation frames on the fake clock; unchanged HEAD reproduced the previous host-dependent timing failures, and the original timing assertions remain intact. New tests cover the mobile navigation guards/context and saving/editing multiple diary recording links.
- `npm run build`: passed, including TypeScript. The existing large ExcelJS chunk warning remains; no dependency or lockfile changes were introduced.
- Local browser fixtures covered 20 views, two languages and six widths: 320, 375, 414, 768, 1024 and 1440 CSS pixels. The initial 242 measurements (240 page cases and two menus) found two hidden file-input width anomalies. After correction, the upload follow-up passed all 14 checks. Final compact-analysis checks passed 14, screenshot checks passed 26, and interactive checks passed 30. These are separate batches, not one combined end-to-end test total.
- Interactive checks included menu focus, resize/rotation layout changes, cancelled navigation with an unsaved diary, retained recording context, recycle confirmation cancellation, window pagination/selection and AI consent restrictions. All fixture runs blocked external requests and business mutations. No existing account, retained recording or analysis-host state was changed.

Evidence is retained locally in `.tmp/responsive-qa/final-summary.json` and the corresponding scripts, measurements and PNGs. These use synthetic data and substituted Auth/Storage boundaries; they do not establish hosted authentication, new model performance, real-user testing or physical-device acceptance. Actual phone/tablet touch, keyboards and file pickers still require device checks. Deployment status is recorded separately after publishing.

## 2026-10-31 AI assistant workspace

The AI assistant now has a primary destination, recording-level entry and shared
floating panel. Recording/version/interval context, session drafts, request locks,
consent and response receipts are checked. Saved report reads do not request a new
report. Window/citation selections now request the corresponding waveform directly.

Frontend: **116 passed**, production build passed. Worker: **89 passed**;
temporary PostgreSQL: **44 passed**. Local browser checks comprise a **128-check**
initial matrix and a separate **116-check** follow-up after fixing short-screen
message/composer overlap. No real AI request, original-host startup, participant
upload or real-device test was performed. See
[the release record](ai-assistant-20261031.md) and
[the backend contract](assistant-context.md) for deployment and evidence limits.

## 2026-11-04 analysis-host restoration

The existing analysis installation and 39-file numerical bundle were checked,
the configured Windows account's protected credentials were reused, and the
single local worker was restarted. The cloud heartbeat is fresh with
`assistant_protocol=1` and `assistant_seen_at=last_seen`. No second analysis host,
automatic startup service, model retraining or SMTP change was introduced.

One new retained synthetic account and one known 60-second XLSX recording passed
45 live API/real-engine checks: private upload without implicit analysis,
numerical processing, complete bound window collections, overview, a fresh
10–20-second waveform request, a real AI report, two contextual questions with
verified history receipts/citations, unchanged numerical artifacts after AI, and
fresh-login reads of the saved results and answers. The report plus two questions
used six successful DeepSeek completions. The synthetic fixture's existing
partial-coverage status was preserved, not relabelled as complete data or a model
accuracy result. No real participant data or existing retained resources changed.

The initial script completed all workflow checks but then failed its optional
browser-login handoff. That original report remains intact. The helper was fixed
for the REST response shape and canonical root URL; its implicit magic link did
not match this site's PKCE login flow. A new password was set only for the same
synthetic QA account and delivered once in memory to the controller. Normal
production password login then succeeded. No production Auth configuration was
changed, no test password was stored, and no model/AI request was repeated to
resolve the handoff issue.

The production browser displayed the new recording, numerical metrics, saved
live report and both linked questions. Reading the report did not regenerate it.
Browser testing also found a genuine range-restoration bug: an existing detailed
waveform could show 10–20 seconds while the initial inputs still showed 0–30.
Applying a saved waveform now synchronizes the time inputs to its actual range.
A draft guard prevents polling, a pending reply or a delayed overview from
overwriting a manually edited or citation-selected interval. Three new regression
cases cover those boundaries; all 161 tests across 17 files, TypeScript and the
production build passed. Source/build scanning found no server-secret matches.

Raw, sanitized evidence is retained under `.tmp/analysis-restore-20261104/`,
including `live-57b5bb99-269a-459f-bcb3-daf944cfc5d7.json` and separate handoff
outcomes. This directory is ignored by Git. All new synthetic resources are
retained for manual acceptance; the existing manual-retention decisions stand.

PR #6 merged as `f335d82c7418e3131100378a58a1e9bc9e2d01cb`;
production deploy `6aeadbfaf86786a5bfbb6b20` became ready at
2026-11-04 15:17:45 CST. All 17 deployed JS/CSS files matched the tested build
and contained no server secret. Production browser reload now restored the saved
50–60-second waveform and inputs together. Editing to 12–22 seconds survived a
refresh; Load interval returned that actual waveform, and Ask about this interval
passed the same range to a third real contextual question. The answer completed
with both previous job IDs in its server receipt. Saved notes and the 12–22-second
range remained after reload. The retained recording now has one completed numeric
job, three waveform jobs, one report and three questions, with no failed/pending
jobs. The complete run used eight successful provider completions; browsing saved
explanations did not generate additional requests.

Browser observations and screenshot: `browser-results.json` and
`production-restored-record.png` in the same ignored evidence directory. The
worker remains running on the original configured computer at the user's request.
Startup is still manual after shutdown/restart; see [worker instructions](../worker/README.md).

## 2026-11-09 guest preview — pre-release verification

Implemented a public synthetic preview, contextual login gates and validated
post-login return paths. Personal pages and live AI do not mount for signed-out
visitors. Existing server authentication, RLS and private Storage are unchanged.
234 tests across 22 files, TypeScript and the build passed. Local browser checks
covered 320–1440-pixel layouts, both languages, saved waveform citations and
login gates. A disposable PostgreSQL probe verified 14 anonymous-access denials.
The browser used a signed-out mock and did not test cloud login or send requests
to the AI provider. These checks did not trigger a Netlify deployment; the user
subsequently authorized a single consolidated production release.
See [scope, evidence and release boundary](guest-preview-20261109.md).

## 2026-11-04 public authentication layout and signup diagnosis

The reported `email rate limit exceeded` was confirmed in production Auth logs
as HTTP 429 / `over_email_send_rate_limit`. The dashboard still has custom SMTP
disabled. This is an email-delivery blocker, not a successful signup or a wrong
password. The default sender is restricted to project-team destinations as well
as its project-wide hourly quota. No Auth settings, confirmation requirements,
email quota or credentials were changed; ordinary public signup still requires
working email delivery.

Public login, signup, recovery and reset routes now exclude the entire workspace
shell at the application boundary, including while anonymous or restoring a
session. Authenticated account settings retain normal navigation. Individual
navigation components already hid public Auth routes; the signed-out production
login checked before this patch also showed no sidebar, so the user's original
sidebar screenshot/session remains unverified. Email-limit and unauthorized-email
errors now explain the delivery problem in the selected language without showing
a success message. All 176 tests across 19 files, TypeScript and the production
build passed. Tests simulate failures without sending email or creating accounts.
