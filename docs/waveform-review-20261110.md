# Waveform review and interval explanations

Implemented and verified locally on 10 November 2026. The user authorized one consolidated production release after reviewing the local result. Deployment identifiers and hosted verification are recorded separately in `.tmp/waveform-review-20261110/release.json`.

## Changes

- The report and detailed analysis share a synchronized three-track explorer: drag to pan, brush to zoom, wheel zoom, horizontal/Shift-wheel pan, buttons, keyboard controls, and an overview navigator.
- A shared cursor reads saved sample values. Nulls and per-channel gap markers remain intact. A coarse overview is identified as a preview until the requested saved detail arrives.
- Initial viewing uses 30 seconds, while a saved or cited interval is restored. A completed gesture requests only a waveform read; it never reruns numeric analysis or AI.
- Rapid changes retain only the latest desired range while a read is pending. Older result versions, older refresh responses, and stale range failures cannot replace the current view.
- Window selection highlights all three tracks and displays the saved classification, model score, and the original statistics-window interval. Zooming for context preserves the selected window.
- Classification counts link to their first matching window. Counts remain overlapping model windows, not independent event counts.
- Minor, explained calculation boundaries receive an informational coverage notice. Missing metadata, bad samples, rejected windows, substantial missing coverage, and unrecognized limitations retain warnings. Stored execution status, missing values, and numerical results are unchanged.

## Validation

- 265 tests in 24 files passed; TypeScript and production build passed.
- An isolated browser harness used the existing saved one-hour result. Its fixtures and mock services are confined to the ignored `.tmp/waveform-review-20261110` directory and excluded from production builds.
- Browser checks passed for window selection, synchronized cursor and highlights, zoom, pan, brush selection, wheel-request coalescing, cached ranges, keyboard navigation, pointer cancellation, and preserved gaps.
- Layouts at 320, 390, 768, and 1440 pixels were checked. Real touch input confirmed horizontal panning and ordinary vertical page scrolling.
- No cloud mutation, new analysis, AI request, or original-data change was performed during verification.

## Deployment and review

The local review page is `http://127.0.0.1:5187/?lang=zh` while its isolated development server is running. It contains saved analysis data and mock service boundaries, not the live website.

Release this group of changes once, then verify the published assets and hosted interaction. Production use of uncached intervals still requires the existing local analysis host; saved metrics and cached data remain readable when that host is offline. Local fixture checks alone do not establish hosted acceptance.
