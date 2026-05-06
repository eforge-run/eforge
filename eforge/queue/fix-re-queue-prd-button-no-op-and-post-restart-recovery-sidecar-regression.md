---
title: Fix Re-queue PRD button no-op and post-restart recovery sidecar regression
created: 2026-05-06
---

# Fix Re-queue PRD button no-op and post-restart recovery sidecar regression

## Problem / Motivation

Two related bugs in the monitor UI's recovery flow erode trust in the failed-build recovery loop. Observed against the daemon running in `~/projects/schaake-os`. The fix lives in `~/projects/eforge-build/eforge`.

**Bug 1 — Re-queue PRD button is silent.** When a build fails and the recovery analysis verdict is `retry`, the user opens the Recovery Report sheet and clicks "Re-queue PRD". The sheet closes but nothing else happens: the failed PRD stays in `eforge/queue/failed/`, no retry is enqueued, no error surfaces in the UI. The user has no signal whether the action succeeded, failed, or was even received.

**Bug 2 — Recovery sidecar disappears after `eforge:restart`.** Before restart, the failed item's queue row shows the verdict chip ("retry medium") and a "view report" link. After restarting the daemon, the same row shows only "recovery pending" — even though `<prdId>.recovery.md` and `<prdId>.recovery.json` are still on disk in `eforge/queue/failed/`. A previous fix (commit `6a28ed4`) was supposed to make sidecars survive restarts; the user reports this regressed.

**Who is affected:** anyone using the monitor UI to act on failed-build recovery analyses. The failure mode is subtle (UI looks like it accepted the click, but state never changes), so users don't know to fall back to the CLI.

**Why now:** the recovery flow is a core trust surface — when a build fails, the user needs the verdict + actions to be reliable. The current bugs make the UI feel "broken" right at the moment the user is already debugging a failure.

### Context

**Code path explored:**

- `packages/monitor/src/server.ts:1041-1074` — `POST /api/recover/apply` route. Currently spawns a detached `eforge apply-recovery <prdId>` worker via `workerTracker.spawnWorker` and returns `{sessionId, pid}` immediately. The worker writes its log to `<cwd>/.eforge/worker-<sessionId>.log`; failures don't surface to the UI.
- `packages/monitor/src/server.ts` — `GET /api/recovery/sidecar?prdId=...` route. Reads `<cwd>/<prdQueue.dir>/failed/<prdId>.recovery.{md,json}`. Path matches the actual flat layout in `~/projects/schaake-os/eforge/queue/failed/`.
- `packages/monitor/src/server.ts` — `serveQueue` for `/api/queue`. Loads PRDs from `failed/` but only returns `{id, title, status, priority?, created?, dependsOn?}` — no recovery verdict.
- `packages/monitor-ui/src/components/layout/queue-section.tsx:80-84` — `RecoveryRow`. Per-failed-item `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })`. Three-state contract: `undefined` (loading) and `null` (404) both render "recovery pending"; populated data renders the verdict chip + report link.
- `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` — `handleApply` calls `applyRecovery(prdId)`; if response is truthy, closes the sheet. Already shows "Re-queuing…" while awaiting and has an `actionError` slot for surfacing failures.
- `packages/monitor-ui/src/lib/api.ts` — `applyRecovery` returns `null` for any non-2xx. Throws away error messages.
- `packages/engine/src/recovery/apply.ts` — Pure dispatch helpers (`applyRecoveryRetry`, `applyRecoverySplit`, `applyRecoveryAbandon`, `applyRecoveryManual`). Each is a quick git mutation + `forgeCommit`. Already used by the `engine.applyRecovery()` generator at `packages/engine/src/eforge.ts`.
- `packages/client/src/types.ts` — `QueueItem` wire type.
- `packages/client/src/api-version.ts` — `DAEMON_API_VERSION = 16`.

**Prior fix referenced:** commit `6a28ed4` (plan-01-decouple-failed-prd-discovery, 2026-04-30) decoupled failed-PRD sidecar fetching from session state — any failed PRD with a `prdId`-keyed sidecar should render its verdict chip without a live run. The user expects this to survive daemon restarts; current behavior shows "recovery pending" until the per-item 10s SWR poll fires.

### Reproduction Steps

**Bug 1 — Re-queue PRD no-op:**

1. Have any failed PRD in `eforge/queue/failed/` with sidecar files (`.recovery.md` and `.recovery.json`) where `verdict.verdict == "retry"`.
2. Open the monitor UI; locate the failed item in the Queue panel.
3. Click "view report" → Recovery Report sheet opens with the verdict and rationale.
4. Click "Re-queue PRD".
5. **Expected:** the failed PRD is moved back to `eforge/queue/<prdId>.md`, the two sidecar files are removed, and a `recover(<prdId>): requeue per recovery verdict` commit lands. The queue row updates to show the PRD as `pending`/`running`. If anything fails (git lock, missing sidecar, etc.), the sheet stays open and the error is surfaced in `actionError`.
6. **Actual:** the sheet closes immediately. No commit lands, no files move, no error appears. The failed PRD remains in `failed/` and the UI continues to show it as failed.

