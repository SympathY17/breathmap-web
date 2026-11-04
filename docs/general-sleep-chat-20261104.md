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
conversation selection and drafts. Ordinary chat sends directly without a consent
checkbox; a short DeepSeek notice stays below the composer. The separate recording
analysis authorization is unchanged. General conversation history is saved in the cloud; draft text remains
session-local rather than cross-device synchronized.

Choose a saved conversation and use Delete conversation to remove the whole chat.
The confirmation initially focuses Cancel. Cancel preserves the conversation;
successful deletion clears its local draft and opens a new chat. Deletion is
disabled while a reply is pending, history is loading or another operation is
active. Failed or unconfirmed deletion stays visible and can be retried.

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

Migration `supabase/migrations/20261104054825_sleep_chat_deletion.sql` adds a
deletion marker and the service-role-only, SECURITY INVOKER
`delete_sleep_conversation` RPC. The cloud applied it as
`20261104055326_sleep_chat_deletion`; do not reapply it. Deletion redacts the title,
questions and answers, and RLS hides the conversation and messages. Minimal request
IDs, owner IDs and timing metadata remain for rate limits and replay protection.
An old request cannot resurrect a deleted conversation. Sending and deletion use
the same account advisory lock; a pending reply in the target chat blocks deletion.
The migration itself does not delete or redact existing conversations.

## Verification and release gate

158 component, request, endpoint and temporary PostgreSQL tests passed across 17
files. TypeScript and the production build passed. Tests include account switching
during session lookup, stale results after unmount, ownership, RLS, write denial,
same-ID retries, failure caching, concurrent claim scheduling and rate limits.
The deletion update also covers plaintext redaction, target-chat pending guards,
both serialized send/delete orderings, cancelled/retried deletion and delayed
authentication restoration with the actual AssistantProvider.
PGlite checks do not establish real multi-connection load acceptance.

Browser checks use the read-only synthetic fixture: general chat without a record,
explicit record selection and return, retained draft and consent reset, English
and Chinese at 320/375/414/768/1024/1440px, and a 375x400 short-screen composer.
No page-wide horizontal overflow was found. Evidence is local and ignored by Git
under `.tmp/general-assistant-20261104/`; it is not real-device or live AI proof.

The direct-send/deletion update was clicked through in an isolated local fixture:
Cancel preserves the saved reply; confirmation removes the chat and opens a new
one; reload does not restore it. The confirmation initially focuses Cancel and
its controls sit above the overlay. Checks at 375/768/1440px found no page-wide
horizontal overflow. New evidence is under `.tmp/chat-delete-20261104/`. A late
CSS cascade issue that blocked the confirmation button was fixed before release.

The user explicitly authorized Netlify Free's builds/functions/runtime scopes
for the two production-only server variables, `DEEPSEEK_API_KEY` and
`SUPABASE_SECRET_KEY`. Both are marked secret, have no VITE_ prefix and are absent
from source/browser output. Production context and scope metadata were verified;
no paid upgrade or secrets in Deploy Preview contexts are authorized.

Before publication, the same handler running on loopback passed nine real cloud
checks using synthetic accounts: anonymous and foreign-origin rejection, two real
DeepSeek turns, saved turns, same-ID replay, cross-account read isolation,
client-write rejection and foreign-conversation rejection. Two synthetic accounts
and their evidence were retained. This validates the real API/DB/provider path;
Netlify production runtime acceptance subsequently passed the same nine checks
with two further synthetic accounts and two real provider turns. The second reply
correctly translated the first question from the preceding answer. These two
batches are recorded separately, not presented as independent real-user trials.

PR #4 was merged as `217a43bcfa2cf9f76d8bf471a59c77f27f480fcc` and production
deploy `6aeabcf972449ffa5e6b8912` became ready at 2026-11-04 13:05:28 CST.
The `/assistant` route returned HTTP 200. All 17 deployed JS/CSS files matched the
tested local build byte-for-byte and contained neither server secret. An initial
asset request returned HTTP 500; the instrumented follow-up check passed all
files. Raw production API results and resource hashes remain in the ignored
local evidence directory. Four new synthetic accounts across the two batches
were retained; existing records and accounts were untouched.

SMTP and local analysis worker recovery remain deferred. Existing retained QA
accounts and recordings must not be deleted.

## Direct-send and deletion release

PR #5 merged as `f22ba89a7d0b13c373233103735aed4d8e76d414`.
Production deploy `6aeacd05c52efd1a41a99c86` became ready at
2026-11-04 14:14:00 CST. Nine production checks passed: a real DeepSeek answer
without an ai_consent field, foreign-owner deletion rejection, owned deletion,
idempotent deletion, hidden deleted messages, replay rejection, plaintext
redaction with retained counters, pending-reply deletion rejection and deletion
after that synthetic pending fixture completed. Only the two newly created
synthetic conversations were deleted; the two new QA accounts remain and all
previous accounts, conversations and recordings were preserved. One real AI turn
was used, not a real-user trial. The route returned HTTP 200 and all 17 published
JS/CSS assets matched the tested build, with no server-secret matches.

Evidence: `.tmp/chat-delete-20261104/live-smoke.json`,
`production-assets.json`, `secret-scan.json`, `desktop-chat.png`,
`phone-delete-confirm.png` and `drawer-delete-confirm.png` (ignored local files).
