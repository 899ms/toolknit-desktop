# ToolKnit Desktop V3 Refactor Progress

Last updated: 2026-09-01

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

## Current verified counts

- 65 desktop tools in 12 visible categories.
- 127 Tauri command implementations and 126 unique command names.
- At least 93 Rust tests in `src-tauri/src`.
- 46 MCP tool definitions.
- No duplicate IDs in the static application HTML.

## Current source and bundle trend

| Metric | V2.3.1 baseline | After calculator family | After typing | After text tools | After AI text tools |
| --- | ---: | ---: | ---: | ---: | ---: |
| `src/main.js` lines | 32,605 | 31,110 | 30,627 | 29,737 | 28,639 |
| `src/styles.css` lines | 37,200 | 34,140 | 33,408 | 32,304 | 30,826 |
| Main JavaScript | 2,811.77 kB | 2,787.72 kB | 2,774.56 kB | 2,753.30 kB | 2,727.71 kB |
| Main CSS | 816.20 kB | 753.95 kB | 740.81 kB | 722.86 kB | 698.16 kB |

The text statistics feature emits a 10.39 kB JavaScript chunk and a 9.40 kB
CSS chunk. Text formatting emits a 7.18 kB JavaScript chunk and an 8.55 kB CSS
chunk. AI polish and translation now emit separate 10.73 kB and 12.27 kB
JavaScript chunks plus a shared 7.13 kB CSS chunk. The complete release gate
passed 69 npm scripts after mocked-provider browser regression and final diff
review.

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

## Next batches

1. Migrate the higher-risk AI Document and AI Table family while preserving
   provider, editor, chart, export and project persistence contracts.
2. Audit the remaining text-document consumers before deciding whether the
   compatibility reader can be removed.
3. Continue through remaining frontend families and reduce legacy entry files.
4. Split Rust ownership, then validate CLI/MCP packaging and final Windows
   behavior as defined in `V3_ARCHITECTURE_PLAN.md`.

Known non-blocking warnings remain the ineffective `pdf-lib` and
`pdf-encrypt-core` dynamic imports and chunks larger than 500 kB. No migration
batch may add a new warning or use these warnings as evidence of completion.