**Bug 2 — Sidecar shows "recovery pending" post-restart:**

1. Same starting state: a failed PRD with sidecar files on disk. Confirm the queue row shows the verdict chip + "view report" link before the next step.
2. Run `/eforge:restart` (or otherwise restart the daemon) for the project.
3. Reload the monitor UI immediately.
4. **Expected:** the failed item's row shows its verdict chip + "view report" link as soon as the queue list returns (within the 5s `/api/queue` poll).
5. **Actual:** the row shows only "recovery pending" italic text. The chip and report link do not appear. After waiting up to 10s (per-item SWR `refreshInterval`), the chip may eventually appear — but the gap is long enough that the user perceives the recovery analysis as lost.

**Workarounds (current):** for Bug 1 the user can run `eforge apply-recovery <prdId>` from the CLI manually. For Bug 2 the user can wait up to 10s and the chip *may* appear.

### Root Cause

**Bug 1 — Re-queue PRD no-op (root cause confirmed by reading code):**

`POST /api/recover/apply` at `packages/monitor/src/server.ts:1041-1074` calls `options.workerTracker.spawnWorker('apply-recovery', [prdId], onExit)` and immediately returns `{sessionId, pid}` to the client. The worker is a **detached, unref'd** child process running `eforge apply-recovery <prdId>`. So any failure inside the spawned worker only lands in `<cwd>/.eforge/worker-<sessionId>.log`. The UI cannot see it. Worse, `applyRecovery` in `packages/monitor-ui/src/lib/api.ts` returns `null` for any non-2xx response, so even when we do surface errors from the route, the message is thrown away.

**Why this is the wrong shape**: recovery is a small in-process operation — at most one `git mv`, one `git rm`, and one `forgeCommit` (~100-500ms). Spawning a CLI subprocess detaches it from the request lifecycle and converts every failure into a silent one. The dispatch helpers (`applyRecoveryRetry` / `Split` / `Abandon` / `Manual`) at `packages/engine/src/recovery/apply.ts` are pure async functions; they can run directly from the route handler.

**Bug 2 — "recovery pending" post-restart (root cause confirmed by reading code):**

`RecoveryRow` calls `useSWR(['sidecar', item.id], fetcher, { refreshInterval: 10000 })` per-failed-item. After a daemon restart, SWR's local cache is gone (the page reloads); each row must wait for its own first fetch. With a 10s `refreshInterval`, every failed item shows "recovery pending" for up to 10s after restart even if the sidecar files are present and the route works perfectly.

The `serveQueue` handler already scans `failed/`, but the response only carries `{id, title, status, priority?, created?, dependsOn?}` — not the verdict. So the UI is forced into the per-item lazy fetch.

## Goal

Restore trust in the monitor UI's failed-build recovery loop by making "Re-queue PRD" act synchronously and surface real results, and by ensuring the recovery verdict chip + "view report" link appear on the first `/api/queue` poll after a daemon restart whenever the sidecar files are on disk.

## Approach

**Architectural fix that resolves both root causes:**

1. **Bug 1**: replace the `spawnWorker` call with an in-process dispatch. The route reads + parses the sidecar JSON, calls the appropriate `applyRecovery*` helper, awaits completion, and returns success or a structured error. Frontend already shows "Re-queuing…" while awaiting; lifting `actionError` from the response message gives the user a real signal.

2. **Bug 2**: include the verdict in the `/api/queue` response. `serveQueue` already touches `failed/`; reading the sibling `<prdId>.recovery.json` is one extra small read per failed item. Frontend renders the chip from `item.recoveryVerdict` directly, eliminating the per-item SWR poll for the chip. The sheet still fetches its full markdown lazily on open. "recovery pending" then only shows when there's truly no `.recovery.json` on disk yet.

### Profile Signal

**Recommended profile: Excursion.**

Touches ~7 files across `packages/monitor/`, `packages/monitor-ui/`, `packages/client/`, and tests. Two coupled changes (in-process apply path + queue payload extension) with a wire-type bump (`DAEMON_API_VERSION 16 → 17`). Not mechanical enough for Errand; not architectural or cross-cutting enough for Expedition.

## Scope

### In Scope

- Replace the detached `spawnWorker` call in `POST /api/recover/apply` (`packages/monitor/src/server.ts:1041-1074`) with in-process dispatch to `applyRecoveryRetry` / `applyRecoverySplit` / `applyRecoveryAbandon` / `applyRecoveryManual` from `packages/engine/src/recovery/apply.ts`.
- Update `applyRecovery` in `packages/monitor-ui/src/lib/api.ts` to surface parsed error messages on non-2xx responses.
- Update the Recovery Report sheet (`packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx`) to show success/error states from the synchronous response.
- Extend `serveQueue` (`packages/monitor/src/server.ts`) to attach `recoveryVerdict?: { verdict, confidence }` to each failed item by reading the sibling `<prdId>.recovery.json`.
- Extend `QueueItem` in `packages/client/src/types.ts` with the optional `recoveryVerdict` field and bump `DAEMON_API_VERSION` from 16 to 17 in `packages/client/src/api-version.ts`.
- Update `RecoveryRow` (`packages/monitor-ui/src/components/layout/queue-section.tsx`) to render the verdict chip from `item.recoveryVerdict`, removing the per-item `useSWR(['sidecar', item.id], ...)` poll.
- Move the full sidecar fetch (markdown body needed by the report sheet) into `RecoverySidecarSheet`, triggered on `open === true`.
- Add tests covering the new in-process apply route (happy + failure paths), `serveQueue` recovery-verdict attachment, and `RecoveryRow` chip rendering without an SWR fetch.
- Review `packages/pi-eforge/` for a parallel apply-recovery surface; if the Pi extension exposes the same action, give it the same in-process handling (per AGENTS.md: keep `eforge-plugin/` and `packages/pi-eforge/` in sync).

