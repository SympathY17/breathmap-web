---
created: 2026-10-31
updated: 2026-10-31
creator: AI
---

# AI assistant context protocol 1

This adds context to the existing record-bound `chat` operation. It does not
replace numerical analysis, change model weights, or start another worker.

## Request and result

The existing language, consent and result-SHA requirements remain. The new
assistant accepts a current question of 1–800 characters and this optional
context object (a chat without this object keeps the original 2,000-character
question behaviour):

```json
{
  "assistant_context": {
    "version": 1,
    "conversation_id": "11111111-1111-4111-8111-111111111111",
    "selection": {
      "start_s": 10,
      "end_s": 26,
      "kind": "model",
      "window_id": "M01"
    },
    "previous_job_id": "22222222-2222-4222-8222-222222222222"
  }
}
```

`selection` and `previous_job_id` can be omitted. A free time range needs only
`start_s` and `end_s`; a named window must include its kind and exactly match a
window saved for this record and result version. The example is a contract, not
real participant data. IDs must be canonical UUIDs.

The result adds `assistant_context` containing the normalized request context,
`history_job_ids` actually used (chronological order, at most two), and
`history_excerpted`. An unknown context version, arbitrary client-supplied
history, invalid time range, mismatching window, or invalid prior-job reference
is rejected before calling AI.

## History and engine compatibility

The worker retrieves earlier jobs itself. Every referenced round must belong to
the same account, recording, conversation and result SHA, be a completed `chat`,
have consent and a matching context receipt, and finish before the next round
was created. Only structured saved `answer.claims[].text` is accepted as past
answer text. The full saved conversation stays in cloud jobs; the model input
uses at most the two most recent completed rounds, with shortened question and
answer excerpts. The result discloses excerpting, including a longer chain.

The current question, verified selection and history are encoded as JSON in a
single string sent to the existing `service.chat(local_id, question, language)`.
This is a compatibility adapter, not a new engine messages API. The input is at
most 2,000 Python characters; previous question/answer excerpts start at 100/140
characters and may shrink further. The current question and selection are never
silently truncated or removed. If those still cannot fit, the request fails with
`assistant_context_too_large`. Past dialogue is explicitly marked as contextual
reference, not numerical evidence or instructions; the engine's saved analysis
and verified evidence tools remain the sources for numerical claims. The worker
rechecks the result SHA after the answer before publishing it.

The original analysis engine is on the other computer and is not changed here.
Local fake-engine tests verify the adapter boundaries and exact forwarded input;
they do **not** establish that the real provider follows references correctly,
resolves follow-up pronouns, or returns clinically reliable answers. Real-engine
and provider-response validation remains pending until that original host is
resumed by the user.

## Capability and deployment order

1. Apply [the additive heartbeat migration](../supabase/migrations/20261031104633_assistant_context_capability.sql).
   It adds `assistant_protocol` (default 0) and `assistant_seen_at`; existing RLS,
   permissions, records and jobs are unchanged. The full schema snapshot and
   disposable PostgreSQL checks include the same fields.
2. Update the existing worker files on the **original** analysis computer. Do not
   start a second worker on this computer or copy its live runtime ledger.
3. When the user chooses to resume that host, the updated worker writes protocol
   1 and the identical timestamp to both `last_seen` and `assistant_seen_at`.
4. The frontend must require a fresh heartbeat, protocol 1 and timestamp equality
   for context-aware sends. If the migration is missing, fields are missing, or a
   legacy worker advances only `last_seen`, fail closed for contextual chat and
   retain access to existing saved reports. A stale protocol stamp alone is not
   proof that the currently running worker supports context.

The migration's cloud application status is recorded in
[the release record](ai-assistant-20261031.md). This interface contract does not
assert host startup or a real AI call. No service credentials are included.

## Local verification

- Run Python discovery with `-s worker -p 'test*.py'` for the existing worker and
  assistant-context regression suites, using the bundled Python runtime.
- Run `node scripts/verify-schema.mjs` for the real schema and migration in
  temporary PGlite PostgreSQL. Auth and Storage are minimal stubs; these tests do
  not prove a newly deployed cloud write or production account isolation.
