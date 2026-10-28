# Rebuild acceptance record

Date: 2026-10-28 (Asia/Shanghai).

## Verified locally

| Area | Evidence | Scope |
|---|---|---|
| Production compilation | TypeScript + Vite passed | Ten copied pages, new Auth and connected analysis UI compile; no hosted login implied |
| Frontend boundaries and forms | 75 Vitest checks passed | UUID filtering, safe writes, Auth callbacks, private downloads, result replacement, 25-window pagination, retained results during AI failure/offline state, wellbeing form persistence and deletion readback |
| Database execution | 43 PGlite PostgreSQL checks passed | Schema upgrade, RLS, grants, storage policy stubs, queue transitions, stale leases, restart fencing and frozen deletion lifecycle |
| Worker | 66 Python checks passed | Ownership, hashes, explicit numeric retries, publication reconciliation, exact artifact rollback, ambiguous upload handling, consent and scoped disposable-test cleanup |
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
- Private GitHub repository `SympathY17/breathmap-web` contains the full source and follow-up fixes. The Codex connector was explicitly authorized for this repository only. Source synchronization uses that connector; Git CLI transport from this host could not reach GitHub.
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

The hosted viewport override did not change the measured 1280-pixel viewport. This run therefore does not count as a hosted mobile-size check; earlier local fixture checks and responsive CSS do not replace physical-device acceptance.

## Remaining acceptance, in order

1. Custom SMTP and actual confirmation/password-reset email delivery are deferred by the user. Email confirmation remains enabled.
2. Actual phone/device acceptance remains for the user; do not treat desktop or fixture checks as a real-device result.
3. The additional monitoring date-picker and full reaction/trends flows were checked at component/API boundaries, not all completed through the hosted browser. The browser's date input and a subsequent unsaved-draft dialog prevented completing that particular hosted form; no production date bug was established.

No remaining item is marked completed merely because a matching source file exists.

## Follow-up correctness review

Independent review reproduced and fixed two races: an old interval waveform blocking a new result overview, and recovery deleting an overview while a delayed finish request committed. Result-version changes now clear the old waveform task and evidence view. Server-side lease fencing decides committed versus abandoned work before cleanup. Permanent deletion freezes a trashed recording, quiesces its tasks and verifies both origin Storage prefixes are empty before removing the row. A cleanup failure leaves a marked record with a safe retry, rather than allowing restore over missing files.

Fresh component tests use the actual production wellbeing components with substitute persistence hooks: monitoring transitions, exact relaxation/routine/reaction data shapes, template conflicts and dirty edits, selected visit printing, reaction practice versus formal trials, blur cancellation and one-time saves. These are deterministic component checks, not a claim of hosted browser completion.

A second disposable hosted browser session verified five-minute quiet-timer preferences and favourites across refresh, timer start/pause/stop, a weekday routine with a structured class commitment across refresh, and linked visit notes across refresh. Hosted database readback matched the real saved JSON shapes. No model or AI call was needed for this session; it reused the verified synthetic result. The screenshot is `.tmp/hosted-visit-persistence.png`.

The first expanded lifecycle smoke run passed 127 checks and then failed an immediate post-delete download assertion. Edge logs confirmed `cf_cache_status=HIT`; the assertion had reused an already cached URL. The test now requires an exact deletion response, an empty origin Storage listing and a unique cache-bypass download. The failed report is retained as `.tmp/cloud-smoke-49a80484-8d8e-4967-b6cf-a6b1999c5bb4.json`; it is not counted as a successful full run.

The next run verified the actual removal but exposed a second harness error: selecting `*` from jobs includes server-only lease fields. The check now selects only permitted public columns and independently verifies the cascade as the service role. The final run passed **134 cloud checks**, with no AI calls and successful cleanup: `.tmp/cloud-smoke-9e0d1bd2-29e6-4357-9950-823a633d461c.json`. These checks include actual private-file deletion, origin listing, cache-bypassed denial, both lease outcomes and the running deletion gate. They do not claim exhaustive simultaneous connection or network-failure injection.

Storage POST timeouts have a separate operational limit. The worker retains the running task and pending content-hash journal and stops claiming work. Restart proceeds only after reading a complete matching object; missing or mismatching content requires operator review. It does not assume a timed-out upload was cancelled. See `worker/README.md` for stop/restart guidance.
