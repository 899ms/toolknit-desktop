# ToolKnit Desktop V3 Architecture Plan

This plan complements `v3-architecture-baseline.md`. The completed V3.0
migration preserved the V2.3.1 product and public contracts while replacing
monolithic ownership with independently testable, lazy-loaded feature
boundaries. The phase descriptions below are retained as the execution record.

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

All 65 desktop tools are now migrated into validated lazy feature boundaries or
shared feature-family boundaries. The app, platform, shared, core, feature and
style layers are in place; PDF Editor is a composition root over independently
owned document, preview, page, component, editing, export, event and lifecycle
modules. The native AI provider boundary, security checks, CLI/MCP staging and
clean-worktree package verification are complete. Compatibility forwards remain
only for existing import paths, while the public DOM, Tauri, storage, CLI and
MCP contracts are unchanged. The final release gate, full Rust suite, Vite
production build and unsigned Tauri bundle all pass.

## Batch gate

Each batch requires focused core and contract tests, architecture checks, a
production build, real open/close/reopen behavior, console inspection,
`git diff --check`, diff review and one local semantic commit. Full release
tests run at shared/platform/security boundaries and at final delivery; simple
tool batches use their focused gates unless evidence expands the impact area.

## Completion rule

The completion rule is satisfied on the local `codex/v3.0` branch: all feature
families and native boundaries are audited, the CLI/MCP package is installed and
called from a clean temporary Git worktree, all final gates pass, the initial
bundle is materially smaller, and the remaining build warnings plus manual
Windows checks are explicitly recorded in `V3_REFACTOR_PROGRESS.md`. No remote
publish, version change, signature or branch deletion is part of this local
checkpoint.
