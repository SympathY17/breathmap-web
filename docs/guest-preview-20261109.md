# Guest preview — implementation and pre-release checks, 9 November 2026

Implemented and checked locally on `feat/guest-preview-20261109`.
The user approved one consolidated production release on 9 November 2026.
The verification below records the pre-release checks; the deployment receipt
and subsequent production browser results belong to the ignored evidence
directory `.tmp/guest-preview-20261109/`.

## Access and navigation

| Visitor action | Signed-out behavior |
| --- | --- |
| Open `/` or `/demo` | Browse the public product overview and synthetic example |
| Open `/learn` | Read the public sleep guide |
| Inspect example metrics, signal intervals and saved explanation | Read local synthetic data; no new analysis or AI request |
| Upload, analyse a personal recording, save notes, keep a diary, view personal history or ask a new question | Show a contextual login dialog |
| Open another known private URL directly | Show the public preview with the corresponding login dialog; do not mount that private page |
| Close the dialog | Continue browsing the example |
| Sign in | Return to the validated internal destination; do not automatically perform the action |

The login page now includes **Explore as guest** and explains that registration
is temporarily unavailable. Direct registration and password recovery routes
remain intact. Guest access does not resolve the existing SMTP limitation.

Existing authenticated workspace behavior is retained. `/demo` stays a public
example even for a signed-in user and offers a link back to the workspace.
Authentication restoration still runs normally; this is not a shared account
and does not create a Supabase anonymous user.

## Data and permissions

`src/guest/demo-data.ts` is a sanitized public projection of the previously
verified 60-second synthetic recording. It contains real saved numerical
results, 741 signal points, source hashes and saved AI excerpts. It contains no
account identity, private object location, credential or provider receipt.
Chinese explanation text is identified as a translation of the saved English.

The demo preserves partial analysis status, null samples and channel breaks.
Its model windows are overlapping research windows, not clinical event bounds.
The channels are magnetic signal, estimated expiratory flow and SIG differential
voltage. No CO₂ measurement or new AI response is invented.

Private pages, data hooks and live AI panels are excluded at the application
boundary for signed-out visitors. Database grants, RLS, private Storage and
server authentication are unchanged. Login return paths use a known-route and
query allowlist, rejecting external locations and removing callback tokens.

## Verification

- 234 automated tests across 22 files passed, including guest actions, route
  isolation, safe login return paths, missing signal samples and saved citations.
- TypeScript and the production build passed. Existing large-chunk warnings
  remain; this change does not address unrelated bundle optimization.
- An ephemeral local PostgreSQL probe confirmed anonymous CRUD is denied for
  11 private tables and execution is denied for the three analysis/chat RPCs.
  It uses minimal Auth/Storage stubs, not a fresh cloud integration test.
- Browser checks covered Chinese and English, desktop/tablet/mobile layouts
  between 320 and 1440 pixels, contextual dialogs, direct private URLs, and a
  saved citation opening the matching 50–60-second waveform and input fields.
- Browser QA replaced the Supabase module with a signed-out local mock that
  throws on private/cloud access. No real login, email, analysis, AI or cloud
  write was performed. Screenshots and receipts are in the ignored directory
  `.tmp/guest-preview-20261109/`.

The older `scripts/verify-schema.mjs` stops at an outdated assertion that the
assistant-capability migration is the latest migration; newer sleep-chat
migrations already exist. It was left unchanged. The current schema plus those
chat migrations were used for the separate anonymous-permission probe above.

## Release boundary

Publish this tested change as one update to the production branch, avoiding
additional preview builds. After deployment, check public URLs and an
existing-account login return on the real site.
Public signup and password-recovery delivery still need SMTP configuration.
