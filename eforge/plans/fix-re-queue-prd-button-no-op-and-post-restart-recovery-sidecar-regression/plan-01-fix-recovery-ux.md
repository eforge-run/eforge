---
id: plan-01-fix-recovery-ux
name: Fix Re-queue PRD no-op and post-restart sidecar regression
branch: fix-re-queue-prd-button-no-op-and-post-restart-recovery-sidecar-regression/fix-recovery-ux
agents:
  builder:
    effort: high
    rationale: Coordinated change across daemon route, wire types, monitor UI, plus
      a wire-version bump and tests. Needs careful contract design to keep the
      sheet's actionError surface and the queue chip in sync without leaving
      partial states.
---

# Fix Re-queue PRD no-op and post-restart sidecar regression

## Architecture Context

Two bugs in the monitor UI's failed-build recovery flow share a single architectural root: the daemon hands off recovery work to a detached child process, and the UI waits for a per-item lazy SWR fetch before showing the verdict chip. Both bugs are fixed by tightening the contract between the daemon HTTP surface and the monitor UI:

1. `POST /api/recover/apply` becomes a synchronous in-process call into the existing `applyRecoveryRetry` / `applyRecoverySplit` / `applyRecoveryAbandon` / `applyRecoveryManual` helpers in `packages/engine/src/recovery/apply.ts`. The request lifecycle now encloses the actual mutation, so success and failure both flow back to the caller.
2. `GET /api/queue` reads the sibling `<prdId>.recovery.json` for each failed item and embeds `{ verdict, confidence }` in the wire payload. The `RecoveryRow` reads the chip directly from `item.recoveryVerdict` and only fetches the full sidecar (markdown body) when the user opens the report sheet.

The wire surface gains one optional field on `QueueItem` and re-shapes the apply response from `{ sessionId, pid }` to `{ verdict, commitSha?, successorPrdId?, noAction? }`. That second part is breaking, so `DAEMON_API_VERSION` bumps `16 → 17`.

Key existing pieces to preserve:

- `packages/engine/src/recovery/apply.ts` dispatch helpers are unchanged. They already do exactly what the route needs (single `git mv` / `git rm` / `forgeCommit` per verdict).
- `packages/engine/src/eforge.ts` `EforgeEngine.applyRecovery()` generator stays as-is. It is the engine-level entry point used by the CLI and the existing `test/apply-recovery.test.ts` suite. The route stops shelling out to the CLI; it does not stop using the helpers.
- `RecoverySidecarSheet` already shows `Re-queuing…` on `isApplying` and has an `actionError` slot. We just need to feed real error messages into it.
- `RECOVERY_SIDECAR_BASE` route still serves the full markdown body — only the lazy fetch trigger moves into the sheet.
- Per AGENTS.md: keep `eforge-plugin/` and `packages/pi-eforge/` in sync. The Pi extension's `eforge_apply_recovery` tool currently round-trips through the daemon — it returns whatever the daemon returns. After the route reshapes the response, the tool's output shape changes for free. No code change is required in the Pi tool definition itself, but we verify nothing else in `pi-eforge` consumes the old `{ sessionId, pid }` shape.

## Implementation

### Overview

One plan because the work is tightly coupled. Splitting the wire-type change away from the consumers would leave the codebase in a state where `recoveryVerdict` is declared but unread, or where the apply route returns a shape no client knows how to parse. The total scope is ~7 source files plus tests, comfortably within one builder turn.

Work breaks into these strands, all in the same plan:

