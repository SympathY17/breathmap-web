# BreathMap responsive interface

This pass preserves the existing soft teal palette, typography, routes and data flow.
It adapts the working application to available space; it does not add native app
packaging, install prompts, a second backend or new analysis behaviour.

- Audience: recording owners and researchers reviewing personal breathing records.
- Structure: daily overview on Home; a workbench for recordings and analysis;
  a reading layout for sleep knowledge. All views share the same visual identity.
- Colour and type: keep the existing scoped page tokens; `src/tokens.css` shares
  those values with the account pages and the mobile navigation.
- Navigation: desktop and tablet retain the full section navigation. Below 48rem,
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
