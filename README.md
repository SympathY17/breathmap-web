# BreathMap

Standalone reconstruction of the existing BreathMap Softr application, using React, Netlify, Supabase and the existing local analysis engine.

## Current scope

Ten preserved application pages, seven wellbeing modules, twenty bilingual sleep-guide articles, native account pages, private XLSX storage, an owner-bound analysis queue, complete analysis windows, interval waveforms, report recovery and grounded questions.

The frontend is source-ready. Cloud provisioning and browser acceptance must be recorded separately in `docs/acceptance.md`; a successful build does not prove a deployed workflow.

## Frontend

Use Node 24. Run `npm ci`, copy `.env.example` to `.env.local`, and enter the new project's URL and **publishable** key. Run `npm run dev` for localhost; run `npm run build` for Netlify's `dist/` output.

Never put a Supabase secret/service-role key or DeepSeek key in `VITE_*` settings, `netlify.toml`, source files or this repository.

## Database

`supabase/schema.sql` is intended for a new project. See `docs/schema.md` for table fields, RLS and worker RPCs. `node scripts/verify-schema.mjs` exercises the schema in a disposable local PostgreSQL engine. It does not replace checking the hosted project's grants, storage and Auth settings.

## Analysis host

See `worker/README.md`. The worker makes outbound HTTPS requests and opens no inbound port. It imports the existing engine from the sibling `BreathMap_local_20261027` project and uses `E:\breathmap` for runtime storage. The old Softr bridge and its records are retained.

Website uploads save the original file only. Analysis is explicitly requested; AI reports and questions require separate consent. When the host is offline, requests remain queued and previously saved results remain available.

## Verification

- `npm test`: frontend adapter and scientific display boundaries.
- `npm run build`: TypeScript and production compilation.
- `node scripts/verify-schema.mjs`: disposable database permission and queue checks.
- `python -B -m unittest discover -s worker -p test_worker.py`: worker transport, ownership, persistence and recovery boundaries.
- `python -B worker/verify_existing_backend.py --run-synthetic`: frozen model plus synthetic input, isolated local transport; no cloud or paid AI.

## Deployment

The Netlify project is `breathmap-sympathy` (ID `8b0b3927-4327-48d2-a34d-948d5e6613ce`). Team access protection remains enabled. Connect the private GitHub repository only after source checks; set the two client environment variables and use `npm run build` / `dist`. Password-reset and confirmation redirects must be configured for the final HTTPS URL in Supabase Auth.

No existing Softr health records are included in this repository. Use synthetic files for acceptance before deciding what existing data to migrate.
