---
title: Daemon Activity Events + Monitor UI Status Surface
created: 2026-05-06
---

# Daemon Activity Events + Monitor UI Status Surface

## Problem / Motivation

When no build is running, the monitor UI cannot answer two basic questions: "is the daemon alive?" and "what is it doing right now?". The Log view is build-scoped — every event there is about one build's lifecycle — so daemon-level activity (recovery on startup, orphan reaping, scheduler decisions, auto-build triggers, server lifecycle) is invisible.

**Who is affected.** Anyone running eforge in persistent-daemon mode and watching the monitor UI between builds: developers debugging "why didn't my enqueue start a build?", anyone restarting the daemon and wanting to confirm recovery completed, anyone investigating whether the daemon is healthy or hung.

**Why it matters now.** The cross-build SSE endpoint (`GET /api/daemon-events`) and its UI consumer (`use-daemon-events`) already exist as transport. The bottleneck is *what* flows over them: today the allowlist surfaces a mix of build-scoped events plus exactly one daemon-scoped event (`daemon:auto-build:paused`). Adding a structured daemon event family now lets us deliver a "daemon is alive and doing X" surface without designing new transport. Doing it later means designing the transport twice.

**Current daemon visibility gap.** The daemon performs meaningful cross-build work today, almost all of it silent:
- Server lifecycle (start, port-bind, lockfile write, shutdown) — `packages/monitor/src/server-main.ts:246-269, 534-541, 660-699` — no events emitted.
- Recovery on startup (mark dead `running` runs as failed, delete stale queue-lock files) — `server-main.ts:124-179` — only emits a single `phase:end` per failed run.
- Orphan watcher (every 5s, marks dead-PID PRDs as `killed`) — `server-main.ts:567-579` — silent DB write.
- Auto-build watcher (file/git triggers, pause-on-failure) — `server-main.ts:407-493, 216-226` — emits `daemon:auto-build:paused` only.
- Scheduler decisions (capacity-blocked, dependency-blocked, dequeue) — `packages/engine/src/scheduler.ts` — emits `queue:prd:discovered` only; capacity and dependency blocks are silent.

**Project context (AGENTS.md):** "Engine emits, consumers render" — the engine never writes to stdout; all communication flows through `EforgeEvent`s. The daemon is one consumer; the monitor UI is another. Workspace layout: `packages/engine`, `packages/monitor`, `packages/monitor-ui`, `packages/client` (shared HTTP/SSE), `packages/eforge` (CLI), `eforge-plugin/` (Claude Code plugin), `packages/pi-eforge/` (Pi extension).

**In-progress cross-build SSE infrastructure:** `GET /api/daemon-events` already exists (`packages/monitor/src/server.ts:313-349`) with a hardcoded allowlist (`packages/monitor/src/db.ts:136-152`) currently mixing `daemon:*` events with cross-build build events (`queue:prd:start`, `session:start`, etc.). UI consumer hook: `packages/monitor-ui/src/hooks/use-daemon-events.ts` + `daemon-reducer.ts`. SSE flow is poll-from-DB at 200ms (`server.ts:359-393`) — events flow only if persisted, which constrains the heartbeat design.

**Event vocabulary:** `EforgeEvent` is a Zod discriminated union on `type` defined in `packages/client/src/events.ts:278`. Naming convention is colon-delimited: `{namespace}:{subject}:{state}`. Existing daemon-scoped event: `daemon:auto-build:paused`. No heartbeat/keepalive exists today.

**Design conversation outcome:** A standalone plan file at `~/.claude/plans/there-is-a-build-zippy-sunrise.md` captures the full design, decisions, and slice ordering. This session plan is the build-ready compaction of that work.

## Goal

Emit a structured family of daemon-scoped events (lifecycle, scheduler decisions, recovery, orphan reaping, auto-build, errors) plus a live-only heartbeat, and surface them in the monitor UI via a header status pill and slide-out drawer so users can answer "is the daemon alive?" and "what is it doing?" at a glance.

## Approach

### Wire types (`packages/client/`)

