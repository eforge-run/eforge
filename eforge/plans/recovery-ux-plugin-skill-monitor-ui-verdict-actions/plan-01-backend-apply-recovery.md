---
id: plan-01-backend-apply-recovery
name: Engine applyRecovery + Daemon Route + MCP/Pi Parity
branch: recovery-ux-plugin-skill-monitor-ui-verdict-actions/backend-apply-recovery
---

# Engine applyRecovery + Daemon Route + MCP/Pi Parity

## Architecture Context

The inline atomic recovery sidecar (commits 5ca8913, 2dbbd08, 5ceaae0) writes `<prdId>.recovery.md` and `<prdId>.recovery.json` next to the failed PRD whenever a build fails. The verdict (`retry | split | abandon | manual`) is generated and persisted, but no code path enacts the verdict — only `recover()` (analyze) and `apiReadRecoverySidecar` (read) exist today.

This plan adds the missing apply path:

- A new `applyRecovery()` async generator on `EforgeEngine` that reads the sidecar, validates the verdict, and dispatches to one of four verdict-specific helpers.
- Each mutating dispatch produces a single `forgeCommit` so the audit trail stays atomic.
- A new daemon route, shared client helper, and matching MCP tools (Claude Code + Pi) so all consumer surfaces have a single typed entry point.

The engine commit constraint is non-negotiable: every git mutation in this plan flows through `forgeCommit()` from `packages/engine/src/git.ts` (per AGENTS.md). The `recoveryVerdictSchema` from `packages/engine/src/schemas.ts:147` is the source of truth for verdict shape — do not duplicate it.

## Implementation

### Overview

Add a new engine method `applyRecovery(setName, prdId, options?)` that:

1. Reads `eforge/queue/failed/<prdId>.recovery.json` from disk.
2. Validates the parsed JSON against `recoveryVerdictSchema`.
3. Dispatches by `verdict.verdict` value to a helper in a new `packages/engine/src/recovery/apply.ts` module.
4. Yields `recovery:apply:start` / `recovery:apply:complete` (or `recovery:apply:error`) `EforgeEvent`s, mirroring the existing `recover()` event surface.
5. Returns a typed `ApplyRecoveryResult` containing the verdict that was applied and (for `split`) the new `successorPrdId`.

Wire that engine method through:

- `packages/client/src/routes.ts`: new `applyRecovery` entry in `API_ROUTES` plus `ApplyRecoveryRequest` / `ApplyRecoveryResponse` types.
- `packages/client/src/api/apply-recovery.ts`: new `apiApplyRecovery()` helper, mirroring `apiRecover()`.
- `packages/monitor/src/server.ts`: new `POST /api/recover/apply` handler, mirroring the validation + worker-spawn pattern of `POST /api/recover`.
- `packages/eforge/src/cli/mcp-proxy.ts`: new `eforge_apply_recovery` MCP tool.
- `packages/pi-eforge/extensions/eforge/index.ts`: mirrored Pi tool.
- `packages/eforge/src/cli/index.ts`: new `eforge apply-recovery <setName> <prdId>` subcommand so the daemon worker subprocess can run the engine method (mirrors how `eforge recover` is wired today).

### Key Decisions

1. **Single commit per dispatch.** Each verdict helper composes its full set of git operations (mv / rm / add) and finishes with one `forgeCommit()` that stages the relevant paths via the `paths` option or pre-staged index. No helper produces more than one commit.
2. **`retry` deletes sidecars from the working tree.** The audit trail lives in commit history. The helper performs `git mv eforge/queue/failed/<prdId>.md eforge/queue/<prdId>.md`, `git rm eforge/queue/failed/<prdId>.recovery.md eforge/queue/failed/<prdId>.recovery.json`, then `forgeCommit("recover(<prdId>): requeue per recovery verdict")`. Auto-build picks up the requeued PRD on the next tick — `applyRecovery()` does NOT call `enqueue()`.
3. **`split` leaves the failed PRD + sidecars in place.** The helper writes `verdict.suggestedSuccessorPrd` to `eforge/queue/<successorPrdId>.md`, `git add`s it, then commits with message `recover(<prdId>): enqueue successor <successorPrdId>`. The successor id is derived from the first markdown heading in the suggested PRD body (slugified, lowercased, kebab-cased); on collision with an existing queue file or with the failed prdId, append `-1`, `-2`, etc. until unique. Document this rule in a JSDoc comment on the helper.
4. **`abandon` removes the PRD + both sidecars.** Helper performs `git rm` on all three paths under `eforge/queue/failed/`, then `forgeCommit("recover(<prdId>): abandon per recovery verdict")`.
5. **`manual` is a no-op mutation.** Helper yields an `recovery:apply:complete` event with a flag indicating no action was taken; the caller is expected to surface guidance to read the report.
6. **Loud failures, not silent fallbacks.** If the sidecar JSON is missing: throw `Error('Recovery sidecar not found for <prdId>; run recover() first')`. If `verdict === 'split'` but `suggestedSuccessorPrd` is missing or empty: throw `Error('split verdict for <prdId> is missing suggestedSuccessorPrd')`. If verdict JSON fails Zod validation: throw with the Zod error pretty-printed.
7. **Path-segment validation reused.** Use the same `isValidPathSegment` check that `recover()` uses in `packages/engine/src/eforge.ts` around line 1813 — reject any setName / prdId containing path separators or `..`.
8. **Daemon handler mirrors `/api/recover` exactly.** Same `parseJsonBody`, same field validation, same `isValidPathSegment` check, same `workerTracker.spawnWorker()` shape — just with worker type `'apply-recovery'` and the new CLI subcommand wired up.
9. **No `DAEMON_API_VERSION` bump.** This is purely additive — no existing route signature changes.

