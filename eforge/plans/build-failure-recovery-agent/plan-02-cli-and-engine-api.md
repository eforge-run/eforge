---
id: plan-02-cli-and-engine-api
name: CLI Subcommand + EforgeEngine.recover
depends_on:
  - plan-01-engine-core
branch: build-failure-recovery-agent/cli-and-engine-api
agents:
  builder:
    effort: medium
    rationale: Wires existing engine primitives (built in plan-01) into a public
      engine method and CLI subcommand. Mostly glue; medium effort is
      sufficient.
---

# CLI Subcommand + EforgeEngine.recover

## Architecture Context

This plan exposes the recovery primitives (built in plan-01) through a public `EforgeEngine.recover()` async-generator and a new `eforge recover <setName> <prdId>` CLI subcommand. Recovery is designed to run in a **clean subprocess** spawned by the daemon (plan-03), not inside the failed engine process. The CLI is the daemon's spawn target.

Key constraints:
- **Exit code semantics**: `0` for any verdict including `manual`; non-zero only on infrastructural error (state JSON missing, PRD file missing, git failure, etc.). A `manual` verdict is success.
- **No build permit consumption**: recovery is read-only and runs outside the build semaphore in `concurrency.ts`. No interaction with that module.
- **No side effects beyond sidecar**: no re-enqueue, no git ops on the failed branch, no queue mutations. The CLI writes the two sidecar files and exits.
- **Defensive parse fallback**: if the agent output cannot be parsed, the CLI writes a `manual` verdict sidecar with rationale referencing the parse error and exits 0. This guarantees the daemon-triggered subprocess always produces an artifact.

## Implementation

### Overview

1. Add `EforgeEngine.recover(setName, prdId, options)` as an async-generator on the engine class. Method orchestrates: `loadState(stateDir)` → `buildFailureSummary(...)` → `harness = registry.forRole('recovery-analyst')` → emit `recovery:start` → consume `runRecoveryAnalyst(...)` events (re-yielding) → on `recovery:complete` (or fallback to `manual` on `recovery:error`), call `writeRecoverySidecar(...)` → yield a final `recovery:complete` event carrying the sidecar paths.
2. Add `eforge recover <setName> <prdId>` subcommand in `packages/eforge/src/cli/index.ts`. Resolves the failed PRD path under `eforge/queue/failed/<prdId>.md`, instantiates `EforgeEngine.create(...)`, runs `engine.recover(setName, prdId, options)` through the existing event pipeline (`withMonitor`, `wrapEvents`, `runSession`, `consumeEvents`).
3. The CLI exits 0 even for `manual`. It exits non-zero only when the engine throws (state missing, PRD missing, git error). The fallback `manual` verdict path is implemented in the engine method, not the CLI.

### Key Decisions

1. **Engine method, not CLI-only logic.** Putting the orchestration on `EforgeEngine` lets future consumers (a daemon-internal call, a future MCP tool that bypasses subprocess spawn) reuse the flow. The CLI is the thin caller.
2. **Always produce a sidecar.** Parse failure → `manual` verdict + rationale. The daemon trigger relies on a sidecar always appearing.
3. **Reuse existing event plumbing.** `withMonitor`/`wrapEvents`/`runSession` already exists for `enqueue` etc.; recovery follows the same pattern. No new event-broadcast code.
4. **Resolve PRD path conventionally.** `eforge/queue/failed/<prdId>.md` per the existing layout. Fail clearly if the file is absent.

## Scope

### In Scope
- New `EforgeEngine.recover(setName, prdId, options)` async-generator method.
- New `eforge recover <setName> <prdId>` CLI subcommand with help text and option flags (e.g. `--cwd`, `--verbose`).
- Defensive parse-failure fallback that produces a `manual` verdict sidecar.
- Tests in `test/recovery.test.ts` (extending plan-01's file): full engine method round-trip with StubHarness, asserting sidecars are written and exit code semantics are honored at the boundary.

### Out of Scope
- Daemon HTTP route or subprocess spawning (plan-03).
- MCP / Pi parity (plan-03).
- Monitor UI (plan-04).
- Any change to `concurrency.ts` (recovery is outside the build semaphore by design).

## Files

### Modify
- `packages/engine/src/eforge.ts` — add public `recover(setName, prdId, options)` async-generator. Composes `loadState`, `buildFailureSummary`, `runRecoveryAnalyst`, `writeRecoverySidecar`. Implements the parse-failure → `manual` fallback.
- `packages/eforge/src/cli/index.ts` — register `program.command('recover <setName> <prdId>')` with action handler matching the existing subcommand pattern (e.g. `enqueue`). Resolves PRD path, instantiates engine, drives events through `withMonitor` + `wrapEvents` + `runSession` + `consumeEvents`. Translates engine throws into non-zero exit codes; verdicts are always exit 0.
- `test/recovery.test.ts` — extend with `EforgeEngine.recover` integration tests using a temp directory: seed `eforge/queue/failed/<prdId>.md`, seed `.eforge/state.json` from fixture, seed a tiny git repo, drive with `StubHarness` for each verdict, assert both sidecars exist with expected JSON shape.

### Files to reuse
- `packages/engine/src/recovery/failure-summary.ts` (plan-01).
- `packages/engine/src/recovery/sidecar.ts` (plan-01).
- `packages/engine/src/agents/recovery-analyst.ts` (plan-01).
- `packages/engine/src/agent-runtime-registry.ts` `forRole('recovery-analyst')`.
- `packages/eforge/src/cli/run-session.ts` and the existing event-pipeline helpers used by `enqueue`.

## Verification

- [ ] `pnpm type-check` passes in both `packages/engine` and `packages/eforge`.
- [ ] `pnpm test` passes; new tests cover all four verdicts via `EforgeEngine.recover`.
- [ ] `pnpm build && node packages/eforge/dist/cli.js recover <setName> <prdId> --help` prints help text including the two positional arguments.
- [ ] Running the built CLI against a fixture failed PRD with a `StubHarness`-canned environment writes both `eforge/queue/failed/<prdId>.recovery.md` and `eforge/queue/failed/<prdId>.recovery.json`.
- [ ] CLI exits 0 when the verdict is `manual` (asserted in a test that drives the parse-failure fallback path).
- [ ] CLI exits non-zero when `eforge/queue/failed/<prdId>.md` does not exist (asserted by a test that omits the fixture file).
- [ ] No imports of `concurrency.ts` introduced by this plan (grep assertion in test or review).
- [ ] Engine `recover` does not enqueue, modify the queue, or mutate any file outside the two sidecar paths (asserted by snapshotting the working directory before/after in test).
