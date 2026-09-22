# Color Space Compare: V3 Wheel Integration

## Source

The wheel geometry, Canvas rendering, HEX parser, and geometry regression cases
are adapted from Joshua-Zion's contribution in
[ToolKnit Desktop PR #67](https://github.com/ZihangDong/toolknit-desktop/pull/67),
revision `8691216bad1f7154c53ad52e9126ec151ade8979`, under the repository's
[Apache-2.0 license](../../../../LICENSE). The PR was not merged; these changes
are integrated into the existing V3 feature. Source comments mark the adaptations.

## Ownership

- `tool.js`: existing shared tool shell, HEX field, and wheel mount; navigation
  and backgrounds still use `shared/tool-page-shell.js`.
- `core.js`: wheel geometry, HSV/HSL coordinate conversion, and strict 3/6-digit
  HEX parsing. Non-leading hashes and non-HEX content are rejected.
- `wheel.js`: two Canvas wheels, cached hue rings, DPR capped at 2, pointer
  capture, one pending pointer frame, localized labels, and canvas cleanup.
- `controller.js`: one canonical model shared by wheels, numeric inputs,
  sliders, preview, gamut checks, and copy results. Numeric and HEX drafts end
  before a wheel/slider takes over. Achromatic colors retain the selected hue.
- The feature CSS owns layout; the existing light stylesheet overrides control
  tokens. Actual color pixels are identical across themes.

HEX updates only on a valid draft, normalizes on blur/Enter, and restores the
pre-edit model on Escape. Its snapshot survives the application's capture-phase
Escape blur. Closing cancels pending wheel input and rendering, releases pointer
capture and canvases, and reopening resets the model. Destroy also removes wheel
and HEX listeners. CIELCH precedes CIELAB in both controls and copy results.

The existing `data-role="hex"` output is retained (hidden) for compatibility.
New feature-local roles are `hex-input`, `hex-row`, `wheels`, and `wheel-hit`;
`data-wheel` identifies `hsv` or `hsl`. There are no new storage keys, native
commands, events, dependencies, CLI/MCP parameters, or changes to legacy shims.

## Verification

- `npm run test:color-space-compare`: existing conversion/input cases, adapted
  geometry cases, strict HEX parsing, actual wheel/editor draft takeover,
  coalesced moves, final pointer value, cancellation, capture cleanup, and reopen.
- `npm run build`, then `node scripts/test-color-space-compare-theme-browser.mjs`:
  two themes, raster samples, live HEX edits, invalid input, Escape, numeric/wheel
  takeover, continuous drag, all eight models, copying, exact theme-independent
  canvas colors, responsive widths, language switching, and lifecycle.
- The browser script accepts `TOOLKNIT_TEST_MODULES`, `TOOLKNIT_TEST_BROWSER`,
  and `TOOLKNIT_TEST_DPR` (for example `2`). Screenshots are written to the ignored
  `tmp/color-space-compare-theme/` directory.

Browser verification does not certify frame rate or all Windows/WebView2/GPU
combinations; the desktop package still needs normal release validation.