## Scope

### In Scope

- New `packages/engine/src/recovery/apply.ts` module with four verdict-specific dispatch helpers.
- New `applyRecovery()` async generator on `EforgeEngine` in `packages/engine/src/eforge.ts`.
- New `applyRecovery` route, `ApplyRecoveryRequest`, `ApplyRecoveryResponse` types in `packages/client/src/routes.ts`.
- New `apiApplyRecovery()` helper in `packages/client/src/api/apply-recovery.ts`, exported from any existing API barrel file.
- New `POST /api/recover/apply` handler in `packages/monitor/src/server.ts`.
- New `eforge apply-recovery` CLI subcommand in `packages/eforge/src/cli/index.ts` (used by the daemon worker).
- New `eforge_apply_recovery` MCP tool in `packages/eforge/src/cli/mcp-proxy.ts`.
- New mirrored Pi tool in `packages/pi-eforge/extensions/eforge/index.ts`.
- New tests in `test/apply-recovery.test.ts` covering all four verdict dispatches plus the missing-sidecar and missing-successor error paths.

### Out of Scope

- Bumping `DAEMON_API_VERSION` (additive change, not breaking).
- Bumping `packages/pi-eforge/package.json` version (handled at npm publish).
- Any monitor UI changes (handled in `plan-02`).
- Any plugin skill or Pi skill files (handled in `plan-02`).
- Reimplementing `forgeCommit()`, `recoveryVerdictSchema`, `writeRecoverySidecar()`, `apiRecover`, or `apiReadRecoverySidecar`.
- Auto-applying verdicts; this plan only exposes the apply mechanism — confirmation is the caller's responsibility.

## Files

### Create

- `packages/engine/src/recovery/apply.ts` — Verdict dispatch helpers. Exports `applyRecoveryRetry`, `applyRecoverySplit`, `applyRecoveryAbandon`, `applyRecoveryManual`, plus a `deriveSuccessorPrdId(prdContent: string, queueDir: string, failedPrdId: string)` helper. Each mutating helper accepts `{ cwd, prdId, queueDir, modelTracker? }`, performs git ops via `exec` from `packages/engine/src/git.ts`, and finishes with a single `forgeCommit()` (using `composeCommitMessage` from `packages/engine/src/model-tracker.ts` so the trailer policy is honored even though no agent ran — pass an optional `modelTracker` so commits stay consistent with `moveAndCommitFailedWithSidecar`).
- `packages/client/src/api/apply-recovery.ts` — Mirrors `packages/client/src/api/recover.ts`: `export function apiApplyRecovery(opts: { cwd: string; body: ApplyRecoveryRequest }) { return daemonRequest<ApplyRecoveryResponse>(opts.cwd, 'POST', API_ROUTES.applyRecovery, opts.body); }`.
- `test/apply-recovery.test.ts` — Vitest suite with one `describe` per verdict. Builds a real git fixture (mirroring `test/recovery.test.ts` setup), seeds `eforge/queue/failed/<prdId>.md` plus both sidecar files, calls `engine.applyRecovery()`, then asserts post-conditions: working tree paths exist/don't exist, `git log -1` has the expected subject, and the verdict-specific return value is correct. Add error-path tests: missing sidecar throws with message containing `recover()`, split with no `suggestedSuccessorPrd` throws with message containing `suggestedSuccessorPrd`. Per AGENTS.md: no harness or git mocks.

### Modify

