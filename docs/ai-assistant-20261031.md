---
created: 2026-10-31
updated: 2026-10-31
creator: AI
---

# AI assistant workspace

## Scope and completion criteria

Implement the agreed AI entry points and recording-centred conversation, retaining
the existing green identity and all existing pages. The full `/assistant` page and
the global floating panel share session drafts and the selected conversation.
An analysis-window question carries an explicit recording, result SHA and interval;
responses link back to those saved signals. Viewing saved content must not start a
paid request. Account changes and result updates must not reuse previous consent.

The original analysis host stays stopped at the user's request. No second worker,
model training, real participant upload, SMTP change or course-report edit is part
of this release. Changes to the general homepage layout remain a separate pass.

## Implementation

- Main navigation and the mobile More menu expose **AI assistant**. Record pages
  show **Data analysis / AI explanation & chat** near the top, plus **Ask about
  this interval** beside waveform controls. Existing page-leave guards are retained.
- [AssistantPage](../src/AssistantPage.tsx), [AssistantView](../src/components/AssistantView.tsx)
  and [AssistantSurface](../src/components/AssistantSurface.tsx) provide the full
  workspace, explanation tab and responsive panel. Desktop panels keep the plot
  available; phone panels use the screen and preserve safe areas.
- [AssistantProvider](../src/components/AssistantProvider.tsx) keeps account-scoped
  drafts, conversation IDs, interval selection and accepted-request locks in this
  tab's session storage. Closing, reloading or expanding the panel keeps this
  state; these drafts do not automatically sync to another device. Completed
  questions/answers remain in the existing cloud jobs, subject to existing RLS.
- The selector reads only the signed-in user's active recordings. The data hook
  fences stale responses by account and recording. Result changes isolate the
  conversation, remove stale selected intervals and reset AI consent.
- Chat submits a bounded context envelope; the worker retrieves and validates up
  to two previous completed rounds itself. The browser never supplies trusted
  answer history. Missing or inconsistent context receipts require a new
  conversation rather than silently continuing unsupported history.
- Accepted requests remain locked until their job is observed, preventing the
  post-submit refresh gap from creating another paid operation. Reading a saved
  report is separate from explicitly requesting a new report.
- Citation links include the result version and verified saved-window bounds.
  The analysis page loads the selected interval automatically and rejects stale
  version references; this is not a new model run.

The bounded legacy-engine adapter and capability checks are detailed in
[assistant-context.md](assistant-context.md). They preserve the original model and
engine files. The local worker code still needs to reach the original host before
the user chooses to resume it.

## Verification and release

Verification is recorded here after the final checks. Raw local evidence is in
`.tmp/assistant-qa/`, excluded from Git and site builds. Browser fixtures replace
only the Supabase module locally, block external requests and use synthetic
recordings. Neither substituted page checks nor fake-engine checks establish
actual DeepSeek response quality, real-engine follow-up understanding, physical
phone keyboards or clinical reliability.

Cloud compatibility migration applied: `20261031110408_assistant_context_capability`.
It adds two heartbeat metadata fields without changing RLS or grants. Read-back
confirmed authenticated SELECT remains allowed and UPDATE remains disallowed;
the existing heartbeat is still 2026-10-28 21:57:53 Beijing time, protocol 0.
No task or heartbeat was created to make the original host appear online.

Final frontend checks: **116 tests passed** across 12 files; TypeScript and the
production build passed. Existing ExcelJS bundle-size warnings remain. Worker
tests passed **89**, and the disposable PostgreSQL checks passed **44**; those
two suites validate transport/state and schema boundaries, not the real model.

The initial browser matrix passed **128 checks** across six widths and two
languages. Visual inspection then found a separate short-screen overlap between
messages and the sticky composer. After fixing the layout and moving consent
above the input, a targeted suite passed **116 checks** at 375×650, 375×400,
320×650 and 1440×900 in both languages. Actual hit targets, sending to the local
fake, focus return, draft/interval retention and a clickable adjacent waveform
were checked. These batches are separate, not one combined end-to-end total.
No external requests or browser exceptions were observed. See the local
`.tmp/assistant-qa/summary.md`, `browser-results.json` and
`short-phone-recheck-results.json`. A reduced viewport is not a real soft-keyboard
or physical-device test.

Frontend deployment identity is recorded in the canonical ENT207 `CONTEXT.md`
after the published assets have been checked. This document describes the tested
source and does not by itself prove that a particular deployment is live.