### Out of Scope

- The CLI command `eforge apply-recovery <prdId>` continues to work as-is (orthogonal).
- The existing `engine.applyRecovery` generator at `packages/engine/src/eforge.ts` and its tests in `test/apply-recovery.test.ts` (the dispatch helpers are unchanged).

## Acceptance Criteria

**Bug 1 — Re-queue PRD acts synchronously and surfaces results:**

- [ ] `POST /api/recover/apply` no longer spawns a worker subprocess. The handler dispatches in-process to `applyRecoveryRetry` / `applyRecoverySplit` / `applyRecoveryAbandon` / `applyRecoveryManual` from `packages/engine/src/recovery/apply.ts`, awaits completion, and returns:
    - `200 { commitSha, successorPrdId?, noAction? }` on success
    - `4xx { error: string }` for caller errors (missing sidecar → 404, malformed JSON → 400)
    - `5xx { error: string }` for unexpected failures (git lock, etc.)
- [ ] `applyRecovery` in `packages/monitor-ui/src/lib/api.ts` returns the parsed error message on non-2xx responses so the sheet can display it.
- [ ] Clicking "Re-queue PRD" in the sheet:
    - Shows "Re-queuing…" while the request is in flight.
    - On success, closes the sheet. The next `/api/queue` poll (≤5s) shows the PRD back in `pending`/`running` and absent from the `failed` group.
    - On failure, the sheet stays open and the user-readable error appears in the existing `actionError` slot.
- [ ] No new `worker-daemon-*.log` file is created by an apply-recovery click. The mutation runs in the daemon process.
- [ ] The CLI command `eforge apply-recovery <prdId>` continues to work (orthogonal).

**Bug 2 — Verdict chip renders from `/api/queue` payload:**

- [ ] `serveQueue` in `packages/monitor/src/server.ts` attaches `recoveryVerdict?: { verdict, confidence }` to each item loaded from `failed/`, sourced from the sibling `<prdId>.recovery.json`. Missing or malformed JSON omits the field (no error).
- [ ] `QueueItem` type in `packages/client/src/types.ts` carries the optional `recoveryVerdict` field. `DAEMON_API_VERSION` is bumped (16 → 17) per `packages/client/src/api-version.ts`.
- [ ] `RecoveryRow` in `packages/monitor-ui/src/components/layout/queue-section.tsx` renders `<RecoveryVerdictChip>` directly from `item.recoveryVerdict` when present. The per-item `useSWR(['sidecar', item.id], ...)` is removed from the row.
- [ ] The full sidecar fetch (markdown body needed by the report sheet) moves into `RecoverySidecarSheet` and triggers on `open === true`, not on every queue render.
- [ ] After `eforge:restart`, the verdict chip + "view report" link appear within the first `/api/queue` poll (≤5s). "recovery pending" only shows for failed items with no `.recovery.json` on disk yet.

**Cross-cutting:**

- [ ] `pnpm type-check` and `pnpm test` pass.
- [ ] New tests exercise:
    - `POST /api/recover/apply` happy path for `retry` (file moved, sidecars removed, commit landed) using a tmp git repo + sidecar fixture; pattern follows `test/daemon-recovery.test.ts`.
    - Failure paths: missing sidecar → 404; malformed `recovery.json` → 4xx with descriptive error.
    - `serveQueue` returns `recoveryVerdict` for failed items with valid sidecars and omits it when the JSON is missing or malformed.
    - `RecoveryRow` renders the chip when `item.recoveryVerdict` is present without making an SWR fetch.
- [ ] Existing `engine.applyRecovery` generator tests in `test/apply-recovery.test.ts` continue to pass (the dispatch helpers are unchanged).
- [ ] `packages/pi-eforge/` is reviewed for a parallel apply-recovery surface; if the Pi extension exposes the same action it gets the same in-process handling.

**Verification (manual, in `~/projects/schaake-os`):**

1. Restart the daemon. The failed item's verdict chip and "view report" link appear on the first queue load.
2. Click "Re-queue PRD". Sheet shows "Re-queuing…" briefly, then closes. Within 5s the failed item is gone from the failed group and is queued/running.
3. Force a failure (e.g., delete `<prdId>.recovery.json` between opening the sheet and clicking the button). Sheet stays open and shows "Recovery sidecar not found".