1. **Daemon: in-process apply route.** Replace the `spawnWorker('apply-recovery', ...)` call at `packages/monitor/src/server.ts:1041-1074` with a direct call into the engine helpers. The route reads `<failedDir>/<prdId>.recovery.json`, parses the verdict via `recoveryVerdictSchema`, and dispatches to the matching helper. Map outcomes to HTTP status codes:
   - `200` with `{ verdict, noAction?, commitSha?, successorPrdId? }` on success
   - `404` `{ error }` when sidecar JSON is missing
   - `400` `{ error }` when sidecar JSON is malformed or fails verdict validation
   - `400` `{ error }` when `verdict === 'split'` but `suggestedSuccessorPrd` is missing (already thrown by the helper)
   - `500` `{ error }` for unexpected failures (git lock, fs error, etc.)
   On success the route also calls `emitMutation(options.daemonState, 'apply-recovery')` so the queue scheduler sees the change (preserving today's behavior). The handler still requires `options?.daemonState` (replacing the prior `options?.workerTracker` guard) and 503s when daemon mode is off.

2. **Daemon: queue verdict embedding.** Extend `serveQueue` at `packages/monitor/src/server.ts:656-743`. The local `QueueItem` shape inside `serveQueue` and the items pushed for the `failed/` directory gain `recoveryVerdict?: { verdict: 'retry'|'split'|'abandon'|'manual'; confidence: 'low'|'medium'|'high' }`. Implementation: when `loadFromDir` is loading from the `failed/` subdir, attempt to read `<prdId>.recovery.json` from the same directory; on success, parse the JSON and pull `json.verdict.verdict` and `json.verdict.confidence` (validate via `recoveryVerdictSchema` from the engine). Any error (missing, malformed, schema mismatch) silently omits the field. Reads run in parallel with the markdown read — no extra round-trip latency.

3. **Wire types and version bump.** Update `packages/client/src/types.ts` `QueueItem` to add the optional `recoveryVerdict` field, and reshape `ApplyRecoveryResponse` in `packages/client/src/routes.ts` from `{ sessionId, pid }` to `{ verdict: 'retry'|'split'|'abandon'|'manual'; commitSha?: string; successorPrdId?: string; noAction?: boolean }`. Bump `DAEMON_API_VERSION` from 16 to 17 in `packages/client/src/api-version.ts` and update its trailing comment to describe the change.

4. **Monitor UI: typed apply + error surface.** Update `packages/monitor-ui/src/lib/api.ts` `applyRecovery` to return either the parsed success body or `{ error: string }` (and document that callers must distinguish the two). On non-2xx, parse the JSON body and forward the `error` string instead of throwing it away. The function signature becomes `Promise<ApplyRecoveryResponse | { error: string }>`.

5. **Monitor UI: sheet error rendering.** Update `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` `handleApply`. If the result has an `error` field, set `actionError` to that message and leave the sheet open. If success, close the sheet. The existing `Re-queuing…` / `Enqueuing…` / `Archiving…` button states already cover the in-flight UX.

6. **Monitor UI: chip from queue payload, lazy markdown fetch.** Update `packages/monitor-ui/src/lib/types.ts` `QueueItem` to mirror the wire change. Update `packages/monitor-ui/src/components/layout/queue-section.tsx` `RecoveryRow`:
   - Remove the `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })` call.
   - Render `RecoveryVerdictChip` directly from `item.recoveryVerdict` when present.
   - Show "recovery pending" only when `item.status === 'failed' && !item.recoveryVerdict`.
   - Replace the inline `<RecoverySidecarSheet sidecar={...}>` with a wrapper that, on first open, fetches the full sidecar via `fetcher(['sidecar', item.id])` and passes it down. The chip is visible from the queue payload alone; the markdown body fetch happens lazily.

7. **Sheet: lazy fetch on open.** Move the sidecar fetch into `RecoverySidecarSheet`. Take `prdId` as a prop (already does); add internal `useState<ReadSidecarResponse | null>` and a `useEffect(() => { if (open) fetch... }, [open])` that fetches via the existing fetcher. Render a small "Loading report…" placeholder while pending. The `verdict` chip and "view report" link still come from the queue payload, so the sheet only needs to fetch the markdown.

8. **Pi extension parity check.** Read `packages/pi-eforge/extensions/eforge/index.ts` around lines 1527-1553 (`eforge_apply_recovery`). The tool already proxies whatever the daemon returns via `daemonRequest`. Verify nothing in pi-eforge or its tests asserts on the old `{ sessionId, pid }` shape — if it does, update the assertion. The tool description ("Apply the recovery verdict for a failed build plan") is still accurate post-change.

9. **Tests.** Three categories, all in `test/`:
   - `apply-recovery-route.test.ts` (new): exercises `POST /api/recover/apply` end-to-end against a real `startServer` instance with a tmp git repo. Cases: retry happy-path (file moved, sidecars removed, commit landed, response shape `{ verdict: 'retry', noAction: false, commitSha }`); abandon happy-path; missing sidecar → 404 with descriptive error; malformed JSON → 400 with descriptive error; split missing `suggestedSuccessorPrd` → 400. Pattern follows `test/daemon-recovery.test.ts` (same `startServer` + `WorkerTracker` stub, but the route no longer spawns).
   - `serve-queue-recovery-verdict.test.ts` (new): hits `GET /api/queue` against `startServer` with a tmp project that contains: one pending PRD, one failed PRD with valid sidecar, one failed PRD with missing `.recovery.json`, one failed PRD with malformed `.recovery.json`. Asserts that only the second item carries `recoveryVerdict` and that the others have it undefined.
   - `recovery-row.test.tsx` (new under `packages/monitor-ui/src/__tests__/` if a vitest jsdom suite exists; otherwise under `packages/monitor-ui/src/components/layout/__tests__/`): uses `@testing-library/react` to render `RecoveryRow` with an `item` carrying `recoveryVerdict`, asserts the chip + "view report" link appear without any network call (mock `fetch` to throw if invoked). A second case asserts that when `item.recoveryVerdict` is absent, "recovery pending" renders and again no fetch fires until the user opens the sheet.

   The existing `test/apply-recovery.test.ts` (engine-level generator tests) remains untouched and must still pass.

### Key Decisions

1. **Single plan, not split.** Wire-type change + producers + consumers in one plan because splitting them would leave intermediate states where the new field exists in types.ts but is unused, or where the route response shape is changed without a consumer that knows how to read it. The total file count is ~7 + tests, well within builder budget.
2. **Bump `DAEMON_API_VERSION` from 16 to 17.** The apply response shape changes from `{ sessionId, pid }` to `{ verdict, ... }`. Adding `recoveryVerdict` to QueueItem is non-breaking on its own (optional field), but the apply response reshape is breaking. Per `api-version.ts` rules, this is exactly what version bumps are for.
3. **404 vs 400 for sidecar errors.** Missing file is `404 Not Found` (the resource doesn't exist). Malformed JSON is `400 Bad Request` (the resource exists but the verdict can't be parsed). This matches the existing semantics on `GET /api/recovery/sidecar` (404 on missing).
4. **Drop `workerTracker` requirement on the apply route.** The route no longer spawns a worker, so it doesn't need a tracker. It still needs `daemonState` to call `emitMutation`, so the 503 guard becomes `if (!options?.daemonState)`.
5. **Validate verdict via `recoveryVerdictSchema`.** Reuse the engine's existing zod schema rather than hand-rolling JSON checks — same source of truth as `EforgeEngine.applyRecovery()` and the existing `test/apply-recovery.test.ts`.
6. **Lazy markdown fetch in the sheet.** Keep the queue payload tight (verdict + confidence are ~30 bytes per failed item) and let the sheet fetch the full markdown body only when the user opens it. This preserves the chip-on-restart fix without bloating `/api/queue`.
7. **Silent omission of `recoveryVerdict` on parse failure.** A malformed `recovery.json` should not break the queue endpoint for other items. The verdict simply isn't shown; the user sees "recovery pending" and can re-run analysis. This matches the spirit of the daemon being defensive against on-disk drift.

## Scope

### In Scope

- Replace detached `spawnWorker('apply-recovery', ...)` in `POST /api/recover/apply` with synchronous in-process dispatch into `packages/engine/src/recovery/apply.ts` helpers.
- Reshape `ApplyRecoveryResponse` to carry `{ verdict, commitSha?, successorPrdId?, noAction? }`.
- Map sidecar / verdict errors to 4xx/5xx with structured `{ error }` bodies.
- Surface error messages in `applyRecovery` client helper and `RecoverySidecarSheet`.
- Embed `recoveryVerdict?: { verdict, confidence }` in `/api/queue` payload for items in `failed/`.
- Extend `QueueItem` wire type and the mirrored monitor-ui type with the optional field.
- Bump `DAEMON_API_VERSION` from 16 to 17.
- Render `RecoveryVerdictChip` from `item.recoveryVerdict` in `RecoveryRow`; remove the per-row `useSWR(['sidecar', item.id], ...)` poll.
- Move the full sidecar fetch (markdown body) into `RecoverySidecarSheet`, triggered on `open === true`.
- Add tests: route happy + failure paths, queue verdict attachment paths, RecoveryRow chip without SWR fetch.
- Verify `packages/pi-eforge/` parity (Pi tool already proxies, no asserts on old shape expected).

### Out of Scope

- The CLI `eforge apply-recovery <prdId>` command (orthogonal — still works).
- `EforgeEngine.applyRecovery()` generator at `packages/engine/src/eforge.ts` and its existing `test/apply-recovery.test.ts` suite.
- The `applyRecoveryRetry` / `applyRecoverySplit` / `applyRecoveryAbandon` / `applyRecoveryManual` helper implementations themselves.
- Any changes to recovery analysis (the `recover()` flow that produces sidecars).
- Any changes to `GET /api/recovery/sidecar` response shape.

## Files

### Create

- `test/apply-recovery-route.test.ts` — End-to-end tests for `POST /api/recover/apply` against a real `startServer` instance with a tmp git repo. Covers retry, abandon, missing sidecar (404), malformed JSON (400), split missing successor PRD (400). Pattern: `test/daemon-recovery.test.ts`.
- `test/serve-queue-recovery-verdict.test.ts` — Tests that `GET /api/queue` attaches `recoveryVerdict` for failed items with valid sidecars and omits it when the JSON is missing or malformed. Real `startServer` + tmp project layout.
- `packages/monitor-ui/src/components/layout/__tests__/recovery-row.test.tsx` (or co-located with existing component tests) — Renders `RecoveryRow` with `item.recoveryVerdict` set; asserts chip + "view report" appear and that no `fetch` is called until the sheet is opened. A second case asserts "recovery pending" when `recoveryVerdict` is absent.

### Modify

- `packages/monitor/src/server.ts` — In `POST /api/recover/apply` route (lines 1041-1074): drop `spawnWorker`; read `<failedDir>/<prdId>.recovery.json`, parse + validate via `recoveryVerdictSchema`, dispatch to the matching `applyRecovery*` helper, return structured success body or 4xx/5xx with `{ error }`. Call `emitMutation(options.daemonState, 'apply-recovery')` on success. Drop the `workerTracker` 503 guard; require `daemonState` instead. In `serveQueue` (lines 656-743): extend the local `QueueItem` shape with `recoveryVerdict?: { verdict, confidence }`; for items loaded from `failed/`, attempt to read sibling `<prdId>.recovery.json` and attach the field on success (silently omit on any failure).
- `packages/client/src/types.ts` — Add optional `recoveryVerdict?: { verdict: 'retry'|'split'|'abandon'|'manual'; confidence: 'low'|'medium'|'high' }` to `QueueItem`.
- `packages/client/src/routes.ts` — Reshape `ApplyRecoveryResponse` from `{ sessionId, pid }` to `{ verdict; commitSha?; successorPrdId?; noAction? }`. Update the inline JSDoc.
- `packages/client/src/api-version.ts` — Bump `DAEMON_API_VERSION` from `16` to `17`; update the trailing comment to reference the apply-route reshape.
- `packages/monitor-ui/src/lib/api.ts` — Update `applyRecovery` to return `Promise<ApplyRecoveryResponse | { error: string }>`. On non-2xx, parse the JSON body and forward the `error` field; on success, return the typed body. Drop the `null`-on-failure path.
- `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` — In `handleApply`: if result has an `error` field, set `actionError` to that message and keep the sheet open; if success, close the sheet. Move the full sidecar fetch (markdown body) into the sheet itself: take `prdId` as the only required prop, add `useState<ReadSidecarResponse | null>`, and `useEffect` that fetches via the existing fetcher when `open === true` and data isn't already loaded. Render a "Loading report…" placeholder while pending. Keep the existing markdown render + button states.
- `packages/monitor-ui/src/lib/types.ts` — Mirror the wire change: add optional `recoveryVerdict?: { verdict; confidence }` to the local `QueueItem`.
- `packages/monitor-ui/src/components/layout/queue-section.tsx` — In `RecoveryRow`: remove the `useSWR(['sidecar', item.id], fetcher, ...)` call. Render `<RecoveryVerdictChip>` directly from `item.recoveryVerdict` when present. Show "recovery pending" only when `item.status === 'failed' && !item.recoveryVerdict`. Render `<RecoverySidecarSheet prdId={item.id} />` (no longer passing the full sidecar — the sheet fetches it lazily on open).

### Verify (no expected change, just confirm parity)

- `packages/pi-eforge/extensions/eforge/index.ts` (lines 1527-1553) — `eforge_apply_recovery` tool proxies through `daemonRequest` and returns whatever the daemon sends. The new shape flows through automatically. If any pi-eforge test asserts on the old `{ sessionId, pid }` shape, update it; otherwise no change. Document the verification in the plan completion summary.

## Verification

- [ ] `pnpm type-check` passes after all source changes (verifies wire type alignment between packages/client and packages/monitor-ui).
- [ ] `pnpm test` passes including the three new test files.
- [ ] `test/apply-recovery-route.test.ts`: `POST /api/recover/apply` with a retry sidecar moves the failed PRD to the queue dir, removes both sidecar files, lands a `recover(<prdId>): requeue per recovery verdict` commit, and returns `{ verdict: 'retry', noAction: false, commitSha }` with HTTP 200.
- [ ] `test/apply-recovery-route.test.ts`: `POST /api/recover/apply` with no sidecar JSON returns HTTP 404 and `{ error }` whose message contains the prdId.
- [ ] `test/apply-recovery-route.test.ts`: `POST /api/recover/apply` with malformed JSON returns HTTP 400 and `{ error }` whose message references the validation failure.
- [ ] `test/apply-recovery-route.test.ts`: `POST /api/recover/apply` with `verdict.verdict === 'split'` but no `suggestedSuccessorPrd` returns HTTP 400 and `{ error }` referencing the missing field.
- [ ] `test/apply-recovery-route.test.ts`: route does not spawn any worker (verified by stub `WorkerTracker.spawnWorker` being uncalled across all cases).
- [ ] `test/serve-queue-recovery-verdict.test.ts`: failed item with valid `<prdId>.recovery.json` has `recoveryVerdict: { verdict, confidence }` populated.
- [ ] `test/serve-queue-recovery-verdict.test.ts`: failed item with missing `<prdId>.recovery.json` has `recoveryVerdict` undefined and the response is otherwise unchanged.
- [ ] `test/serve-queue-recovery-verdict.test.ts`: failed item with malformed `<prdId>.recovery.json` has `recoveryVerdict` undefined and other items in the response still load.
- [ ] `recovery-row.test.tsx`: rendering `RecoveryRow` with `item.recoveryVerdict` set displays the verdict chip + "view report" link, and asserts no network request is made (e.g., `vi.spyOn(globalThis, 'fetch')` is not called).
- [ ] `recovery-row.test.tsx`: rendering `RecoveryRow` with `item.recoveryVerdict` absent displays "recovery pending" italic text and the chip is not rendered.
- [ ] Existing `test/apply-recovery.test.ts` (engine generator tests) continues to pass with no edits required.
- [ ] `DAEMON_API_VERSION` is `17` in `packages/client/src/api-version.ts`.
- [ ] `applyRecovery` in `packages/monitor-ui/src/lib/api.ts` returns `{ error: string }` for non-2xx responses (verified by an inline test or the route test asserting the parsed shape).
- [ ] `packages/pi-eforge/` tests pass without modification (verifying the tool's proxy semantics survive the response reshape).
