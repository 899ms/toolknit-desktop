# ToolKnit Desktop V3 Architecture

This document describes the architecture that currently exists on the V3
branch. It is updated as migration batches land; planned but unimplemented
boundaries remain in `V3_ARCHITECTURE_PLAN.md`.

## Current foundations

- `src/app/tool-lifecycle.js` owns listener disposal, timers, abort controllers
  and stale asynchronous revision tokens.
- `src/app/lazy-tool-registry.js` normalizes feature instances, caches load
  promises and provides the compatibility open path used by `main.js`.
- `src/platform/tauri-runtime.js` isolates optional Tauri APIs from browser QA.
- `src/shared/tool-page-shell.js` centralizes the standard tool-page shell.
- `src/shared/text-document-reader.js` owns bounded TXT, Markdown, CSV, JSON,
  HTML, DOCX and PDF text extraction for every migrated text consumer.
- `src/shared/text-document-drop.js` owns browser/Tauri document drop wiring
  and registers the native `unlisten` callback with the feature lifecycle.
- `src/shared/sortable-file-list.js` binds native drag or pointer reorder
  interactions to a render scope so generated queue rows release every
  listener together. The pointer variant also guards native WebView drops
  while a PDF queue is being reordered.
- `src/features/lazy-tools.js` is the declarative feature loading catalog.
- `src/features/pdf-editor/history.js` owns bounded undo/redo snapshots and
  transaction locking without coupling history to the DOM.
- `src/features/pdf-editor/focus.js` owns modal focus trapping and restoration
  for the PDF Editor overlay hierarchy.
- `src/features/pdf-editor/thumbnails.js` owns page-tile rendering,
  IntersectionObserver scheduling, PDF.js thumbnail tasks and drag reordering.
- `src/features/pdf-editor/errors.js` owns cancellation identity shared by the
  PDF Editor load and export flows.
- `src/features/pdf-editor/exporter.js` owns PDF assembly, font resources,
  browser/native output publication and operation-guarded completion state.
- `src/features/pdf-editor/documents.js` owns PDF.js loading tasks, source
  document caching, same-source load de-duplication, generation invalidation
  and document destruction at reset/dispose boundaries.
- `src/features/pdf-editor/text-layout.js` owns PDF text-item line grouping,
  source/edited/inserted text visual boxes and PDF-to-viewport rectangle
  conversion without DOM or tool-lifecycle ownership.
- `src/features/pdf-editor/zoom.js` owns zoom mode/scale snapshots, wheel and
  button interactions, preview transforms, anchor scrolling and pending-frame
  cleanup without owning PDF.js rendering.
- `src/features/pdf-editor/page-selection.js` owns current-page resolution,
  document-order targets, page selection gestures and selection anchor state.
- `src/features/pdf-editor/page-operations.js` owns page rotation, ordering,
  duplication, blank-page insertion and deletion while injecting the existing
  document/source stores and history boundary.
- `src/features/pdf-editor/file-session.js` owns browser/Tauri file selection,
  bounded reads, staged replacement loading and append validation/commit
  ordering while leaving document destruction to the document store.
- `src/features/pdf-editor/view.js` owns the visible editor session shell:
  overlay open/close, success state, drag hints, file metadata and zoom labels.
- `src/features/pdf-editor/operation.js` owns the single active operation,
  progress surface, cancellation identity, error localization and browser/Tauri
  file reads for the editor.
- `src/core/bounded-response.js` is an initial UI-independent core utility.
- `src/core/serialized-request-session.js` owns one-at-a-time async requests,
  timeout state, request-specific cancellation and stale-result identity.
- `src/features/ai-workbench/ai-workbench-shared.css` owns the chat, prompt and
  action primitives shared by AI Document and AI Table.

## Feature contract

Each migrated feature exposes one initializer through its lazy specification:

```js
initFeature(context) => {
  open(),
  close(),
  dispose()
}
```

The initializer binds stable existing DOM nodes once. `open` resets transient
state and creates open-session resources. `close` invalidates stale work and
releases session resources. `dispose` also removes feature-lifetime listeners.
Pure calculations live in `core.js`; feature-only CSS is imported by the lazy
tool entry so it becomes a separate production chunk.

## Migrated ownership

- Developer toolbox: JSON, Base64, URL, UUID and JWT.
- Password generator.
- Timestamp calculator.
- BMI/body-fat, mortgage and interest calculator family.
- Typing test, including its word data, audio graph, timers and input state.
- Text statistics and text formatting, including bounded document reads,
  cancellable stale-result guards, copy feedback and drag/drop resources.
- AI polish and AI translation, including API-key gating before lazy import,
  shared document input, request cancellation, stale-result guards, dynamic
  result bindings and language-aware transient feedback.
- AI Document, split into orchestration, request session, prompts, preview,
  editor and exporter modules. Generated bindings, editor render resources,
  file/image reads, request cancellation and browser object URLs now have
  explicit feature or open-session ownership.
- AI Table, split into orchestration, editor, chart lifecycle, exporter, pure
  PDF builder, prompts and feature CSS. Chart instances, render bindings,
  object URLs, request cancellation and export sessions now have explicit
  owners. AI Document and AI Table share only the workbench primitives and the
  serialized request-session core.
