---
title: W6 — Async daemon mutation sweep
created: 2026-05-06
depends_on: ["replace-daemon-resync-marker-and-on-connect-heartbeat-with-a-designed-in-stream-hello-sse-handshake-primitive"]
---

# W6 — Async daemon mutation sweep

## Problem / Motivation

The daemon's mutating HTTP surface in `packages/monitor/src/server.ts` has 24 POST/DELETE handlers whose result semantics have not been systematically audited. Some routes may return success before the underlying mutation is observable, leading to misleading client behavior. Additionally, `packages/monitor/src/recorder.ts` derives `runs.plan_set` post-hoc from `enqueue:complete.title` (a display field), instead of a typed payload field — a known gap from the W6 plan.

Relevant repo state:
- The spine appears to have landed in this checkout: `packages/client/src/events.schemas.ts` and `packages/client/src/event-registry.ts` exist, so W6 should use schemas/registry for any event shape changes.
- `docs/roadmap.md` aligns with the daemon-as-orchestration-authority direction and warns against scheduler/workflow scope creep.
- `packages/monitor/src/server.ts` has 24 mutating POST/DELETE handlers to audit.
- `packages/monitor/src/recorder.ts` still derives enqueue run `plan_set` from `enqueue:complete.title`.
- `packages/engine/src/eforge.ts` emits `enqueue:complete` with `{ id, filePath, title }`; there is no dedicated typed field for the recorder's `plan_set` value.

This is the remaining Wave 3 maintenance sweep in the event-source refactor, with W3 (`stream:hello` SSE handshake) currently running and W4 (`RunInfo` row/API/UI type unification) pending behind W3. This looks like a **maintenance / focused** change: bounded route audit plus one typed event payload cleanup.

## Goal

Audit and harden every daemon-side mutating HTTP route so success responses are never misleading, and replace the recorder's post-hoc `plan_set` derivation with a typed event field — without redesigning the queue/scheduler or expanding daemon mutation surface.

## Approach

**Profile signal:** Recommended profile is **Excursion**. The work is not large enough for an expedition, but it spans daemon routes, event schemas/registry, engine emit sites, recorder behavior, and tests. It should be built as one coordinated PRD after W3 and may run in parallel with W4 rather than as a trivial errand.

**High-level steps:**

- Inspect every POST/DELETE/PATCH handler in `packages/monitor/src/server.ts` and classify it as synchronous, async-with-existing-result-channel, async-needs-new-result-event, or no-mutation.
- Fix any route that returns success before a mutation outcome is observable. Prefer synchronous completion for short/idempotent operations; add a typed `mutation:result`/specific result event only for genuinely long-running work that cannot be made synchronous.
- Replace `packages/monitor/src/recorder.ts` post-hoc `enqueue:complete.title -> runs.plan_set` derivation with a typed source field. Because the spine has landed in this checkout (`events.schemas.ts` and `event-registry.ts` exist), extend the Zod schema, `EforgeEvent` inference, event registry projection/summary if needed, and engine emit site rather than editing a hand-written union.
- Produce a durable audit log of route decisions. The original W6 note names `tmp/event-source-refactor/w6-audit.md`, but `tmp/` is gitignored; the build should either write there for local traceability and also commit a tracked audit summary (recommended: `docs/daemon-mutation-audit.md`), or choose a tracked package-local doc and mention the path in the final summary.

**Sequencing:**
- W3 is currently running and W4 is queued behind it. W6 should wait for W3's `server.ts` SSE changes to settle, but it can run in parallel with W4. If enqueuing now, chain W6 after the W3 queue entry (not after W4) so W4 and W6 form the next wave.

**Code Impact:**

- `packages/monitor/src/server.ts`
  - Audit all mutating handlers currently found at: `keepAlive`, `enqueue`, `cancel`, `recover`, `applyRecovery`, `daemonStop`, `autoBuildSet`, `schedulerKick`, `profileUse`, `profileCreate`, `profileDelete`, `playbookSave`, `playbookEnqueue`, `playbookPromote`, `playbookDemote`, `playbookValidate`, `playbookCopy`, `sessionPlanCreate`, `sessionPlanSetSection`, `sessionPlanSkipDimension`, `sessionPlanSetStatus`, `sessionPlanSelectDimensions`, `sessionPlanMigrateLegacy`.
  - Known patterns to evaluate:
    - `/api/enqueue` uses `workerTracker.spawnWorker('enqueue', ...)`, returns `{ sessionId, pid }`, and triggers `emitMutation(..., 'enqueue')` after worker completion. Decide/document that the worker session event stream is the result channel, or add a typed result event if gaps remain.
    - `/api/recover` uses `workerTracker.spawnWorker('recover', ...)` and returns `{ sessionId, pid }`; recovery results are sidecar-driven today. Audit whether this counts as a documented result channel.
    - `/api/recover/apply` is already synchronous in-process and emits `queue:mutation` after success; use as the precedent.
    - `/api/scheduler/kick` currently only emits `queue:mutation` and returns `{ ok: true }`; decide whether that is sufficient (wake request accepted) or needs a visible scheduler result.
    - `/api/daemon/stop` responds before shutdown via `setImmediate`; document as intentional accepted-command semantics or adjust response/event wording.
    - Playbook/profile/session-plan routes appear synchronous; verify every awaited file/queue mutation completes before 2xx response.