- `packages/engine/src/eforge.ts` — Add `applyRecovery(setName: string, prdId: string, options?: ApplyRecoveryOptions): AsyncGenerator<EforgeEvent, ApplyRecoveryResult>`. Read `eforge/queue/failed/<prdId>.recovery.json`, parse with `recoveryVerdictSchema`, validate path segments, then `switch` on `verdict.verdict` to call into `apply.ts` helpers. Yield `recovery:apply:start` before dispatch and `recovery:apply:complete` after. Wrap dispatch in try/catch; on caught error yield `recovery:apply:error` and rethrow. Place the method adjacent to `recover()` so navigation stays sensible.
- `packages/engine/src/events.ts` (or wherever `EforgeEvent` is declared) — Add three new event variants: `recovery:apply:start`, `recovery:apply:complete` (with `verdict`, optional `successorPrdId`, `noAction: boolean`), `recovery:apply:error` (with `prdId`, `message`). Keep the discriminated union exhaustive.
- `packages/engine/src/schemas.ts` — Add `applyRecoveryOptionsSchema` (Zod, allows future extension) and export `ApplyRecoveryOptions` and `ApplyRecoveryResult` types. `ApplyRecoveryResult = { verdict: RecoveryVerdictValue; successorPrdId?: string; noAction: boolean; commitSha?: string }`. Capture the post-commit sha via `git rev-parse HEAD` after each helper's commit so the daemon can echo it back.
- `packages/client/src/routes.ts` — Add `applyRecovery: '/api/recover/apply'` to `API_ROUTES`. Add `ApplyRecoveryRequest = { setName: string; prdId: string }` and `ApplyRecoveryResponse = { sessionId: string; pid: number }` (matching `RecoverResponse` shape since the daemon spawns a worker).
- `packages/client/src/api/index.ts` (if it exists as a barrel) — Re-export `apiApplyRecovery` from the new file. If no barrel exists, skip this.
- `packages/monitor/src/server.ts` — Add a new branch immediately after the `/api/recover` handler (around line 935): match `req.method === 'POST' && url === API_ROUTES.applyRecovery`, run identical validation, then `options.workerTracker.spawnWorker('apply-recovery', [body.setName, body.prdId])` and respond with `{ sessionId, pid }`. Whatever switch/lookup decides which subprocess command to run for `'recover'` worker type — extend it to also handle `'apply-recovery'` by invoking the new CLI subcommand.
- `packages/eforge/src/cli/index.ts` — Add `eforge apply-recovery <setName> <prdId>` subcommand. Implementation: instantiate the engine, iterate `engine.applyRecovery(setName, prdId)`, log each event, exit 0 on success / 1 on error. Mirror the existing `eforge recover` command's structure exactly.
- `packages/eforge/src/cli/mcp-proxy.ts` — Add `eforge_apply_recovery` tool definition immediately after `eforge_read_recovery_sidecar` (around line 881). Schema: `{ setName: z.string(), prdId: z.string() }`. Handler calls `apiApplyRecovery({ cwd: toolCwd, body: { setName, prdId } })` and returns `data`. Description: `'Apply the recovery verdict for a failed build plan: requeue (retry), enqueue successor (split), or archive (abandon).'`.
- `packages/pi-eforge/extensions/eforge/index.ts` — Add the mirrored Pi tool with the same name, label `'eforge apply recovery'`, identical schema, calling `daemonRequest(ctx.cwd, 'POST', API_ROUTES.applyRecovery, { setName, prdId })`. Place immediately after the existing `eforge_read_recovery_sidecar` registration around line 1348.

## Verification

- [ ] `pnpm type-check` reports zero errors for all six packages affected (`engine`, `client`, `monitor`, `eforge`, `pi-eforge`).
- [ ] `pnpm test test/apply-recovery.test.ts` passes; the suite contains at least one passing test per verdict (`retry`, `split`, `abandon`, `manual`) and one passing test per error path (missing sidecar, split without `suggestedSuccessorPrd`).
- [ ] After the `retry` test runs, the fixture working tree has `eforge/queue/<prdId>.md` present, `eforge/queue/failed/<prdId>.md` absent, both `<prdId>.recovery.md` and `<prdId>.recovery.json` absent, and `git log -1 --format=%s` returns a subject containing `recover(<prdId>): requeue`.
- [ ] After the `split` test runs, the fixture has `eforge/queue/<successorPrdId>.md` matching the verdict's `suggestedSuccessorPrd` content, the failed PRD plus both sidecars still present under `eforge/queue/failed/`, and one new commit with subject containing `recover(<prdId>): enqueue successor`.
- [ ] After the `abandon` test runs, all three paths under `eforge/queue/failed/` for that prdId are absent and `git log -1 --format=%s` contains `recover(<prdId>): abandon`.
- [ ] After the `manual` test runs, no new commit is created (compare `git rev-parse HEAD` before and after) and the returned `ApplyRecoveryResult.noAction` is `true`.
- [ ] All commits produced by `applyRecovery` carry the `Co-Authored-By: forged-by-eforge` trailer (verified by reading `git log -1 --format=%B`).
- [ ] `curl -X POST http://localhost:<daemon-port>/api/recover/apply -d '{"setName":"x","prdId":"y"}'` returns `{ sessionId, pid }` shape; missing fields return 400 with `Missing required field: ...`; setNames containing `..` return 400 with `Invalid setName or prdId`.
- [ ] `eforge_apply_recovery` MCP tool is callable via the CLI MCP proxy and returns the daemon's response payload.
- [ ] Pi extension exposes `eforge_apply_recovery` and the call succeeds end-to-end against a running daemon.