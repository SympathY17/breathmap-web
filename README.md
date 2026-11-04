# BreathMap

Standalone reconstruction of the existing BreathMap Softr application, using React, Netlify, Supabase and the existing local analysis engine.

## Current scope

Ten preserved application pages, seven wellbeing modules, twenty bilingual sleep-guide articles, native account pages, private XLSX storage, an owner-bound analysis queue, complete analysis windows, interval waveforms, report recovery and grounded questions.

The website is deployed at https://breathmap-sympathy.netlify.app. Production is public; deploy previews remain team-private. The source repository is private: https://github.com/SympathY17/breathmap-web. Actual checks and remaining limitations are recorded in `docs/acceptance.md`.

## Use the website and analysis host

Sign in, upload a compatible XLSX recording, then explicitly request analysis. Saved results remain available when the analysis host is off. New numerical, waveform-detail and recording-specific AI requests need the current analysis computer to be running. General sleep conversations run independently on Netlify.

On the configured Windows account, open PowerShell and run:

```powershell
& 'E:\Codex Data\学校课程\BreathMap_web\worker\Run-Worker.ps1'
```

Keep that process running while analysis is needed. Stop it with Ctrl+C when no job is running. Interrupting an active numerical subprocess can also interrupt that analysis; after restarting the worker, explicitly retry the interrupted task from the website. No automatic startup service is installed. Credentials are already configured on this computer; do not configure them again just to start the worker.

Email confirmation remains enabled. The project currently uses Supabase's limited default email service; ordinary users' confirmation and password-reset delivery still require custom SMTP. The project owner explicitly deferred that configuration. No real Softr accounts or participant recordings were migrated.

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

The Netlify project is `breathmap-sympathy` (ID `8b0b3927-4327-48d2-a34d-948d5e6613ce`), connected to `SympathY17/breathmap-web`, branch `main`, build `npm run build`, publish directory `dist`. The two public client variables are configured across deploy contexts. Supabase Auth Site URL is the production HTTPS origin; the allowed email redirects are its exact `/` and `/reset-password` URLs.

No existing Softr health records are included in this repository. Use synthetic files for acceptance before deciding what existing data to migrate.
