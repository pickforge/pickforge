# Alpha 2 isolation integration report

Validated on 2026-09-04 against the combined tree for PR #92.

## Integrated heads

- PR #92 source head: `9153ba85084081531a594c8d0e89845ef5e3aeb3`
- `origin/main` with merged PR #91: `cc7cc0215b30e3d7d52994cb9c88463e94d0a3b3`

## Conflict and interaction review

- `packages/core/src/session.ts` keeps the desktop runtime and containment scope in the session record while using PR #91's verified `RunHandle` to finalize and render evidence. Session destruction no longer reconstructs an evidence path after verification.
- Core run creation, active pointers, journal writes, reports, screenshots, MCP evidence, browser DevTools evidence, and takeover evidence all retain PR #91's descriptor-bound run directory flow.
- Desktop launch and exec still receive the session runtime and containment scope. Screenshot capture now stages outside the run and publishes through the verified run handle without weakening containment.
- Browser session lifecycle and process identity cleanup remain separate from run storage. Browser evidence now passes verified run handles through the same descriptor-bound evidence path.
- Release notes retain both the isolation/containment changes and run-storage hardening.

## Validation

- Storage swap focus: 47 passed
  - `bun run test packages/core/test/run-dir-swap.test.ts packages/core/test/run-root.test.ts packages/core/test/dir-handle.test.ts`
- Cgroup and process ownership focus: 53 passed
  - `bun run test packages/core/test/containment-cgroup-sim.test.ts packages/core/test/containment.test.ts packages/core/test/proc-owned-daemon.test.ts`
- Forced marker, desktop, and browser focus: 295 passed, 11 skipped cgroup-only or optional cases
  - `PICKFORGE_CONTAINMENT=marker bun run test packages/core/test/containment.test.ts packages/desktop-linux/test packages/browser/test`
- Full TypeScript suite: 1,313 passed, 4 skipped
  - `bun run test`
- Coverage suite: 1,313 passed, 4 skipped
  - Statements 83.97%, branches 86.82%, functions 90.35%, lines 83.97%
  - `bun run test:coverage`
- TypeScript gates passed:
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
- Rust gates passed, 86 tests:
  - `cargo fmt --check`
  - `cargo clippy --workspace --all-targets --locked -- -D warnings`
  - `cargo test --workspace --locked`
- Changed-code complexity gate passed:
  - `complexity-gate check --changed`

## Issues

None found in the combined tree.
