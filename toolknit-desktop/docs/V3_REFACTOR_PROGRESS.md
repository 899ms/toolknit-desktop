# ToolKnit Desktop V3 Refactor Progress

Last updated: 2026-09-02

## Local checkpoints

| Commit | Result |
| --- | --- |
| `74668ea` | Frozen architecture and behavior baseline |
| `802ebb8` | Added lifecycle, lazy registry, platform and shared foundations |
| `5247547` | Migrated developer toolbox family |
| `68674a2` | Migrated password generator |
| `74feba3` | Migrated timestamp calculator |
| `20b7751` | Migrated BMI, mortgage and interest calculator family |
| `f20233c` | Migrated typing test and removed its stale global audio disposer |
| `3fbbffa` | Migrated text statistics, text formatting and shared document reading |
| `e141ee2` | Migrated AI polish and AI translation with shared lifecycle ownership |
| `0b795c7` | Migrated AI Document orchestration, editor, preview and PDF export |
| `c048232` | Migrated AI Table, shared AI request lifecycle and AI workbench CSS ownership |
| `048f09e` | Migrated PDF Rotate preview, export and native drag/drop lifecycle |
| `2a5ab48` | Migrated PDF Split preview, page selection, export and sortable queue lifecycle |
| `99e66e6` | Migrated PDF Merge preview, page selection, pointer sorting and export lifecycle |
| `c4796fe` | Preserved feature-owned Escape handling ahead of the lazy registry fallback |
| `5fd1d12` | Migrated PDF To Image preview, page selection, export and cancellation lifecycle |
| `33287cf` | Migrated PDF Page Number workspace, PDF/ZIP export and responsive lifecycle |
| `85d87f9` | Migrated PDF Crop workspace, document, PDF/ZIP export and responsive lifecycle |
| `9397d78` | Migrated PDF Encrypt/Decrypt shared shell, password flow and lifecycle ownership |
| `6223bb5` | Migrated PDF Enhance rendering, atomic output and lifecycle ownership |
| `3edb97c` | Migrated PDF Compress queue, native compression processing and lifecycle ownership |
| `d7a8776` | Isolated PDF Editor bounded history and transaction locking |
| `427f11d` | Lazy-loaded PDF Editor and isolated focus, thumbnail and render-resource ownership |
| `d63f21d` | Isolated the native AI provider command and its security tests |
| `a55ae27` | Isolated PDF Editor assembly, font loading and output publication |
| `4bcb075` | Isolated PDF Editor document loading, caching and PDF.js cleanup ownership |
| `1540ef2` | Isolated PDF Editor text grouping and visual-box calculations |
| `6b02cd6` | Isolated PDF Editor zoom state, anchor scrolling and scheduling lifecycle |
| `485f6f9` | Isolated PDF Editor text/component DOM rendering and injected interaction bindings |
| `85cbc37` | Isolated PDF Editor component state, transforms and snap geometry |
| `c7b9db9` | Isolated PDF Editor main preview rendering and canvas lifecycle |
| `3850445` | Isolated PDF Editor component controls, shape panel and resize handles |
| `94a6b23` | Isolated PDF Editor image-insert validation and decode boundaries |
| `3e8499f` | Isolated PDF Editor component drag, resize, rotate and pointer cleanup |
| `478da43` | Normalized PDF Editor proxy formatting after the interaction split |
| `1310525` | Isolated PDF Editor content editing, insertion flow and lifecycle regression coverage |
| `edd6649` | Isolated PDF Editor page operations and resource-safe mutation coverage |
| `45590d2` | Isolated PDF Editor file selection, replacement and append sessions |

## Current verified counts

- 65 desktop tools in 12 visible categories.
- 27 of 65 desktop tools have completed migration batches (**41.5%** coverage).
- 127 Tauri command implementations and 126 unique command names.
- At least 93 Rust tests in `src-tauri/src`.
- 46 MCP tool definitions.
- No duplicate IDs in the static application HTML.

## Current source and bundle trend

