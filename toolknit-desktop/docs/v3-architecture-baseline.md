# ToolKnit Desktop V3 Architecture Baseline

This document freezes the verified V2.3.1 behavior and build surface before the
V3 modular migration. Run `node scripts/report-v3-architecture.mjs --json` for
the machine-readable inventory and `--check` for the preserved public counts.

## Git baseline

- Local branch: `codex/v3.0`
- Checkpoint: `bae3c98 fix: repair background removal model controls`
- Baseline worktree: clean
- Remote publishing is outside the migration scope

## Verified behavior baseline

- `npm run test:release`: passed all 61 release scripts
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 92 passed, 1 ignored
- The ignored test is the opt-in real LibreOffice Excel QA fixture
- Browser preview: home rendered without console warnings or errors
- Catalog: 65 unique desktop tools and 12 visible categories
- CLI/MCP: 46 MCP tool definitions remain a separate public catalog
- Native surface: 127 Tauri command implementations, 126 unique command names
  and 93 Rust tests across `src-tauri/src`

`system_cleanup_relaunch_as_admin` has separate Windows and non-Windows command
implementations behind `cfg`, which accounts for the one-name difference.

## Source baseline

| File | Physical lines | Bytes | Current responsibility |
| --- | ---: | ---: | --- |
| `src/main.js` | 32,605 | 1,627,526 | startup, settings, routing and most tools |
| `src/styles.css` | 37,200 | 1,096,776 | global, component and most tool styles |
| `index.html` | 10,687 | 784,677 | app shell plus almost every page and dialog |
| `src-tauri/src/lib.rs` | 18,595 | 700,348 | bootstrap, commands, services and Windows integration |

`index.html` contains 1,752 unique IDs with no duplicate IDs. The migration must
preserve those IDs until every consumer and contract test has moved to a stable
feature-owned selector.

## Production bundle baseline

| Asset | Bytes | Gzip |
| --- | ---: | ---: |
| main JavaScript | 2,811,765 | 841.76 kB |
| main CSS | 816,198 | 122.78 kB |
| index HTML | 784,455 | 104.78 kB |
| Markdown editor chunk | 1,003,856 | 345.58 kB |
| ExcelJS chunk | 929,563 | 256.44 kB |
| PDF worker | 2,383,409 | standalone worker |

The baseline build reports two ineffective dynamic-import paths: `pdf-lib` is
also statically reachable through PDF consumers, and `pdf-encrypt-core` is
statically reachable through `pdf-editor-core`. Several chunks exceed 500 kB.
Warnings remain non-blocking during migration, but the final graph must prove
that tool-only dependencies no longer enter the initial application chunk.

## Compatibility contracts

The machine inventory records the complete desktop tool IDs, literal storage
keys, frontend `invoke` names, frontend event names, Tauri command names and MCP
tool names. These names are public compatibility boundaries, not refactor
targets. Old source paths may use temporary compatibility exports while callers
move to `app`, `platform`, `core`, `shared` and `features`.

The following runtime behavior requires explicit ownership during migration:

- document/window listeners and Tauri event unlisten callbacks
- timeouts, intervals, workers, observers and animation frames
- Object URLs, Canvas state, AudioContext graphs and temporary files
- operation cancellation, process sets and shared native locks
- language, theme, font, background, output-root and model-source changes
- first dark paint, transparent-window clipping and special query-string entries

## Migration gates

Each stable batch must pass its focused JS/Rust tests and production build before
a local commit. Full release tests, full Rust tests, clean-worktree CLI packing,
the local unsigned Tauri build and the before/after bundle report are final gates.
Tests may move with their sources, but their assertions may not be removed or
weakened to accommodate the new layout.
