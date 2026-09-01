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

## Current verified counts

- 65 desktop tools in 12 visible categories.
- 127 Tauri command implementations and 126 unique command names.
- At least 93 Rust tests in `src-tauri/src`.
- 46 MCP tool definitions.
- No duplicate IDs in the static application HTML.

## Current source and bundle trend

| Metric | V2.3.1 baseline | After calculator family | After typing | After text tools | After AI text tools | After AI Document | After AI Table |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `src/main.js` lines | 32,605 | 31,110 | 30,627 | 29,737 | 28,639 | 26,760 | 25,386 |
| `src/styles.css` lines | 37,200 | 34,140 | 33,408 | 32,304 | 30,826 | 30,826 | 27,871 |
| Main JavaScript | 2,811.77 kB | 2,787.72 kB | 2,774.56 kB | 2,753.30 kB | 2,727.71 kB | 2,668.75 kB | 2,629.94 kB |
| Main CSS | 816.20 kB | 753.95 kB | 740.81 kB | 722.86 kB | 698.16 kB | 698.16 kB | 650.32 kB |

The text statistics feature emits a 10.39 kB JavaScript chunk and a 9.40 kB
CSS chunk. Text formatting emits a 7.18 kB JavaScript chunk and an 8.55 kB CSS
chunk. AI polish and translation now emit separate 10.73 kB and 12.27 kB
JavaScript chunks plus a shared 7.13 kB CSS chunk. AI Document now emits an
approximately 60.17 kB JavaScript chunk and 31.37 kB feature CSS chunk. AI
Table emits an approximately 41.16 kB JavaScript chunk and 16.65 kB feature
CSS chunk; the two features share a 3.50 kB AI workbench CSS chunk. The complete
release gate passed 71 npm scripts after AI Table and AI Document browser
regression, full Rust tests and final diff review.

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