| Metric | V2.3.1 baseline | After calculator family | After typing | After text tools | After AI text tools | After AI Document | After AI Table | After PDF Rotate | After PDF Split | After PDF Merge | After PDF To Image | After PDF Page Number | After PDF Crop | After PDF Security | After PDF Enhance | After PDF Compress | After PDF Editor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `src/main.js` lines | 32,605 | 31,110 | 30,627 | 29,737 | 28,639 | 26,760 | 25,386 | 24,727 | 24,108 | 23,279 | 23,268 | 23,220 | 23,173 | 22,333 | 21,708 | 21,250 | 21,241 |
| `src/styles.css` lines | 37,200 | 34,140 | 33,408 | 32,304 | 30,826 | 30,826 | 27,871 | 27,863 | 27,821 | 27,821 | 27,426 | 27,425 | 27,425 | 27,182 | 27,165 | 27,059 |
| Main JavaScript | 2,811.77 kB | 2,787.72 kB | 2,774.56 kB | 2,753.30 kB | 2,727.71 kB | 2,668.75 kB | 2,629.94 kB | 2,616.60 kB | 2,604.02 kB | 2,588.64 kB | 2,555.41 kB | 2,554.76 kB | 2,554.15 kB | 2,536.30 kB | 2,299.67 kB | 2,288.63 kB | 1,839.13 kB |
| Main CSS | 816.20 kB | 753.95 kB | 740.81 kB | 722.86 kB | 698.16 kB | 698.16 kB | 650.32 kB | 650.17 kB | 649.33 kB | 649.33 kB | 642.84 kB | 622.70 kB | 603.27 kB | 599.37 kB | 599.03 kB | 597.52 kB |

The text statistics feature emits a 10.39 kB JavaScript chunk and a 9.40 kB
CSS chunk. Text formatting emits a 7.18 kB JavaScript chunk and an 8.55 kB CSS
chunk. AI polish and translation now emit separate 10.73 kB and 12.27 kB
JavaScript chunks plus a shared 7.13 kB CSS chunk. AI Document now emits an
approximately 60.17 kB JavaScript chunk and 31.37 kB feature CSS chunk. AI
Table emits an approximately 41.16 kB JavaScript chunk and 16.65 kB feature
CSS chunk; the two features share a 3.50 kB AI workbench CSS chunk. The complete
release gate passed 73 npm scripts after PDF Split emitted a 17.89 kB lazy
JavaScript chunk and 0.84 kB feature CSS chunk. PDF Merge now emits an 18.33 kB
lazy JavaScript chunk and 0.07 kB feature CSS chunk. Its notice, page picker,
selected-page export, all-page export, language refresh and repeated lifecycle
browser checks passed without console errors. The complete gate now passes 74
npm scripts, 530 security checks, `cargo check`, and 92 Rust tests with the one
external LibreOffice QA test ignored by design. Production output contains no
PDF Merge development fixture marker. PDF To Image now emits a 36.37 kB lazy
JavaScript chunk and a 6.49 kB feature CSS chunk. Its four-page fixture covers
lazy previews, selection, browser export cancellation, feature-owned Escape
handling and close/reopen cleanup. The complete gate now passes 75 npm scripts,
541 security checks, `cargo check`, and 92 Rust tests with the same external
LibreOffice QA ignored. Production output contains neither PDF To Image fixture
query nor fixture filename.
PDF Page Number now emits a 20.23 kB feature CSS chunk and independently owns
page loading, preview rendering, sorting, deletion/undo, PDF export, ZIP export,
focus and cancellation state. Its four-page fixture covers selection, custom
ranges, PDF and ZIP output, cancellation, two-level Escape handling, language
refresh and four close/reopen cycles at desktop and narrow sizes. The complete
gate now passes 76 npm scripts, 545 security checks, `cargo check`, and 92 Rust
tests with the same external LibreOffice QA ignored. Production output contains
no PDF Page Number fixture marker.
PDF Crop now emits an approximately 30.76 kB lazy JavaScript chunk and 20.18 kB
feature CSS chunk. Its four-page fixture covers rotated previews, all/current
page scopes, margin editing, undo/redo, PDF and ZIP export, language refresh and
four close/reopen cycles at desktop and compact window sizes. The complete gate
now passes 77 npm scripts and 544 security checks; `cargo check` passes and 92
Rust tests pass with the external LibreOffice QA test ignored by design.
Production output contains no PDF Crop fixture query or fixture filename.
PDF Encrypt and PDF Decrypt now emit separate approximately 4.47 kB and 3.31
kB lazy entries, an 8.38 kB shared security shell chunk and a 3.97 kB shared
feature CSS chunk. Desktop and 480 by 360 browser checks cover file loading,
password visibility, all eight encryption permissions, internal dialog
scrolling, Escape ownership, browser encryption output, browser-only decrypt
feedback and repeated close/reopen cleanup without new console errors. The
complete gate now passes 78 npm scripts and 550 security checks; `cargo check`
passes and 92 Rust tests pass with the external LibreOffice QA test ignored by
design. Fresh production output contains no PDF security fixture query or
fixture filename.
PDF Enhance now emits an approximately 19.85 kB lazy JavaScript chunk and a
0.78 kB feature CSS chunk. Its deterministic two-page fixture covers all three
strengths, browser processing, output metadata, feature-owned Escape handling,
three close/reopen cycles and a compact 480 by 360 completion flow. A clipped
compact-height completion dialog discovered during browser QA is now bounded
and scroll-safe. The complete gate passes 79 npm scripts and 555 security
checks; `cargo check` passes and 92 Rust tests pass with the external
LibreOffice QA test ignored by design. Production output contains no PDF
Enhance fixture query or fixture filename.

