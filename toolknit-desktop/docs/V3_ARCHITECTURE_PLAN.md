# ToolKnit Desktop V3 Architecture Plan

This plan complements `v3-architecture-baseline.md`. The migration preserves
the V2.3.1 product and public contracts while replacing monolithic ownership
with independently testable, lazy-loaded feature boundaries.

## Invariants

- Keep Vanilla JavaScript, Vite, Tauri 2 and Rust.
- Preserve the 65-tool desktop catalog, 12 categories, 46 MCP tools and every
  public Tauri, CLI, storage, DOM and event contract.
- Do not publish, sign, push, upgrade dependencies or change the version.
- Commit only validated local checkpoints and never commit generated output.

## Dependency direction

```text
app -> features -> shared/platform/core
features -> shared/platform/core
shared -> platform/core
platform -> Tauri/browser runtime
core -> no UI or platform runtime
```

Feature modules must not import `main.js`. The application registry loads a
feature only when its tool opens. A feature owns its listeners and resources
through the lifecycle scope and returns `open`, `close` and `dispose` methods.

## Migration phases

1. Freeze machine-readable public contracts and production metrics.
2. Establish lifecycle, lazy registry, platform adapter and shared UI seams.
3. Migrate every frontend tool in reversible vertical batches.
4. Reduce `main.js`, `styles.css` and `index.html` to composition and shell
   responsibilities, extracting feature markup only when runtime parity is
   protected by contract and browser tests.
5. Split Rust commands, services, models, security and Windows integration
   without changing command names or payloads.
6. Validate CLI/MCP resource staging from a clean temporary Git worktree.
7. Run release, Rust, security, browser, unsigned bundle and metric gates.

## Current execution checkpoint

The foundation and the first reversible frontend batches are complete:
developer toolbox, password generator, timestamp, calculator family, typing
test, text statistics, text formatting, AI polish and AI translation. The next
higher-risk frontend batch should migrate AI Document and AI Table while
preserving provider, project, editor, chart and export behavior. The shared
document reader remains a compatibility boundary until all consumers are
audited; native and CLI/MCP restructuring remains later-phase work.

## Batch gate

Each batch requires focused core and contract tests, architecture checks, a
production build, real open/close/reopen behavior, console inspection,
`git diff --check`, diff review and one local semantic commit. Full release
tests run after every tool-family batch and at final delivery.

## Completion rule

The migration is not complete until all feature families, native boundaries
and CLI/MCP packaging have been audited, all final gates pass, the initial
bundle is materially smaller and the final report accounts for every remaining
warning and manual Windows check.
