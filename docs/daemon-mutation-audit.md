# Daemon Mutation Audit

> **Plan**: plan-01-mutation-sweep (W6 daemon mutation sweep and `enqueue:complete` typed-field cleanup)
>
> **Source file**: `packages/monitor/src/server.ts`
>
> **Scope**: All 23 mutating handlers (22 POST + 1 DELETE) in the daemon HTTP surface.

## Classification Key

| Classification | Meaning |
|---|---|
| `synchronous` | Handler awaits all mutation work before issuing a 2xx response. Success is fully observable on return. |
| `async-with-existing-result-channel` | Handler delegates to a worker or deferred operation. A documented result channel (session event stream, sidecar file, etc.) carries the outcome. |
| `accepted-command` | Handler responds before the commanded action is observable - intentional by design (e.g. cannot await own shutdown, wake-only semantics). |
| `no-mutation` | Handler uses a mutating verb but performs no persistent state change (e.g. in-memory counter update, pure validation). |

## Route Audit Table

| Route | Method | Handler line | Classification | Result channel | Change made |
|---|---|---|---|---|---|
| `/api/keep-alive` | POST | 1217 | no-mutation | n/a - only increments in-memory keep-alive counter; no persistent state | None |
| `/api/enqueue` | POST | 1228 | async-with-existing-result-channel | Worker session event stream (`session:start`, `enqueue:start`, formatter `agent:*`, `enqueue:complete`, `session:end`); `queue:mutation` (reason: `'enqueue'`) injected via `onExit` callback at line 1280 to wake the scheduler after the worker exits | None at route level; engine-side `enqueue:complete` payload gains `planSet` field (Workstream B) |
| `/api/cancel/:sessionId` | POST | 1324 | synchronous | `{ status: 'cancelled', sessionId }` on 200; `workerTracker.cancelWorker` is a synchronous call that returns a boolean before the handler responds | None |
| `/api/recover` | POST | 1344 | async-with-existing-result-channel | Recovery sidecar written by the worker to `<queueDir>/failed/<prdId>.recovery.json` (default `queueDir` is `eforge/queue`); readable via `GET /api/recovery/sidecar`; response carries `{ sessionId, pid }` for the spawned worker | None - sidecar is the documented result channel; `onExit` parity with `enqueue` was evaluated and not required (see notes) |
| `/api/recover/apply` | POST | 1388 | synchronous | `{ verdict, commitSha?, successorPrdId?, noAction? }` in response body; all recovery helpers (`applyRecoveryRetry/Split/Abandon/Manual`) are awaited before `sendJson` | None - route is already fully synchronous post-refactor |
| `/api/daemon/stop` | POST | 1495 | accepted-command | `{ status: 'stopping', force }` acknowledges receipt; actual shutdown fires via `setImmediate` after response is flushed | None - intentional: a handler cannot await its own process exit |
| `/api/auto-build` | POST | 1528 | synchronous | `{ enabled, watcher }` in response body; `autoBuild` flag is set synchronously and `onSpawnWatcher`/`onKillWatcher` are called synchronously before `sendJson` | None |
| `/api/scheduler/kick` | POST | 1579 | accepted-command | `{ ok: true }` acknowledges receipt; `queue:mutation` (reason: `'external'`) is injected to wake the scheduler; semantics are wake-request, not synchronous scheduler execution | None - `{ ok: true }` wording is not misleading given the accepted-command intent |
| `/api/profile/use` | POST | 1674 | synchronous | `{ active: name }` in response body; `setActiveProfile` is awaited before `sendJson` | None |
| `/api/profile/create` | POST | 1706 | synchronous | `{ path }` in response body; `createAgentRuntimeProfile` is awaited before `sendJson` | None |
| `/api/profile/:name` | DELETE | 1751 | synchronous | `{ deleted: name }` in response body; `deleteAgentRuntimeProfile` is awaited before `sendJson` | None |
| `/api/playbook/save` | POST | 1861 | synchronous | `{ path }` in response body; `writePlaybook` is awaited before `sendJson` | None |
| `/api/playbook/enqueue` | POST | 1920 | synchronous | `{ id }` in response body; `enqueuePrd` and `commitEnqueuedPrd` are both awaited, then `queue:mutation` (reason: `'playbook-enqueue'`) is emitted, all before `sendJson` | None |
| `/api/playbook/promote` | POST | 1995 | synchronous | `{ path }` in response body; `movePlaybook` (project-local → project-team) is awaited before `sendJson` | None |
| `/api/playbook/demote` | POST | 2036 | synchronous | `{ path }` in response body; `movePlaybook` (project-team → project-local) is awaited before `sendJson` | None |
| `/api/playbook/validate` | POST | 2077 | no-mutation | n/a - pure in-process validation via `validatePlaybook`; no filesystem writes or state mutations | None |
| `/api/playbook/copy` | POST | 2103 | synchronous | `{ sourcePath, targetPath, targetScope }` in response body; `copyPlaybookToScope` is awaited before `sendJson` | None |
| `/api/session-plan/create` | POST | 2233 | synchronous | `{ session, path }` in response body; `createSessionPlan` + `writeSessionPlan` are awaited before `sendJson` | None |
| `/api/session-plan/set-section` | POST | 2293 | synchronous | `{ session, readiness }` in response body; `loadSessionPlan` + `setSessionPlanSection` + `writeSessionPlan` + `getReadinessDetail` are all awaited before `sendJson` | None |
| `/api/session-plan/skip-dimension` | POST | 2341 | synchronous | `{ session, readiness }` in response body; `loadSessionPlan` + `skipDimension` + `writeSessionPlan` + `getReadinessDetail` are all awaited before `sendJson` | None |
| `/api/session-plan/set-status` | POST | 2387 | synchronous | `{ session }` in response body; `loadSessionPlan` + `setSessionPlanStatus` + `writeSessionPlan` are awaited before `sendJson` | None |
| `/api/session-plan/select-dimensions` | POST | 2443 | synchronous | `{ session, required_dimensions, optional_dimensions, readiness }` in response body; `loadSessionPlan` + `setSessionPlanDimensions` + `writeSessionPlan` + `getReadinessDetail` are all awaited before `sendJson` | None |
| `/api/session-plan/migrate-legacy` | POST | 2533 | synchronous | `{ session, migrated }` in response body; `loadSessionPlan` + `migrateBooleanDimensions` + `writeSessionPlan` (conditional) are awaited before `sendJson` | None |