PDF Compress now emits an approximately 10.73 kB lazy JavaScript entry and a
0.49 kB feature CSS chunk. Its queue/session orchestrator preserves the
existing `compress_pdf` command, batch behavior and partial-failure semantics.
Native drag/drop, pointer sorting, progress state, success metadata,
output-folder opening and operation identity are scoped to the active session.
Queue text uses safe nodes. The historical result-drawer references were dead
because no drawer DOM existed in either HTML version; they were removed while
retaining the visible completion dialog. Compact-height rules keep the workspace
scrollable and the completion dialog bounded at 480 by 360.

The native AI provider now lives in `src-tauri/src/ai_provider.rs`; `lib.rs`
retains only module registration and public command wiring. Its endpoint,
request-size and response-size security tests remain unchanged, and the
command inventory is back to 127 implementations and 126 unique names. The
current PDF Editor batch moves PDF assembly, font loading, browser/native
output publication and operation-guarded success state into a dedicated
exporter; the existing state contract now checks the moved export-field
construction in that module.

The PDF Editor document store now owns PDF.js loading tasks, document caching,
same-source load de-duplication, generation invalidation and close/dispose
cleanup. Replacement loading still stages and validates the new document
before the existing editor state is reset; the document contract test protects
that ordering and stale-load destruction.

PDF Editor text-item grouping, line construction, source/replacement/inserted
visual boxes and PDF-to-viewport rectangle conversion now live in a 163-line
UI-independent layout module. Its executable regression test covers ordering,
line separation, style inference, coordinate inversion, box precedence and
inserted-text width fallback. After the subsequent zoom extraction, the legacy
UI orchestrator is now 3,591 lines and no longer owns or duplicates those
calculations.

PDF Editor zoom mode, manual scale, wheel normalization, button repeat timers,
preview transforms, anchor-preserving scroll offsets and scheduled render
requests now live in a dedicated lifecycle controller. It invalidates stale
zoom requests on reset/dispose and is covered by an executable contract test
for fit/manual transitions, frame commits, scroll anchoring, cancellation and
button cleanup.

PDF Editor text-layer and inserted-component DOM rendering now lives in
`src/features/pdf-editor/component-renderer.js`. The renderer owns text masks,
edited and inserted text, inserted images and shapes, generated selection
handles, accessibility state and render-time event bindings. Selection,
mutation, drag/resize sessions and component-menu updates remain injected from
the compatibility orchestrator. The state contract now reads the renderer
source directly and asserts that the legacy UI only delegates rendering.

