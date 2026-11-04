# BreathMap responsive interface

This pass preserves the existing soft teal palette, typography, routes and data flow.
It adapts the working application to available space; it does not add native app
packaging, install prompts, a second backend or new analysis behaviour.

- Audience: recording owners and researchers reviewing personal breathing records.
- Structure: daily overview on Home; a workbench for recordings and analysis;
  a reading layout for sleep knowledge. All views share the same visual identity.
- Colour and type: keep the existing scoped page tokens; `src/tokens.css` shares
  those values with the account pages and the mobile navigation.
- Navigation: wide desktop screens (72rem and above) use a persistent workspace
  sidebar; tablet and narrower desktop screens retain section navigation. Below 48rem,
  Home, Records, Diary, Learn and More form a bottom navigation bar. More exposes
  every other existing destination. Current recording/date context is retained
  when switching between related wellbeing tools.
- Phone: single-column forms; history cards; labeled analysis-window cards;
  large touch targets; scrollable dialogs; account controls stay in the header.
- Tablet: two columns where the content fits; portrait and landscape can differ.
- Desktop: preserve detailed tables and larger waveforms, with a readable content width.
- Interaction: no hover-only actions; keep visible focus, reduced motion and
  modal focus management. Bottom navigation respects device safe areas.
- Validation: inspect 320, 375, 414, 768, 1024 and 1440 CSS-pixel widths in both
  interface languages. Browser fixtures are synthetic and do not establish real
  device, model-performance or clinical validation.

## AI workspace

The AI assistant is a primary destination alongside recordings. A full workspace
and a responsive side conversation share the selected recording, result version,
conversation and draft. The recording and optional time interval are the visual
anchor; use the existing teal tokens and near-white surfaces without decorative
metrics. Data analysis calculates; AI explanations interpret those saved results.
On narrow screens, collapse record switching and data-use detail, keep messages,
authorization and the composer in a non-overlapping scroll flow, and respect the
bottom navigation and safe areas. Saved explanations remain readable offline.

The global AI destination starts a general conversation about sleep, routines and
breathing. Its input and conversation history are the main content; adding an
existing recording or uploading one is an explicit secondary action. Record and
waveform-specific entries retain their selected record and interval. A visible
record discussion label and a return-to-general action distinguish the contexts.
The AI page follows the same desktop/sidebar, tablet/top and phone/bottom
navigation rules as the other pages; it has no second desktop navigation bar.

## Daily overview and analysis layout (2026-11-04)

Home has one date control and one upload entry. The selected day's diary and
respiratory recording come first, followed by the past seven days and recording
plans; history and a small set of knowledge links remain available. Cards use
their own container width to select one or two columns, including when the AI
panel reduces the available space.

The analysis workbench keeps waveforms and windows in the primary column, with
the existing AI entry, recording information and notes in a secondary column.
Below 60rem of available analysis width these sections stack in reading order.
Section links provide direct access without creating another analysis or chat
implementation. Existing save guards, data states and AI consent remain in place.