- `packages/client/src/events.ts` — extend `EforgeEvent` Zod discriminated union (defined around line 278) with **17 new variants** (lifecycle×4, heartbeat, scheduler×3, auto-build×3 new + paused already exists, recovery×4, orphan×1, errors×2). Each variant follows the existing pattern: literal `type` plus inline payload fields (no `details` wrapper — payload-specific fields are inline like other event types). Add `// LIVE-ONLY: never persisted, never replayed` JSDoc on `daemon:heartbeat`.

**18 variants total** (17 new + the existing `daemon:auto-build:paused`):
- Lifecycle: `daemon:lifecycle:starting`, `:ready`, `:shutdown:start`, `:shutdown:complete`
- Heartbeat: `daemon:heartbeat` (live-only, never persisted)
- Scheduler: `daemon:scheduler:dequeued`, `:capacity-blocked`, `:dependency-blocked`
- Auto-build: `:enabled`, `:paused` (exists), `:resumed`, `:triggered`
- Recovery: `daemon:recovery:start`, `:run-marked-failed`, `:lock-removed`, `:complete`
- Orphan: `daemon:orphan:reaped`
- Errors: `daemon:warning`, `daemon:error`

### Persistence (`packages/monitor/`)

- `packages/monitor/src/db.ts` — extend `DAEMON_EVENT_TYPES` array (line 136-152) with all new persisted variants. Explicitly exclude `daemon:heartbeat`.
- `packages/monitor/src/server.ts` — in the `serveDaemonEventsSSE` handler (around line 313-349), add a 10s `setInterval` that iterates `daemonSubscribers` and writes `data: {...}\n\n` (no `id:` field, or `id: 0`) directly to each. Skip if `daemonSubscribers.size === 0`. `setInterval(...).unref()`. Clear on connection close. Payload assembled from `Date.now() - serverStartedAt`, `db` queries for queue depth and running runs, and `daemonState`.

### Daemon emission (`packages/monitor/src/server-main.ts`)

- Generate `daemonSessionId = "daemon-${pid}-${startedAt}"` at `main()` entry; reuse for all daemon-scoped events. FK is OFF per `db.ts:170`, so unmatched run_id is safe.
- Introduce `writeDaemonEvent(db, event)` helper modeled on the existing `writeAutoBuildPausedEvent`.
- Lifecycle: emit `:starting` before lockfile write (~246), `:ready` after `registerPort` (~541) including `recoveryDurationMs`, `:shutdown:start` at top of shutdown handler (~660), `:shutdown:complete` immediately before `process.exit(0)` (~676).
- Recovery: refactor `reconcileOrphanedState` (~124-179) to **return a structured report** instead of writing the single `phase:end` inline. Caller emits `:recovery:start`, then per-item `:run-marked-failed` and `:lock-removed`, then `:recovery:complete` with counts and duration. Keeping `reconcileOrphanedState` pure makes it unit-testable.
- Orphan watcher: emit `:orphan:reaped` from inside the 5s `setInterval` (~567-579), only when the watcher actually marks a run as killed.
- Auto-build: emit `:auto-build:enabled` and `:auto-build:resumed` from the toggle HTTP route (search `server.ts` for the auto-build PUT endpoint). Emit `:auto-build:triggered` from the watcher event drain (~407-493) when a trigger results in `prdsEnqueued > 0`. Emit `daemon:warning`/`daemon:error` from watcher catch blocks.

### Engine emission (`packages/engine/`)

- `packages/engine/src/scheduler.ts` (verify path — explore reported this location; confirm at implementation):
  - Push `daemon:scheduler:dequeued` immediately after `state.status='running'` is set in the dequeue path. Include `queueDepth` and remaining capacity.
  - Push `daemon:scheduler:capacity-blocked` when concurrency limit prevents start. **Dedupe per `tick()` invocation:** at most one such event per tick total.
  - Push `daemon:scheduler:dependency-blocked` when `isReady()` returns false in the start loop. **Dedupe per `(prdId)` per tick** to avoid multi-blocker spam.
  - Use the same `eventQueue.push(...)` pattern that the existing `queue:prd:discovered` emission uses (around line 226 per prior exploration).

### Monitor UI (`packages/monitor-ui/`)

- `packages/monitor-ui/src/lib/daemon-reducer.ts` — extend `DaemonState` with:
  - `daemonActivity: DaemonActivityEntry[]` (ring buffer, cap 500, drop oldest on overflow)
  - `latestHeartbeat: { at: number; payload: HeartbeatPayload } | null`
  - Add reducer cases for each new event type.
  - Add selectors `selectDaemonActivity`, `selectHeartbeatStaleness` (returns `'fresh' | 'stale' | 'dead'` based on age vs. now).