PDF Editor component identity, collection lookup, text-edit entry creation,
rotation normalization, component transforms, resize-independent box geometry,
alignment target collection and snap deltas now live in
`src/features/pdf-editor/component-model.js`. The module receives state through
getters and reports changed state through an injected callback, so undo/redo can
replace collections without stale references and the model remains DOM-free.
Its regression suite covers identity, rotation snapping, text-layout equality,
object transforms and alignment snapping.

PDF Editor main-page rendering now lives in `src/features/pdf-editor/preview.js`.
The controller owns PDF.js page/render tasks, epoch invalidation, detached
candidate canvases, device-pixel scaling, text-content cache refresh and main
canvas disposal. The UI injects document/page access, zoom state and component
layer callbacks while retaining the existing DOM and public behavior. A
deterministic preview lifecycle test covers first paint, text caching, canvas
commit, task cancellation and disposal.

PDF Editor floating component controls now live in
`src/features/pdf-editor/component-controls.js`. Menu and shape-panel
positioning, shape property synchronization, SVG construction and generated
resize handles are owned by this controller; selection and pointer mutation
remain injected from the UI orchestrator. Its regression suite covers menu and
panel visibility, bounded stroke edits, SVG output and line/box handle counts.

PDF Editor image insertion validation now lives in
`src/features/pdf-editor/insert-assets.js`. PNG/JPEG header inspection,
pixel-limit enforcement and browser decode URL cleanup are independently
testable and are called by the existing insertion flow without changing file
type, size or output behavior. The boundary suite covers valid and malformed
headers, oversized dimensions and decode cleanup.

PDF Editor component pointer interaction now lives in
`src/features/pdf-editor/component-interaction.js`. Drag, resize and rotate
sessions own their pointer listeners and transient state, while a single
`reset()` path is used by undo/redo, mode changes, document reset and dispose.
The interaction suite covers snap-aware drag deltas, rotation updates,
resize geometry, history commits and listener cleanup.

PDF Editor content editing now lives in `src/features/pdf-editor/content-editing.js`.
Text insertion, image insertion and validation, shape insertion, canvas
placement, source-text editing, inserted-text editing and modal cancellation
are coordinated through injected state accessors. Image backing bytes remain
owned by the editor store and their preview URL remains alive after placement;
shape placement writes the updated collection back through the same state
boundary. The lifecycle suite covers text/image/shape placement, image backing
storage, both edit modes, modal cancellation and history commits.

## Hidden issues fixed during migration

- BMI validation dialogs are sibling overlays and must not be queried only from
  the tool overlay.
- Mortgage and interest responsive rules had mixed ownership; the shared rules
  now load with the owning mortgage feature.
- The old global unload handler retained a call to the migrated typing audio
  disposer. The typing feature now exclusively owns and closes its AudioContext.
- The former text-tool Tauri drag registrations never retained their native
  `unlisten` callbacks. Shared document drop ownership now releases them.
- Document reads could finish after a tool closed and update stale UI. Each
  migrated text feature now invalidates pending reads on close.
- PDF Editor shape placement previously mutated a local array without writing
  it back through the orchestration state boundary. The content-editing
controller now commits the updated shape collection, with a regression test
covering the placement path.

PDF Editor page mutations now live in `src/features/pdf-editor/page-operations.js`.
Rotation, ordering, page duplication, blank-page creation and deletion are
kept outside the UI orchestrator while the existing document/source stores,
selection state, rendering callbacks and history boundary are injected. Page
duplication preserves text edits and inserted content; deleting inserted images
also removes their backing byte entry and revokes preview URLs. The page
operation suite covers mutation order, copied edits/content, resource release,
blank-page creation and history/progress behavior.

PDF Editor current-page and selection state now lives in
`src/features/pdf-editor/page-selection.js`. Current-page fallback, document
order target resolution, single/toggle/range selection, select-all, inversion
and cross-page component clearing are tested independently while thumbnail
rendering remains owned by the thumbnail controller.