- PDF Rotate, split into file/session orchestration, PDF.js preview ownership
  and export ownership. WebView drag listeners, loading/render tasks, PDF
  document handles, canvases, generated controls, object URLs and stale export
  writes now terminate at explicit feature or open-session boundaries.
- PDF Split, split into file/session orchestration, multi-document PDF.js
  preview and page-selection ownership, and single/batch export ownership.
  Native drag listeners, sortable rows, browser pickers, loading/render tasks,
  document handles, canvases, object URLs and stale export writes all have
  explicit owners while partial-save reporting remains compatible.
- PDF Merge, split into file/session orchestration, multi-document PDF.js
  preview and page-selection ownership, and export ownership. Pointer-sorted
  queue rows, native drag listeners, browser pickers, loading/render tasks,
  document handles, preview canvases, delayed completion, object URLs and stale
  export writes now terminate at explicit feature or open-session boundaries.
- PDF To Image, split into orchestration, PDF.js preview ownership, export
  ownership and modal/focus view state. Document revisions prevent stale loads
  from replacing or releasing a newer session; observers, render tasks,
  canvases, generated selection controls, native drag/progress listeners,
  native export sessions and browser object URLs all terminate at explicit
  boundaries. PPT To Image retains its existing restricted entry through the
  lazy instance's `openWithFile` contract.
- PDF Page Number, split into orchestration, page workspace, PDF/ZIP export and
  modal/focus view state. Every open creates an independent lifecycle session;
  native drag listeners, PDF.js loading/render tasks, document handles,
  observers, canvases, generated bindings, byte buffers and object URLs all
  terminate at that session boundary. Operation identity prevents a closed or
  superseded session from restoring loading state, publishing files or writing
  progress and success UI into a newer session.
- PDF Crop, split into orchestration, document ownership, page workspace,
  PDF/ZIP export and modal/focus view state. Each open owns native drag/drop and
  resize resources, while document and render owners release PDF.js loading
  tasks, page proxies, thumbnail/preview tasks, observers, canvases and source
  bytes. Operation identity prevents closed sessions from publishing output or
  writing progress and success state, and browser object URLs terminate at the
  exporter boundary.
- PDF Encrypt and PDF Decrypt, sharing a PDF security shell while retaining
  independent lazy entries and operation state. Each open owns its native
  WebView drag registration, password and success layers, file queue, focus and
  progress state. Registration races release `unlisten`, operation identity
  blocks stale UI writes, generated filenames use text nodes and browser
  encryption object URLs terminate with the owning open session. The existing
  encryption/decryption core modules remain compatibility owners for CLI
  resource staging and PDF Editor consumers.
- PDF Enhance, split into orchestration and processing modules while reusing the
  existing pure enhancement engine and render-plan core shared with CLI/MCP.
  Each open owns native drag/drop, generated queue bindings, focus, progress,
  PDF.js loading/render tasks, document handles, canvases, browser object URLs
  and native atomic-write sessions. Operation identity blocks closed or
  superseded sessions from publishing output or updating later UI, and the
  feature-owned compact-height rules keep its completion dialog reachable.
 - PDF Compress, split into queue/session orchestration and a native compression
  processor. The existing `compress_pdf` command and partial-failure semantics
  remain unchanged. Queue rendering uses text nodes and a disposable pointer
  sort scope; native drag/drop registration, progress state, success metadata,
  output-folder opening and operation identity are owned by the lazy feature.
  The historical result-drawer references were dead because the HTML never
   contained those nodes, so the real completion dialog remains the only result
   surface.
- PDF Editor now enters through the lazy registry instead of being statically
  initialized by `main.js`. Its bounded history, modal focus behavior,
  thumbnail queue/observer, drag sorting, cancellation identity, export
  assembly, document loading/cache/destruction, text-item grouping, visual text
  boxes, zoom scheduling, content editing, page selection, page mutations, file
  sessions, view state and canvas release helpers have feature-owned boundaries.
  The legacy UI orchestrator remains a compatibility owner for the remaining
  document/session wiring while later batches continue reducing it.

All other tool implementations remain legacy-owned until their batch is
validated. Presence in the lazy registry alone must never be interpreted as
proof that the overall migration is complete.

## Compatibility boundary

DOM IDs and `data-tool` values remain in `index.html` during the current phase.
The registry supplies existing shared callbacks to feature initializers. Native
invoke names, event names, storage keys and CLI/MCP registries remain unchanged.
Removing any compatibility path requires a repository-wide consumer audit and
a contract test in the same batch.

Escape is a two-level contract. A feature may consume Escape for a nested
dialog, cancellation or workspace close. The lazy registry schedules its
whole-tool close fallback after event propagation and only runs when the event
was not prevented by the active feature.

The existing AI provider request and JSON extraction helpers remain owned by
the legacy composition layer and are injected into migrated AI features. They
must move only after the remaining legacy AI callers share a tested provider
boundary. AI Document and AI Table CSS no longer live in `styles.css`: shared
workbench rules have one explicit owner and feature-specific rules load with
their lazy entries.