- `packages/monitor-ui/src/components/layout/header.tsx` (or wherever the global header is — verify) — render `<DaemonStatusPill />`.
- `packages/monitor-ui/src/components/daemon/daemon-status-pill.tsx` *(new)* — color from `selectHeartbeatStaleness`, relative time from `latestHeartbeat.at`, click opens drawer. Uses shadcn primitives.
- `packages/monitor-ui/src/components/daemon/daemon-drawer.tsx` *(new)* — shadcn `Sheet`. Two regions: latest heartbeat metrics panel (uptime, queue depth, running builds, auto-build state, subscriber count); activity feed listing `selectDaemonActivity` entries with a filter chip toggling `event.type.startsWith('daemon:')` vs all daemon-events.

### Tests (vitest, no mocks per AGENTS.md)

- `packages/client/src/__tests__/events.test.ts` — extend wire-event roundtrip for all 17 new variants.
- `packages/monitor/src/__tests__/db.test.ts` — assert `getDaemonEventsAfter` includes new persisted types and excludes `daemon:heartbeat`.
- `packages/engine/src/__tests__/scheduler.test.ts` (extend or create) — drive scheduler with synthetic PRDs against a real `EventEmitter`+`AsyncEventQueue`; assert capacity-blocked emits once per tick total, dependency-blocked dedupes per `(prdId)` per tick.
- `packages/monitor/src/__tests__/recovery-emit.test.ts` *(new)* — call refactored `reconcileOrphanedState` against synthetic DB + temp lock dir; assert it returns the expected structured report; separately assert the caller emits the expected event sequence.
- `packages/monitor-ui/src/lib/__tests__/daemon-reducer.test.ts` — feed each new event into reducer; assert ring-buffer cap; assert heartbeat staleness selector returns correct bucket at various ages.

### Honest test gaps (manual verification)

- 10s heartbeat cadence end-to-end: cover payload-assembly as a pure unit; verify cadence with `curl -N` and a stopwatch.
- Real `SIGTERM` shutdown emission: process-level, hard to vitest cleanly; verify manually.
- Pill color transitions over time: pure selector test possible; visual regression skipped.
- Drawer animation/drag: render-only test; interaction skipped.

### Patterns to reuse (no new abstractions needed)

- `writeAutoBuildPausedEvent` in monitor — pattern for the new `writeDaemonEvent` helper.
- `eventQueue.push({ type: 'queue:prd:discovered', ... })` in scheduler — pattern for new scheduler emissions.
- `subscribeToDaemonEvents` in `@eforge-build/client/browser` — already wired in `use-daemon-events`; no client-package changes needed.
- shadcn `Sheet` component for drawer — already in monitor-ui.
- `daemon-reducer` `ADD_EVENT` case — extend rather than introducing a parallel reducer.

### Patterns NOT to introduce

- No separate WebSocket or named-event channel for heartbeat — reuse existing SSE.
- No raw log file — events only.
- No new top-level UI route for daemon view — pill-in-header + drawer.
- No build-scoped event mixing — daemon events do not touch the per-build Log view.

### Design Decisions

**1. Heartbeat transport: in-memory push, live-only, never persisted.**

A `setInterval` inside the daemon-events SSE handler writes `daemon:heartbeat` envelopes directly to each subscriber's response stream, bypassing the DB.

Rationale: the existing SSE flow polls the DB every 200ms — events flow only if persisted. Persisting heartbeats would inflate the events table by ~6 rows/min/daemon-lifetime, pollute `getDaemonEventsAfter` replays (every reconnect would replay heartbeats since `last-event-id`), and the data is stateless and uninteresting historically. Live-only is the right shape: the heartbeat answers "is the daemon alive *now*?", not "was it alive at point X in history?".

Mechanic: use SSE `id: 0` (or omit `id:` entirely) so the existing `last-event-id` parser (which uses `parseInt` and filters ids ≤0) skips them on replay. DB-issued ids are always ≥1, so there is no collision risk. The wire shape matches the typed `EforgeEvent` contract so the UI's `ADD_EVENT` reducer handles heartbeats uniformly with persisted events.