PDF Editor file selection and document mutation sessions now live in
`src/features/pdf-editor/file-session.js`. Browser/Tauri file picking, bounded
file reads, staged replacement loading, append validation, source/page ID
allocation, progress/error publication and clean commit ordering are injected
through the orchestrator. A file-session suite covers replacement staging,
invalid-file preservation, append output state and picker behavior.
- A copy-feedback timer could restore a pre-switch language label after global
  translation completed. Language changes now cancel that stale timer.
- AI polish and translation previously retained native drag listeners for the
  entire application lifetime. Each open session now owns and releases its
  Tauri `unlisten` callback.
- AI requests and document reads could finish after close and write into stale
  overlays. Abort controllers, request IDs and lifecycle revision tokens now
  prevent those writes.
- AI Document used `fadeInUp` from the former global AI text block. Its own
  global animation contract is now retained so opening AI Document first does
  not depend on another lazy tool's CSS.
- AI Document generated click targets, editor document listeners, drag/resize
  listeners, image readers and image callbacks previously had mixed global and
  transient ownership. Feature, open-session and render scopes now dispose
  each resource at the matching boundary.
- AI Document requests could retain busy state or deliver stale output after a
  close, reset or timeout. A deterministic request session now serializes work,
  aborts invalidated requests and makes timeout state testable.
- Closing AI Document now removes transient chat, input, preview, editor and
  mask state. Repeated development-fixture reloads retain one editor page, one
  preview page and two initial chat messages without accumulating bindings.
- AI Table PDF export referenced an AI Document font byte variable that did not
  belong to the table feature. The exporter now loads and supplies its own
  bounded font resource to a pure PDF builder.
- AI Table attempted to call a nonexistent global user-avatar helper. Its
  initializer now has an injected hook with a safe module-local default.
- CSV export unnecessarily waited for chart rendering. Data-only export is now
  independent of chart lifecycle, while image exports retain explicit waits.
- AI Table editor and exporter disposal previously depended on method `this`
  binding. Their returned lifecycle functions are now safe when passed by
  reference.
- Shared AI animations and their keyframes had split ownership. The shared
  chat rules, animation contract and keyframes now load from one lazy CSS owner.
- AI request cleanup could let a stale request disposer cancel a newer request
  after reset. Shared serialized sessions now support request-specific cancel,
  and completed lifecycle registrations release themselves immediately.
- The first AI Document CSS extraction was still 1,895 lines. It is now split
  into a 919-line generation shell and a 978-line editor overlay while
  preserving production cascade order.
- PDF Rotate registered native WebView drag/drop for the application lifetime
  and never retained its `unlisten` callback. Each open session now owns and
  releases that callback.
- PDF.js loading, page-render tasks, document handles and preview canvases had
  mixed cleanup. The preview owner now cancels or destroys every resource when
  the workspace or tool closes.
- Generated rotate/download buttons previously bound unmanaged listeners and
  the file queue used HTML interpolation. Render scopes now own those bindings,
  and filenames are inserted through text nodes.
- Export progress could outlive a closed tool and update stale masks or success
  dialogs. Export sessions now use owner and operation IDs before progress,
  file publication and result UI writes.
- The PDF worker URL initially appeared removable with the Rotate block, but a
  repository-wide search found several legacy PDF consumers. The main import
  is intentionally retained until those consumers migrate; Rotate itself owns
  its worker import inside the lazy feature.
- A deterministic three-page development fixture now covers PDF Rotate without
  a system file picker. Production output was scanned to confirm the fixture
  query and filename are eliminated from release chunks.
- PDF Split registered native WebView drag/drop for the application lifetime
  without retaining `unlisten`. Its open session now releases the callback,
  including the registration race where the tool closes before registration
  resolves.
- PDF Split preview loading and rendering did not retain the active PDF.js
  render task, and generated selection/download controls had unmanaged event
  bindings. The preview owner now cancels loading and render work, destroys all
  document handles, clears canvases and disposes every render binding.
