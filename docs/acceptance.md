# Rebuild acceptance record

Date: 2026-10-28 (Asia/Shanghai).

## Verified locally

| Area | Evidence | Scope |
|---|---|---|
| Production compilation | TypeScript + Vite passed | Ten copied pages, new Auth and connected analysis UI compile; no hosted login implied |
| Frontend boundaries | 36 Vitest checks passed | UUID query filtering, safe writes, private downloads, zero/null, waveform gaps, result hashes and request acknowledgement |
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
- First Netlify deployment is ready at `https://breathmap-sympathy.netlify.app` (deploy `6ae16eba0a40c50e23eaa95e`). Existing team login protection remains enabled. Git continuous deployment is not yet connected.
- Supabase project `hboyzyzzlzkgzubpsieo` is healthy in Singapore on the user-approved free plan. Two migrations were applied; all ten public tables have RLS. Security advisors returned no findings; performance advisors contain only unused-index information for the new empty tables.
- Private GitHub repository `SympathY17/breathmap-web` exists. The connector was explicitly authorized for this repository only and read access is verified. Source upload is in progress.
- The two frontend publishable settings are configured. The worker credential was saved with Windows encryption for this account; an actual cloud empty-queue poll completed successfully (`processed: 0`).
- Existing backend, model, runtime records, Softr website and Obsidian files were not migrated or deleted.

## Remaining acceptance, in order

1. Push the checked source to GitHub and connect the existing Netlify project to continuous deployment.
2. Configure Supabase Auth redirects for the final HTTPS address.
3. Use disposable synthetic test users and XLSX files for actual cloud persistence, private downloads, two-account isolation, recycle/restore/delete, upload→analysis→complete windows→waveform interval. Record API and browser checks separately.
4. Reuse the existing local DeepSeek configuration for a separately consented real report and question. Verify provenance and preservation of numerical results after provider failure.
5. Verify real-device access and decide whether the website should remain team-protected or be made accessible for course testing. Email confirmation/reset delivery needs to work for the intended test addresses; the default mail service may not suffice.

No remaining item is marked completed merely because a matching source file exists.
