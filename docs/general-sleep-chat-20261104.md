# General sleep conversations — 4 November 2026

## User-visible behavior

Global AI navigation opens a conversation about sleep, routines and breathing
without requiring a recording. Users can choose an existing conversation or start
a new one. Adding a recording explicitly opens a picker and upload entry;
recording and waveform-specific AI entries retain the original record workflow.
The upload success page offers a return to the assistant with the new recording,
and clearly states that analysis must finish before its results can be explained.

The desktop uses the common sidebar, tablets the common top navigation and phones
the existing bottom navigation. The old AI-only navigation and introduction panel
have been removed. The complete page and floating panel share account-scoped
conversation selection and drafts, while AI-processing consent resets on context
change. General conversation history is saved in the cloud; draft text remains
session-local rather than cross-device synchronized.

## Backend and data

`netlify/functions/sleep-chat.mjs` verifies a Supabase user token server-side before
calling DeepSeek. General conversations do not query recordings, files, analysis
results or diaries and do not depend on the local analysis worker. The existing
record interpretation/chat workflow is unchanged and still needs that worker.

Migration `supabase/migrations/20261104035732_sleep_chat.sql` adds
`sleep_chat_conversations` and `sleep_chat_messages`. RLS allows authenticated
owners to read only their rows. Browsers cannot write or forge answers; the two
SECURITY INVOKER RPCs are executable only by service_role. The cloud applied this
as migration `20261104040410_sleep_chat`; do not reapply it under another name.

Each request has a stable UUID. Rechecking an accepted request returns its existing
state without another provider call. There is one pending request per account,
20 requests per ten minutes and 100 per day. Old pending claims expire after two
minutes. Up to six completed turns (bounded excerpts) are supplied as context.
Provider calls time out at 35 seconds. Unknown completion is checked explicitly;
the client does not silently repeat a paid request.

## Verification and release gate

140 component, request, endpoint and temporary PostgreSQL tests passed across 17
files. TypeScript and the production build passed. Tests include account switching
during session lookup, stale results after unmount, ownership, RLS, write denial,
same-ID retries, failure caching, concurrent claim scheduling and rate limits.
PGlite checks do not establish real multi-connection load acceptance.

Browser checks use the read-only synthetic fixture: general chat without a record,
explicit record selection and return, retained draft and consent reset, English
and Chinese at 320/375/414/768/1024/1440px, and a 375x400 short-screen composer.
No page-wide horizontal overflow was found. Evidence is local and ignored by Git
under `.tmp/general-assistant-20261104/`; it is not real-device or live AI proof.

Production secrets are not configured yet. Netlify Free rejects functions-only
variable scopes. Automatic approval also rejected broadening the secret scopes
without explicit user authorization. The pending user question covers production
server variables available to builds/functions/runtime, with secret marking and
a check that the generated browser files contain no secrets. Do not retry this
scope expansion or publish an apparently working chat until authorization and
configuration are complete. No paid upgrade is authorized.

The previous production version remains available. SMTP and local worker recovery
remain deferred. Existing retained QA accounts and recordings must not be deleted.
