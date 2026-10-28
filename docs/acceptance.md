# Rebuild acceptance record

Date: 2026-10-28 (Asia/Shanghai).

## Verified locally

| Area | Evidence | Scope |
|---|---|---|
| Production compilation | TypeScript + Vite passed | Ten copied pages, new Auth and connected analysis UI compile; no hosted login implied |
| Frontend boundaries | 52 Vitest checks passed | UUID filtering, safe writes, lost insert acknowledgement/recovery, rejected Auth callbacks, private downloads, zero/null, waveform gaps, result hashes and request acknowledgement |
| Database execution | 37 PGlite PostgreSQL checks passed | Two disposable users; schema, RLS, grants, storage policy stubs, queue transitions, stale request/lease rejection and delete cleanup |
| Worker | 30 Python checks passed | Ownership, hashes, recovery, source attribution, consent and modern/legacy credential headers |
| Existing model integration | Synthetic 60-second input, isolated transport | Real model: 11 model windows, 2 statistics windows, 1 attention window; no real cloud or AI calls |
| Read-only browser checks | Actual React pages with cached synthetic fixture | Home, recordings, upload, recycle bin, preferences, security, guide, seven wellbeing views, account/login/signup/password reset, report/analysis display |
| Responsive checks | Browser viewport 320/390/768 px | Main pages showed no document horizontal overflow; analysis displayed three waveforms and actual fixture metrics |
| Browser console | No warning/error entries in the checked QA session | Isolated read-only fixture, not hosted acceptance |
| Dependencies | npm audit: 0 reported vulnerabilities | Installed lockfile; not a claim that the entire application has no possible security issues |

The browser fixture is under `.tmp`, visibly labelled read-only synthetic QA, and excluded from the repository and production build. Its database, storage and authentication are substitutes. Buttons that would write or call AI are intentionally rejected there.

## Cloud state

- Netlify project created: `breathmap-sympathy`, ID `8b0b3927-4327-48d2-a34d-948d5e6613ce`.
- Netlify production is ready at `https://breathmap-sympathy.netlify.app`, connected to GitHub `main`. Deploy `6ae172978ad2ee759d482d25` includes the verified public frontend settings. A prior successful build lacked those settings; this was found in the actual browser and corrected through the project UI.
- The user explicitly authorized opening the website. Only this project's production entry is public; previews remain private. A broad `all-projects` connector mutation was rejected and did not apply; the narrower per-project production setting was then verified in the UI.
- Supabase project `hboyzyzzlzkgzubpsieo` is healthy in Singapore on the user-approved free plan. Two migrations were applied; all ten public tables have RLS. Security advisors returned no findings; performance advisors contain only unused-index information for the new empty tables.
- Private GitHub repository `SympathY17/breathmap-web` contains the initial checked source commit `a2de81d6c4ca2b2a1416cd1ed4c2694eef55b5dc`. The Codex connector was explicitly authorized for this repository only. Follow-up boundary fixes and acceptance helpers are being synchronized.
- The two frontend publishable settings are configured. The worker credential was saved with Windows encryption for this account; an actual cloud empty-queue poll completed successfully (`processed: 0`).
- Existing backend, model, runtime records, Softr website and Obsidian files were not migrated or deleted.
- Supabase Auth Site URL and its exact production `/` and `/reset-password` redirect URLs were saved and read back. Email confirmation was retained; custom SMTP is absent and the user explicitly deferred it.

## Actual cloud API and worker acceptance

The extended run passed 127 checks using two disposable, confirmed synthetic users and the known synthetic XLSX. Seven business domains, persisted edits, cross-owner denials, private files, immutable input metadata, task consent/idempotency, complete model/statistics/attention windows, overview and interval waveforms, recycling and permanent cleanup were exercised against the hosted project. Numeric output contained 11 valid model windows, 2 statistics windows and 1 attention window; the overview had 741 source points.

Exactly one report and one question were requested. DeepSeek's official API completed their four evidence/explanation calls using `deepseek-flash`; report provenance and exact citation/value bindings passed, and numerical artifact hashes remained unchanged. Provider-failure preservation was checked by deterministic unit fault injection, not by creating extra paid failures.

The two users and all their cloud resources were removed. Independent SQL confirmed zero remaining temporary Auth, business, job, result and Storage objects. The sanitized evidence is `.tmp/cloud-smoke-fbf48f74-5785-4b5b-897c-13676ee299d8.json`; reproducible source is `worker/cloud_smoke.py`. Newly generated synthetic local artifacts remain in the runtime sandbox for traceability. This proves API/worker behavior, not delivery of real email or browser completion of every form.

## Remaining acceptance, in order

1. Publish the follow-up acknowledgement/Auth fixes and verify the resulting automatic deploy.
2. Complete hosted-browser checks with a disposable synthetic account and remove it afterward. Record those separately from API acceptance.
3. Custom SMTP and actual confirmation/password-reset email delivery are deferred by the user. Real phone/device acceptance also remains separate from viewport emulation.

No remaining item is marked completed merely because a matching source file exists.