- PDF Split export could continue writing progress or showing success after the
  tool closed. Export sessions now guard every publication and UI write with
  owner and operation IDs while retaining the existing partial-save behavior.
- The file queue used HTML interpolation and recreated sortable listeners
  without an explicit owner. Filenames now use text nodes, and a reusable
  sortable-file-list helper binds every row listener to its render scope.
- Browser file pickers and generated object URLs now have explicit disposal,
  while processing-state guards prevent queue mutation during active work.
- A deterministic two-file, three-page development fixture exercises page
  selection, single export, selected-page export, language refresh and repeated
  open/process/close cycles. Production chunks contain no fixture query or
  filename.
- PDF Merge previously kept its WebView drag listener for the application
  lifetime and mixed native file drops with pointer queue sorting. The open
  session now releases the native listener, while a shared pointer-sort owner
  guards the short post-sort interval from being interpreted as a file drop.
- PDF Merge loading tasks, PDF.js documents, page render tasks, canvases and
  generated page listeners previously had mixed ownership. The preview owner
  now cancels or destroys them when the selection flow or tool closes.
- Merge completion used an unmanaged delay and could publish stale progress or
  success UI after the tool closed. Export sessions now guard every write with
  owner and operation IDs; browser object URLs are retained briefly for the
  download and revoked by the same owner.
- PDF Merge queue rows previously interpolated filenames into HTML and rebound
  unmanaged pointer listeners. Rows now use text nodes and a disposable render
  scope without changing the existing queue DOM contract.
- A deterministic two-file, three-page PDF Merge fixture covers multi-page
  notice, picker selection, all-page export, language switching and four
  open/close cycles. Production chunks contain no fixture query or filename.
- The lazy registry previously closed an active feature immediately on Escape,
  before a feature-level progress or success dialog could consume the key. Its
  fallback now runs after event propagation and respects `defaultPrevented`, so
  PDF To Image cancels the active operation without closing the tool.
- A completed stale PDF.js loading task could assign its document after the
  tool had closed, then release a newer session's document from the old error
  path. PDF To Image now uses a document revision guard, destroys stale results
  before assignment and lets only the current operation clear shared preview
  state.
- PDF To Image previously mixed PDF.js tasks, preview observers, canvases,
  generated selection listeners, native progress listeners, browser object
  URLs and native export sessions in one application-lifetime module. Preview,
  exporter and view owners now release each resource at its matching boundary,
  including native drag registration that resolves after close.
- Closing PDF To Image during work now marks the old operation silent, invokes
  the dedicated `cancel_pdf_to_image` contract, discards partial native sessions
  and prevents stale progress, success dialogs and preview restarts.
- The PPT To Image bridge now opens the lazy PDF To Image instance and preserves
  its existing `allowLongExport: false` contract. The old static initializer and
  duplicated tool-card listener are removed.
- PDF Page Number previously mixed application-lifetime initialization with
  page workspace, PDF.js tasks, native drag/drop, generated controls and export
  state. Each open now owns an independent session, and operation identity
  prevents a closed session from restoring snapshots or writing progress and
  results into a later open.
- PDF Page Number page loading and rendering now release loading tasks, render
  tasks, document handles, observers, canvases and byte buffers. File names are
  inserted with text nodes, and generated controls are released with their
  render scope.
- At widths below 780px the legacy settings layout could collapse its internal
  scroll area to zero and cover the PDF/ZIP controls. The feature stylesheet now
  gives the narrow settings workspace bounded rows, outer scrolling and a 480px
  minimum height; its contract and browser checks protect that layout.
- PDF Crop previously combined application-lifetime listeners, native WebView
  drag/drop, PDF.js loading/rendering, generated thumbnails, page state and
  export publication in one module. Feature, open-session, document, thumbnail
  and exporter owners now release each resource at the matching boundary.
- Closing PDF Crop during load or export could allow an old asynchronous path
  to restore progress or success UI after a later open. Operations now carry
  owner identity, cancel or destroy active PDF.js work, and detach before the
  workspace is reset.