**Totals**: 0 `async-needs-new-result-event` rows post-implementation. All worker-based routes are classified `async-with-existing-result-channel` with their result channels named above.

## Spawn and Detach Verification

Post-implementation grep gates (both must return zero hits):

```
grep -n 'spawn(' packages/monitor/src/server.ts      # 0 hits
grep -n 'detached:' packages/monitor/src/server.ts   # 0 hits
```

All worker spawning is centralized in `packages/monitor/src/server-main.ts` via `WorkerTracker`. Routes call `options.workerTracker.spawnWorker(command, args, onExit?)` and receive `{ sessionId, pid }`.

Indirect spawn paths covered by this audit:

- **`enqueue`** (line 1279): `workerTracker.spawnWorker('enqueue', args, () => emitMutation(..., 'enqueue'))`. Result channel: worker session event stream including `enqueue:complete`. Scheduler wakeup via `onExit`.
- **`recover`** (line 1375): `workerTracker.spawnWorker('recover', [setName, prdId])`. Result channel: recovery sidecar at `<queueDir>/failed/<prdId>.recovery.json` (default `queueDir` is `eforge/queue`).

## Per-Route Notes

### `/api/keep-alive` - no-mutation

`keepAliveCallback()` (if set) is an in-memory heartbeat signal to prevent daemon self-termination. No filesystem writes, no DB mutations, no queue changes. Classified `no-mutation` despite the POST verb because nothing persistent changes.

