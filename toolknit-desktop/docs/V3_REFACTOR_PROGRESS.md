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

## Current verified counts

- 65 desktop tools in 12 visible categories.
- 127 Tauri command implementations and 126 unique command names.
- At least 93 Rust tests in `src-tauri/src`.
- 46 MCP tool definitions.
- No duplicate IDs in the static application HTML.

## Current source and bundle trend

| Metric | V2.3.1 baseline | After calculator family | Typing batch candidate |
| --- | ---: | ---: | ---: |
| `src/main.js` lines | 32,605 | 31,110 | 30,627 |
| `src/styles.css` lines | 37,200 | 34,140 | 33,408 |
| Main JavaScript | 2,811.77 kB | 2,787.72 kB | 2,774.56 kB |
| Main CSS | 816.20 kB | 753.95 kB | 740.81 kB |

The typing candidate emits a 12.91 kB JavaScript chunk and a 13.14 kB CSS
chunk. Its complete release gate passed 67 npm scripts before final diff review.

## Hidden issues fixed during migration

- BMI validation dialogs are sibling overlays and must not be queried only from
  the tool overlay.
- Mortgage and interest responsive rules had mixed ownership; the shared rules
  now load with the owning mortgage feature.
- The old global unload handler retained a call to the migrated typing audio
  disposer. The typing feature now exclusively owns and closes its AudioContext.

## Next batches

1. Migrate the text statistics and text formatting family.
2. Continue through remaining frontend families and reduce legacy entry files.
3. Split Rust ownership, then validate CLI/MCP packaging and final Windows
   behavior as defined in `V3_ARCHITECTURE_PLAN.md`.

Known non-blocking warnings remain the ineffective `pdf-lib` and
`pdf-encrypt-core` dynamic imports and chunks larger than 500 kB. No migration
batch may add a new warning or use these warnings as evidence of completion.