- PDF Crop thumbnail and preview work now cancel render tasks, disconnect
  observers, destroy document handles, clear canvases and release source bytes.
  Generated labels use text nodes, and browser object URLs are revoked by the
  exporter owner.
- At a 480 by 360 window the legacy crop grid left almost no usable preview
  height. Compact-height rows and filmstrip sizing now preserve a scrollable
  preview, with a contract assertion and browser verification protecting the
  layout.
- PDF Encrypt and PDF Decrypt previously registered WebView drag/drop for the
  application lifetime and discarded the returned `unlisten`. Each open now
  owns and releases its registration, including the race where the tool closes
  before registration resolves.
- Encrypt and decrypt previously duplicated file queues, password/success
  layers, progress state and close cleanup in the global entry. A shared shell
  now owns those lifecycle boundaries while each operation keeps independent
  encryption or decryption state and the existing public invoke contracts.
- The first migrated invalid-password path tried to reopen the decrypt password
  layer before clearing the busy operation, so the shell correctly rejected
  the reopen. Reopening now occurs after operation cleanup, and the contract
  test protects that sequencing.
- Generated PDF security queue rows now insert filenames with text nodes.
  Browser encryption object URLs are revoked by the same open-session owner,
  and operation identity prevents a closed session from writing progress or
  success state into a later open.
- PDF Enhance previously kept its native WebView drag registration for the
  application lifetime and mixed PDF.js loading, page rendering, canvases,
  output writing and result UI in `main.js`. Its open session and processor now
  release every resource, including a drag registration that resolves after
  close and a partially written native output.
- PDF Enhance previously duplicated the shared enhancement algorithms inside
  `main.js`. Desktop and CLI/MCP processing now use the same tested engine and
  render-plan core, including the corrected unit-gain 5x5 sharpening kernel.
- Closing PDF Enhance during asynchronous work could previously leave renders
  and output publication alive. Operation identity, PDF.js task destruction,
  canvas release and atomic write-session discard now prevent stale output and
  stale UI writes.
- The shared completion dialog exceeded a 360px-high viewport after its content
  settled. Feature-owned compact-height sizing now keeps its content and both
  actions reachable without changing the shared dialog used by other tools.
- PDF Compress previously kept an application-lifetime native drag listener,
  used unmanaged queue row listeners and rendered filenames through HTML
  interpolation. The lazy feature now owns the drop registration, pointer
  sorting, queue render scope and operation identity; output paths and success
  metadata are updated only by the current open session.
- PDF Compress referenced a result drawer whose DOM nodes never existed in the
  current or historical HTML. The dead references and global styles were
  removed, and the visible completion dialog remains the single result surface.
- The shared PDF minimum-height rules pushed the compression action deep below
  a 480 by 360 viewport. Compact-height feature rules now bound the poster and
  workspace while preserving internal scrolling and completion-dialog access.

## Next batches

1. Continue PDF Editor component-editing ownership, then audit the remaining
   PDF template ownership and select the next coherent legacy candidate by
   lifecycle risk, dependency weight and compatibility scope.
2. Recheck PDF Merge pointer sorting and native-drop suppression in the local
   Windows WebView build; browser pointer automation did not reproduce a queue
   move, so this remains an explicit manual parity check rather than a claimed
   browser result.
3. Audit the remaining text-document consumers before deciding whether the
   compatibility reader can be removed.
4. Continue through remaining frontend families and reduce legacy entry files.
5. Split Rust ownership, then validate CLI/MCP packaging and final Windows
   behavior as defined in `V3_ARCHITECTURE_PLAN.md`.

Known non-blocking warnings remain the browser externalization notice for the
`crypto` import inside `pdf-lib-plus-encrypt` and chunks larger than 500 kB.
The former ineffective `pdf-encrypt-core` and `pdf-lib` dynamic-import warnings
disappeared with the PDF Security and PDF Enhance migrations respectively. No
migration batch may add a new warning or use these warnings as evidence of
completion.