### `/api/enqueue` - async-with-existing-result-channel

The `enqueue` worker emits the full session event stream over SSE (`/api/events/:runId`), including `enqueue:complete` with `{ id, filePath, title, planSet }` (the `planSet` field is added by Workstream B of this plan). This event stream is the documented result channel. The `onExit` callback at line 1280 additionally emits `queue:mutation` (reason: `'enqueue'`) to kick the scheduler, ensuring newly-queued PRDs are picked up promptly.

Workstream B changes: the `enqueue:complete` Zod schema in `packages/client/src/events.schemas.ts` gains `planSet: z.string()`. The engine emit site in `packages/engine/src/eforge.ts` populates this field. The recorder (`packages/monitor/src/recorder.ts`) and event registry (`packages/client/src/event-registry.ts`) are updated to read `event.planSet` instead of deriving `planSet` from `event.title`. The route handler itself is unchanged.

### `/api/recover` - async-with-existing-result-channel

The `recover` worker writes a recovery sidecar JSON file to `<queueDir>/failed/<prdId>.recovery.json` (default `queueDir` is `eforge/queue`; configurable via the route's `queueDir` option). This sidecar is the documented result channel; clients poll or read it via `GET /api/recovery/sidecar` to obtain the verdict before calling `/api/recover/apply`.

**`onExit` parity evaluation**: Unlike `enqueue`, `recover` does not register an `onExit` callback. Adding one would emit `queue:mutation` after the recovery worker exits, but recovery itself does not immediately enqueue new work - that happens only when `applyRecovery` is subsequently called (which already emits `queue:mutation` at line 1485). Adding `onExit` parity here would cause a redundant scheduler wake with no new queue entries. Decision: no `onExit` callback added; sidecar is sufficient as the result channel.

### `/api/recover/apply` - synchronous

This route was refactored (prior to this plan) from a worker-based pattern that returned `{ sessionId, pid }` before the mutation completed. It now awaits `applyRecoveryRetry/Split/Abandon/Manual` inline and returns the outcome directly in the response body. No further changes needed.

### `/api/daemon/stop` - accepted-command

The handler calls `sendJson(res, { status: 'stopping', force })` and then triggers shutdown via `setImmediate(() => options.daemonState!.onShutdown!())`. The `setImmediate` ensures the response is flushed before the process begins shutting down. A handler cannot await its own process exit, so this accepted-command pattern is correct. The response wording `{ status: 'stopping' }` accurately conveys that shutdown has been accepted but not yet completed.

### `/api/scheduler/kick` - accepted-command

This route is a wake-request: it injects `queue:mutation` (reason: `'external'`) into the scheduler's event bus and responds immediately. The scheduler is an autonomous loop that will re-scan the queue directory asynchronously. There is no synchronous scheduler operation to await. The response `{ ok: true }` could be read as a success confirmation, but in context it means "wake accepted". This is not misleading given the route's documented semantics as a kick/nudge mechanism.

### `/api/playbook/validate` - no-mutation

Calls `validatePlaybook(body.raw)` which is a pure in-process parse and schema check. No filesystem writes, no DB mutations, no queue changes. The POST verb is used for convention (request carries a body) but the operation is idempotent and non-mutating.

### `enqueue:complete` typed-field decision

The default chosen is `planSet: string` (not `prdId`). The recorder writes the `title` value to `runs.plan_set` and the registry projects it as `state.runs[].planSet`. The semantic is "plan-set name", not "queue entry id". The PRD id is already available as `event.id` (unchanged). Adding an explicit `planSet` field removes the post-hoc derivation from the display field `title` and makes the intent clear in the schema. The `summary` in the registry (`'Enqueued: ${e.title}'`) continues to use `title` for display; only the `project` function's derivation is updated.