- `packages/monitor/src/recorder.ts`
  - Current issue: `db.updateRunPlanSet(enqueueRunId, event.title)` on `enqueue:complete` derives `plan_set` from a display title. Replace with a typed payload field such as `event.planSet` / `event.prdId` as appropriate for the DB meaning; continue using `title` for display only if needed.

- `packages/engine/src/eforge.ts`
  - `enqueue()` emit site currently yields `enqueue:complete` with `{ id, filePath, title }`. Add the typed field consumed by recorder. Use the actual queue PRD id if `runs.plan_set` should identify the queue entry, or the canonical plan-set/name if that is the intended meaning; document the choice.

- `packages/client/src/events.schemas.ts` and `packages/client/src/event-registry.ts`
  - Add/validate the new field on `enqueue:complete` and update registry projection/sample/summary logic. Existing registry projection currently maps `planSet` from `event.title`; remove that derivation.
  - If any new mutation result event is introduced, add schema + registry entry and persistence/projection metadata.

- Tests:
  - Add/update tests around `enqueue:complete` schema and recorder behavior.
  - Add route-audit regression tests where practical for any fixed return-before-complete route.
  - Run `pnpm type-check` and relevant vitest suites (`packages/client`, `packages/monitor`, or full `pnpm test` if feasible).

## Scope

**In scope:**

- Inspect every POST/DELETE/PATCH handler in `packages/monitor/src/server.ts` and classify it as synchronous, async-with-existing-result-channel, async-needs-new-result-event, or no-mutation.
- Fix any route that returns success before a mutation outcome is observable. Prefer synchronous completion for short/idempotent operations; add a typed `mutation:result`/specific result event only for genuinely long-running work that cannot be made synchronous.
- Replace `packages/monitor/src/recorder.ts` post-hoc `enqueue:complete.title -> runs.plan_set` derivation with a typed source field. Because the spine has landed in this checkout (`events.schemas.ts` and `event-registry.ts` exist), extend the Zod schema, `EforgeEvent` inference, event registry projection/summary if needed, and engine emit site rather than editing a hand-written union.
- Produce a durable audit log of route decisions. The original W6 note names `tmp/event-source-refactor/w6-audit.md`, but `tmp/` is gitignored; the build should either write there for local traceability and also commit a tracked audit summary (recommended: `docs/daemon-mutation-audit.md`), or choose a tracked package-local doc and mention the path in the final summary.

**Out of scope:**

- Reworking queue/scheduler control flow.
- Adding new daemon mutations.
- Replacing worker-based enqueue/recovery execution if their existing session/event streams are documented as the result channel.

## Acceptance Criteria

1. Every POST/DELETE/PATCH route in `packages/monitor/src/server.ts` is audited and classified in a tracked audit artifact. The audit lists the route, mutation behavior, result-channel decision, and any change made.
2. No daemon-side mutating route returns a misleading success response before the mutation has either completed synchronously or become observable through a documented result channel (existing worker session events/sidecars count only if explicitly documented in the audit and tested where feasible).
3. `packages/monitor/src/server.ts` has no undocumented detached subprocess/resultless mutation pattern. Grep for `spawn(` and `detached:` in `server.ts` returns zero hits, or each remaining/indirect worker path is covered by the audit with its result channel.
4. The `recorder.ts` post-hoc derivation is gone: `runs.plan_set` is not populated from `enqueue:complete.title`. The source event carries a typed payload field for the value recorder needs.
5. `enqueue:complete` schema, registry metadata/projection/sample, engine emit site, and recorder consumer are consistent. Adding/removing the new field incorrectly fails type-check or tests.
6. If any new `mutation:*`/result event is added, it is represented in `packages/client/src/events.schemas.ts`, `packages/client/src/event-registry.ts`, persistence/projection config, and relevant UI/client consumption.
7. Tests cover the `enqueue:complete` typed field and recorder update path; route behavior tests are added for any route whose semantics changed.
8. Existing behavior is preserved for enqueue/recovery/playbook/profile/session-plan routes except for clearer result semantics. No queue/scheduler redesign is introduced.
9. Verification commands pass: `pnpm type-check` and targeted tests (or `pnpm test` if practical).