Alternatives considered:
- Persist with aggressive trim — rejected: write volume + replay pollution for no benefit.
- SSE named events / comments (like `monitor:shutdown-pending`) — rejected: splits the UI data model, requires a separate listener and state slot, and treats heartbeat as different from other events when it really is just a frequent typed event.

**2. Scheduler decisions emitted from the engine, not the daemon.**

`daemon:scheduler:dequeued`, `:capacity-blocked`, `:dependency-blocked` are pushed by `QueueScheduler` into the existing event queue, and flow through the recording pipeline like any other event.

Rationale: per AGENTS.md "engine emits, consumers render" — the daemon is just one consumer of engine events. The scheduler is the only place that knows *why* it didn't dequeue (capacity vs. dependency); wrapping at the daemon level would require recreating that decision context. The engine already emits `queue:prd:discovered` to the same `eventQueue.push(...)` pattern, so this is an additive change near existing code.

Naming: `daemon:scheduler:*` (not `queue:scheduler:*` or `engine:scheduler:*`) is honest because the scheduler currently only runs inside the daemon's lifetime. If we ever extract the scheduler into a standalone process, we rename then.

Alternative considered: emit from a daemon-side wrapper that intercepts scheduler state — rejected: forces the scheduler to expose internal decision moments as side-channel hooks, duplicating logic.

**3. UI placement: header status pill + slide-out drawer.**

A persistent pill in the global header acts as the at-a-glance "alive" indicator (color + relative time, driven by latest heartbeat); clicking opens a slide-out shadcn `Sheet` containing the latest heartbeat metrics and a scrollable activity feed with a "daemon-only" filter chip.

Rationale: the user's stated questions are "is the daemon alive?" (glance-able — pill) and "what is it doing?" (drill-down — drawer). A top-level route is overkill for meta-information. A dashboard tab buries the alive-check behind navigation. A pill in the header is the cheapest possible always-visible affordance.

