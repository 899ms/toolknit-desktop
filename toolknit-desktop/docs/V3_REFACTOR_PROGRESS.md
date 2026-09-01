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

## Current verified counts

- 65 desktop tools in 12 visible categories.
- 127 Tauri command implementations and 126 unique command names.
- At least 93 Rust tests in `src-tauri/src`.
- 46 MCP tool definitions.
- No duplicate IDs in the static application HTML.

## Current source and bundle trend

| Metric | V2.3.1 baseline | After calculator family | After typing | After text tools | After AI text tools | After AI Document | After AI Table | After PDF Rotate | After PDF Split |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `src/main.js` lines | 32,605 | 31,110 | 30,627 | 29,737 | 28,639 | 26,760 | 25,386 | 24,727 | 24,108 |
| `src/styles.css` lines | 37,200 | 34,140 | 33,408 | 32,304 | 30,826 | 30,826 | 27,871 | 27,863 | 27,821 |
| Main JavaScript | 2,811.77 kB | 2,787.72 kB | 2,774.56 kB | 2,753.30 kB | 2,727.71 kB | 2,668.75 kB | 2,629.94 kB | 2,616.60 kB | 2,604.02 kB |
| Main CSS | 816.20 kB | 753.95 kB | 740.81 kB | 722.86 kB | 698.16 kB | 698.16 kB | 650.32 kB | 650.17 kB | 649.33 kB |

The text statistics feature emits a 10.39 kB JavaScript chunk and a 9.40 kB
CSS chunk. Text formatting emits a 7.18 kB JavaScript chunk and an 8.55 kB CSS
chunk. AI polish and translation now emit separate 10.73 kB and 12.27 kB
JavaScript chunks plus a shared 7.13 kB CSS chunk. AI Document now emits an
approximately 60.17 kB JavaScript chunk and 31.37 kB feature CSS chunk. AI
Table emits an approximately 41.16 kB JavaScript chunk and 16.65 kB feature
CSS chunk; the two features share a 3.50 kB AI workbench CSS chunk. The complete
release gate passed 73 npm scripts after PDF Split emitted a 17.89 kB lazy
JavaScript chunk and 0.84 kB feature CSS chunk. PDF Split browser regression,
524 security checks, full Rust tests, production demo-hook scanning and final
diff review passed.

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

## Next batches

1. Select the next coherent frontend tool family from the remaining ownership
   inventory and migrate it through the same lifecycle and browser gate.
2. Audit the remaining text-document consumers before deciding whether the
   compatibility reader can be removed.
3. Continue through remaining frontend families and reduce legacy entry files.
4. Split Rust ownership, then validate CLI/MCP packaging and final Windows
   behavior as defined in `V3_ARCHITECTURE_PLAN.md`.

Known non-blocking warnings remain the ineffective `pdf-lib` and
`pdf-encrypt-core` dynamic imports and chunks larger than 500 kB. No migration
batch may add a new warning or use these warnings as evidence of completion.