Alternatives considered:
- Mix daemon events into the per-build Log view with a "Show daemon events" checkbox (mirroring "Show agent events") — rejected (this was the user's first idea): the Log view is build-scoped, every event is contextually about *this build's lifecycle*, and daemon events are inherently cross-build (scheduler ticks, heartbeats, lifecycle). Mixing would also hide the daemon view exactly when you need it most: when no build is running.
- Top-level `/daemon` route — rejected: breaks the at-a-glance goal, requires nav plumbing.
- Dashboard tab alongside build list — rejected: same hide-behind-nav problem.

**4. Event taxonomy: structured typed events, not raw log tailing.**

A curated set of ~18 typed events covering lifecycle, heartbeat, scheduler decisions, recovery, orphan reaping, auto-build, and errors. No `daemon:scheduler:tick` (would flood). No raw daemon log file tailing.

Rationale: the user's original framing was "tail the daemon log file". Per AGENTS.md "engine emits, consumers render" — the daemon is consistent with the engine in this regard. Raw log lines are noisy, lose structure, and don't compose with the existing typed-event UI primitives. Structured events compose naturally with the existing `EforgeEvent` discriminated union, the `daemon-reducer`, and the `EventCard` rendering.

The `daemon:scheduler:tick` exclusion is deliberate: heartbeat proves the loop is alive; decision events prove it is doing its job. Adding tick events would inflate the stream without information value.

**5. Existing allowlist scope-mixing kept as-is.**

`DAEMON_EVENT_TYPES` continues to carry both true `daemon:*` events AND build-scoped events relevant cross-build (`queue:prd:start`, `session:start`, etc.). Discrimination happens at the UI layer via the drawer's filter chip.

Rationale: the existing semantics ("the daemon-events stream is the cross-build firehose") remain useful — users want to see "the daemon dequeued build X" alongside "build X session started". Filtering at render time is a one-liner; filtering at allowlist time loses information.

**6. Daemon session ID for daemon-scoped events.**

Generate one `daemonSessionId = "daemon-${pid}-${startedAt}"` at `main()` entry; reuse for all daemon-scoped events.

Rationale: lifecycle events fire before any watcher session exists. The DB has `PRAGMA foreign_keys = OFF` (db.ts:170 with explicit comment about daemon-level events), so unmatched run_id is safe. Stable per-daemon-lifetime ID makes daemon-scoped events filterable and aggregatable in queries.

**7. Recovery refactor: structured report instead of inline emission.**

Refactor `reconcileOrphanedState` to return `{ runsFailed: [...], locksRemoved: [...], durationMs }` instead of emitting `phase:end` inline. The caller emits the recovery event sequence.

Rationale: separation of concerns (I/O vs. emission) makes the function unit-testable against a synthetic DB without an SSE bus. Pattern is the same one used elsewhere in the codebase for testable engine logic.

### Architecture Impact

**No new module boundaries.** The change adds events to the existing `EforgeEvent` discriminated union, extends the existing `DAEMON_EVENT_TYPES` allowlist, and adds emission inside existing modules (`packages/monitor/src/server-main.ts`, `packages/engine/src/scheduler.ts`). The UI surface is two new components inside `packages/monitor-ui/`.

**No changed contracts:**
- The `/api/daemon-events` HTTP/SSE contract is additive: new event `type` literals appear, but the envelope shape is unchanged. Subscribers that don't recognize a type can ignore it (existing reducer behavior).
- `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` does **not** need bumping — additive event types are not a breaking change to the HTTP API surface.
- The `EforgeEvent` Zod union is additive; existing variants are untouched.

**Changed data flow (one inversion):** `reconcileOrphanedState` is refactored from emit-inline to return-a-structured-report. The caller in `server-main.ts` becomes responsible for the event sequence. This is internal to the monitor package and not visible to other packages.

**Public API surface:** Unchanged for CLI users (no new commands), unchanged for `eforge-plugin/`, unchanged for `packages/pi-eforge/`. The `/api/daemon-events` SSE consumers (currently `monitor-ui`) get richer events; if any third-party consumers exist they continue to work since the change is additive.

**Deployment / operational changes:** None. No new env vars, no new config keys, no new ports, no migrations. The DB schema is unchanged (`events.type` is already a free-form TEXT column; the allowlist is in code, not in the DB).

**Engine ↔ daemon boundary:** Reinforced, not weakened. Scheduler emission goes through the same `eventQueue.push(...)` pipeline as other engine events; the daemon consumes via the existing recording infrastructure. No engine code learns about the daemon.

**SSE infrastructure:** One new pattern introduced — direct in-memory writes to subscribers bypassing the DB poll loop, used only for `daemon:heartbeat`. Documented in code with a JSDoc note. This is a small, contained exception to the otherwise uniform "events flow via DB poll" rule.

### Documentation Impact

**Files that need updating:**

- `README.md` (repo root) — if it lists daemon features or monitor UI capabilities, add a brief mention of the daemon status pill and activity drawer. Likely a small one-paragraph addition near any existing monitor UI screenshot section.
- `AGENTS.md` — no change required. The "engine emits, consumers render" principle this work follows is already documented; this work is an instance of it, not a new pattern.
- `docs/roadmap.md` — review on completion: if there is an "observability" or "daemon visibility" item, mark it complete and remove per the "Future only" rule. If no such item exists, no change needed.
- `eforge-plugin/` README or docs — no change. The plugin is a thin launcher; no user-visible plugin behavior changes.
- `packages/pi-eforge/` README or docs — no change. Pi extension surface is unaffected.

**Files explicitly NOT impacted:**

- `CHANGELOG.md` — managed by the release flow per project convention; do not edit in this work.
- `eforge-plugin/.claude-plugin/plugin.json` version — bump only if plugin behavior changes, which it does not in this work.
- Any per-skill `SKILL.md` files — daemon events are not surfaced through skills.

**Inline code documentation (in-scope for this work, not separate docs):**

- JSDoc on `daemon:heartbeat` Zod variant explicitly noting "LIVE-ONLY: never persisted, never replayed".
- JSDoc on the in-memory heartbeat timer in `server.ts` explaining why it bypasses the DB poll loop (links to the design decision).
- JSDoc on the refactored `reconcileOrphanedState` clarifying that it returns a structured report and the caller is responsible for emission.
- Comment near `DAEMON_EVENT_TYPES` in `db.ts` noting that `daemon:heartbeat` is intentionally absent.

### Risks

**1. Heartbeat replay invariant.** SSE `last-event-id` parsing in `serveDaemonEventsSSE` (~line 322) uses `parseInt`; ids ≤0 are filtered there already. Using `id: 0` (or omitting `id:` entirely) for heartbeats keeps replay invariants. If we accidentally include an `id:` derived from anything that could exceed an existing DB row id, the next reconnect's replay logic could skip legitimate events. **Mitigation:** explicit unit/integration test that reconnects with a `last-event-id` after heartbeats have flowed, asserting all persisted events still replay.

**2. Scheduler event spam from emit-on-every-await.** A naive `:capacity-blocked` emission inside the semaphore await loop will fire dozens of times per tick. Same for `:dependency-blocked` if multiple PRDs share a blocker. **Mitigation:** Set keyed on `tick-id` for capacity, keyed on `(prdId, tick-id)` for dependency. Test asserts at most one capacity-blocked per tick and one dependency-blocked per `(prdId)` per tick.

**3. Recovery emission ordering.** `:recovery:start` must precede the loop, `:recovery:complete` must follow with accurate counts and duration. Per-item events must interleave correctly. **Mitigation:** the structured-report refactor makes `reconcileOrphanedState` pure (returns the report); the caller emits the sequence. Test asserts the sequence: start → N×(run-marked-failed | lock-removed) → complete with matching counts.

**4. DaemonState sessionId before any session exists.** Lifecycle `:starting` fires before any watcher session is created. **Mitigation:** generate `daemonSessionId = "daemon-${pid}-${startedAt}"` at `main()` entry, stash, reuse. FK is OFF in DB so unmatched run_id is safe.

**5. Heartbeat timer leaks on subscriber churn.** If the timer is created per-subscriber but not cleared when that subscriber disconnects, old timers continue writing to closed streams. **Mitigation:** one timer per server instance (not per subscriber); iterate the live `daemonSubscribers` set on each tick; let the underlying Node.js write handle dead-stream errors. Skip the entire iteration if the set is empty.

**6. Backward compatibility with existing UI.** The `daemon-reducer`'s `ADD_EVENT` case currently handles a known set of types; an unknown new type may either no-op or warn. **Mitigation:** verify the existing reducer's unknown-type behavior; if it warns, ensure new types are explicitly handled.

**7. Heartbeat payload assembly cost.** The payload requires DB queries (queue depth, running runs) every 10s. **Mitigation:** these queries are O(1) on indexed columns; if measured cost is non-trivial we can cache in `daemonState` and refresh on mutations. Skip entirely when `daemonSubscribers.size === 0`.

**8. SSE stream pollution from frequent heartbeats during long sessions.** With multiple subscribers (multiple monitor UI tabs), heartbeats × subscribers can be visible in network tabs. **Mitigation:** 10s cadence is conservative; if needed we can scale based on subscriber count or extend to 15-30s in a future iteration. Not a correctness issue.

**9. Partial implementation on multi-PRD orchestration.** This work is internally a single coherent change; eforge will likely apply it as one PRD. If the build splits it, the post-split PRD must carry the full acceptance criteria. **Mitigation:** acceptance criteria are written as a single complete checklist.

**10. Engine's `eventQueue.push` from scheduler missing sessionId/runId context.** Scheduler decisions emit during a build context but conceptually belong to the daemon. **Mitigation:** reuse the watcher session context that's already in scope, matching how `daemon:auto-build:paused` is currently emitted. The daemon-only filter is at render time in the UI, not at emission time.

**11. Existing `phase:end` emission inside `reconcileOrphanedState`.** Refactoring this away may change downstream consumers that listen for the synthetic `phase:end`. **Mitigation:** preserve the `phase:end` emission for backward compatibility — the caller emits it alongside the new `daemon:recovery:run-marked-failed`. The two convey different things: `phase:end` says "this run is terminal", `:run-marked-failed` says "the daemon decided this run is dead".

### Profile Signal

**Recommendation: Excursion.**

Rationale:
- Multi-package change: `packages/client` (types), `packages/monitor` (persistence + transport + emission), `packages/engine` (scheduler emission), `packages/monitor-ui` (reducer + components).
- Multiple coordinated emission points across distinct call sites (lifecycle, recovery, orphan watcher, auto-build, scheduler).
- New UI components (status pill + drawer) plus reducer extensions, but using existing shadcn primitives — no new design system work.
- Bounded scope: no architectural restructuring, no new transport protocols, no new external surfaces.

Not Errand: too many distinct call sites and packages; not mechanical.

Not Expedition: change is additive and bounded to one observability surface; does not span 4+ independent subsystems or introduce cross-cutting architectural change. The "engine emits, consumers render" boundary is reinforced rather than crossed.

Slice ordering (in scope as a single PRD; if eforge splits, slices must each carry the full acceptance criteria):
1. Types + persisted events end-to-end (no UI). Independently valuable: `curl /api/daemon-events` shows the new events.
2. Heartbeat transport (in-memory push in `server.ts`).
3. Header status pill (drawer can be a stub).
4. Scheduler decisions with dedup.
5. Drawer polish + filter chip.

## Scope

### In scope

1. New `daemon:*` event family added to the `EforgeEvent` discriminated union in `packages/client/src/events.ts`. 18 variants total (17 new + the existing `daemon:auto-build:paused`):
   - Lifecycle: `daemon:lifecycle:starting`, `:ready`, `:shutdown:start`, `:shutdown:complete`
   - Heartbeat: `daemon:heartbeat` (live-only, never persisted)
   - Scheduler: `daemon:scheduler:dequeued`, `:capacity-blocked`, `:dependency-blocked`
   - Auto-build: `:enabled`, `:paused` (exists), `:resumed`, `:triggered`
   - Recovery: `daemon:recovery:start`, `:run-marked-failed`, `:lock-removed`, `:complete`
   - Orphan: `daemon:orphan:reaped`
   - Errors: `daemon:warning`, `daemon:error`

2. Emission wiring at the relevant call sites in `packages/monitor/src/server-main.ts` (lifecycle, recovery, orphan watcher, auto-build extensions, errors) and `packages/engine/src/scheduler.ts` (scheduler decisions).

3. Persistence: extend `DAEMON_EVENT_TYPES` allowlist in `packages/monitor/src/db.ts` to include all new variants **except** `daemon:heartbeat`.

4. Heartbeat transport: new in-memory push timer in `packages/monitor/src/server.ts` that writes a `daemon:heartbeat` envelope directly to each daemon-events SSE subscriber every ~10s, bypassing the DB.

5. Monitor UI surface:
   - Header status pill (`<DaemonStatusPill />`) — color-coded by heartbeat staleness (green <15s, amber <30s, red older), shows relative-time, click opens drawer.
   - Slide-out drawer (`<DaemonDrawer />`) using shadcn `Sheet` — latest heartbeat metrics panel + scrollable activity feed with "daemon-only" filter chip toggling `event.type.startsWith('daemon:')`.
   - `daemon-reducer` extensions: `daemonActivity` ring buffer (cap ~500), `latestHeartbeat`, selectors `selectDaemonActivity`, `selectHeartbeatStaleness`.

6. Vitest coverage for: events.ts roundtrip, `getDaemonEventsAfter` allowlist behavior, scheduler emission with dedup, recovery emission ordering, daemon-reducer state transitions and ring-buffer cap.

### Out of scope

1. **No retention loop.** `daemon:retention:complete` is deferred — no retention loop exists in the daemon today; we will not add one just to fire an event.
2. **No `daemon:scheduler:tick` event.** Heartbeat proves the loop is alive; emitting a tick event per scheduler iteration would flood the stream.
3. **No new transport for heartbeat.** Reuses the existing daemon-events SSE handler; does not introduce a separate WebSocket or named-event channel.
4. **No changes to the per-build Log view.** Daemon events do not appear in the per-build Log; they live exclusively in the new drawer. The existing "Show agent events" checkbox is untouched.
5. **No CLI surface.** No new `eforge daemon-events tail` command in this work.
6. **No Pi extension parity work.** `packages/pi-eforge/` does not need a UI; if it consumes daemon events it does so through the same `/api/daemon-events` endpoint, no extension-specific work required.
7. **No log-file tailing.** The user's original framing was "tail the daemon log file" — we explicitly chose structured events over raw log tailing per the engine-emits/consumers-render principle.
8. **No changes to the existing `DAEMON_EVENT_TYPES` cross-scope mixing.** The allowlist will continue to carry `queue:prd:*` and `session:*` build-scoped events. The drawer's "daemon-only" filter discriminates at render time, not at allowlist time.

**Natural boundaries.** Engine package emits scheduler events; monitor package emits all other daemon events; client package owns the type union; monitor-ui package owns the rendering surface. No changes to `eforge-plugin/` or `packages/pi-eforge/` are required.

**Roadmap relation.** This is incremental observability work that complements the queue-first daemon architecture (see project memory `project_queue_first_architecture.md`); not a new roadmap item, but enables the daemon to be the visible "control plane" the architecture envisions.

## Acceptance Criteria

All conditions must be testable from a fresh daemon start.

### Wire-level (verifiable with `curl -N http://localhost:PORT/api/daemon-events`)

1. On daemon start, the SSE stream emits `daemon:lifecycle:starting` then `daemon:lifecycle:ready` (with `{pid, port, version, mode, recoveryDurationMs}`).
2. On daemon shutdown via SIGTERM, the SSE stream emits `daemon:lifecycle:shutdown:start` (with `{signal, reason}`) then `daemon:lifecycle:shutdown:complete` (with `{durationMs}`) before the process exits.
3. Restarting the daemon while a build was running emits the full recovery sequence: `daemon:recovery:start`, one `daemon:recovery:run-marked-failed` per orphaned run, zero or more `daemon:recovery:lock-removed`, then `daemon:recovery:complete` with accurate counts and `durationMs`.
4. The orphan watcher emits `daemon:orphan:reaped` only when it actually marks a run as killed; it does not emit on no-op ticks.
5. Enqueueing more PRDs than the concurrency limit produces exactly one `daemon:scheduler:capacity-blocked` event per scheduler tick (deduped), with `{queueDepth, runningCount, limit}`.
6. A PRD with an unmet dependency produces exactly one `daemon:scheduler:dependency-blocked` per `(prdId, tick)` pair (deduped), with `{prdId, blockedBy[]}`.
7. Successfully starting a PRD emits `daemon:scheduler:dequeued` with `{prdId, queueDepth, capacityRemaining}` after `state.status='running'` is set.
8. Toggling auto-build on emits `daemon:auto-build:enabled`; resuming after a pause emits `daemon:auto-build:resumed`; a file/git trigger that enqueues PRDs emits `daemon:auto-build:triggered` with `{trigger, prdsEnqueued}`.
9. While at least one daemon-events SSE subscriber is connected, the server pushes `daemon:heartbeat` envelopes approximately every 10 seconds with `{uptime, queueDepth, runningBuilds, autoBuild, subscribers}`.
10. `daemon:heartbeat` events are NOT persisted to the events table and do NOT appear in `getDaemonEventsAfter` replays. SSE clients reconnecting with `last-event-id` do not replay any heartbeats.

### UI-level (verifiable in the monitor UI)

11. A daemon status pill is visible in the global header at all times the UI is mounted.
12. The pill is green when the most recent heartbeat is <15s old, amber 15-30s, red >30s. It displays a relative-time string ("alive 2s ago").
13. Clicking the pill opens a slide-out drawer containing a latest-heartbeat metrics panel and a scrollable activity feed.
14. The drawer's filter chip toggles between "all cross-build events" and "daemon-only" (`event.type.startsWith('daemon:')`).
15. The activity feed shows new events live as they arrive on the SSE stream; the ring buffer caps at ~500 entries.
16. After a daemon restart with running builds, the drawer's activity feed shows the recovery sequence in order.

### Test suite

17. `pnpm test` passes, including new vitest coverage for: events.ts wire roundtrip of all 17 new variants; `getDaemonEventsAfter` includes all persisted variants and excludes `daemon:heartbeat`; scheduler dedup behavior under synthetic PRD load; recovery emission ordering against a synthetic DB + temp lock dir; daemon-reducer state transitions and ring-buffer cap.
18. `pnpm type-check` passes.
19. `pnpm build` produces a working CLI bundle.

### Non-functional

20. No regressions in the per-build Log view: existing event filtering ("Show agent events") and rendering remain unchanged.
21. Heartbeat timer is cleared on connection close (no leaked intervals on subscriber churn).
22. Heartbeat skips work entirely when `daemonSubscribers.size === 0` (no useless DB queries).
