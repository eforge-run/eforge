---
title: Event-driven queue manager
created: 2026-04-01
---

# Event-driven queue manager

## Problem / Motivation

When `prdQueue.parallelism > 1`, PRDs enqueued while a build cycle is running sit idle until the cycle finishes. The root cause is that `runQueue()` snapshots the queue once at startup and `watchQueue()` is a poll-sleep loop around it. This means available parallelism slots go unused until the current cycle completes and the daemon respawns the watcher.

## Goal

Replace the snapshot + poll model with an event-driven queue manager so that newly enqueued PRDs are discovered and started within seconds, filling available parallelism slots as they free up.

## Approach

Two events trigger the scheduler to check for work:

1. **Build complete/failed/skipped** - a slot freed; re-scan queue, call `startReadyPrds()`
2. **File change in queue directory** - `fs.watch` detects a new PRD; re-scan queue, call `startReadyPrds()`

### Lifecycle changes

**Current model**: Daemon spawns `eforge run --queue --auto --no-monitor` (single `runQueue()` cycle). Watcher exits after processing, daemon respawns it.

**New model**: Daemon spawns `eforge run --queue --watch --auto --no-monitor` (long-lived). The `watchQueue()` method uses `fs.watch` instead of poll-sleep, keeping the process alive. The process exits only when the daemon sends SIGTERM (handled by `setupSignalHandlers()` which fires the abort controller).

The daemon's existing state machine controls shutdown:
- `WATCHING -> COUNTDOWN -> SHUTDOWN` based on idle timeout (`daemon.idleShutdownMs`, default 2 hours)
- Countdown is 60s with web monitor subscribers, 10s without
- Keep-alive from UI resets countdown
- On shutdown, daemon sends SIGTERM to watcher - abort signal fires - `watchQueue()` drains in-flight builds and exits

The daemon no longer needs respawn logic for the watcher since it is long-lived. The respawn code stays for crash recovery (non-zero exit).

### File changes

#### 1. `src/engine/events.ts` (~line 272)

Add to `QueueEvent` union:
```typescript
| { type: 'queue:prd:discovered'; prdId: string; title: string }
```

Remove poll-based events (no longer needed):
```typescript
| { type: 'queue:watch:waiting'; pollIntervalMs: number }
| { type: 'queue:watch:poll' }
| { type: 'queue:watch:cycle'; processed: number; skipped: number }
```

#### 2. `src/engine/eforge.ts` - `runQueue()`

**a. Make `orderedPrds` mutable** (line 918): so discovered PRDs can be appended.

**b. Add `discoverNewPrds()` helper** (local to `runQueue`):
- `loadQueue(queueDir, cwd)` + `resolveQueueOrder()` for a fresh snapshot
- For each PRD not in `prdState`: resolve deps, add to `prdState` as pending, append to `orderedPrds`, push `queue:prd:discovered` event to `eventQueue`
- Return count of new PRDs

**c. On `queue:prd:complete`** (line 1059): call `await discoverNewPrds()` before `startReadyPrds()`. Handles "slot freed, new PRD may have arrived."

#### 3. `src/engine/eforge.ts` - `watchQueue()`

Replace the poll-sleep loop with `fs.watch`:

```
watchQueue():
  1. Initial scan + startReadyPrds() (via inline scheduler, same logic as runQueue)
  2. Set up fs.watch on queue dir (debounced ~500ms)
  3. Register watcher as producer on eventQueue
  4. On file change: discoverNewPrds() + startReadyPrds()
  5. On abort signal: close watcher, removeProducer()
  6. Event consumer loop yields until all producers done
  7. Emit queue:complete
```

The `fs.watch` producer keeps the event consumer alive until abort fires. Build completions trigger `discoverNewPrds()` + `startReadyPrds()` as in `runQueue()`.

Alternative considered: move the scheduler logic that currently lives in `runQueue()` into `watchQueue()` directly, and have `runQueue()` call `watchQueue()` with a "single cycle" flag. This avoids duplicating the scheduler. The single-cycle flag would skip `fs.watch` setup and let the event consumer terminate when all builds are done.

#### 4. `src/monitor/server-main.ts` - Daemon watcher spawn (~line 278)

Change spawn command to include `--watch`:
```typescript
const child = spawn('eforge', ['run', '--queue', '--watch', '--auto', '--no-monitor'], {
```

Remove the `setTimeout(() => spawnWatcher())` respawn-on-clean-exit logic (lines 331-336), since the watcher is long-lived. Keep the respawn for crash recovery (non-zero exit).

#### 5. `src/cli/display.ts`

Add case for `queue:prd:discovered`:
```typescript
case 'queue:prd:discovered':
  console.log(chalk.dim(`  Discovered new PRD: ${chalk.cyan(event.title)}`));
  break;
```

Remove cases for `queue:watch:waiting`, `queue:watch:poll`, `queue:watch:cycle`.

#### 6. Tests

**`test/greedy-queue-scheduler.test.ts`** - add:
- Discovery on completion: parallelism=2, one PRD initially, write second mid-build, verify `queue:prd:discovered`
- No discovery without new files: verify idempotent re-scan

**`test/watch-queue.test.ts`** - update:
- Remove tests for removed poll events
- Add test: abort signal causes clean exit with `queue:complete`
- Add test: `fs.watch` discovers newly-written PRD file

## Scope

### In scope
- Replacing the poll-sleep loop in `watchQueue()` with `fs.watch`
- Adding `discoverNewPrds()` helper to `runQueue()` for mid-cycle discovery
- Adding `queue:prd:discovered` event type
- Removing `queue:watch:waiting`, `queue:watch:poll`, and `queue:watch:cycle` events
- Updating daemon watcher spawn to use `--watch` flag for a long-lived process
- Removing daemon respawn-on-clean-exit logic (keeping crash recovery respawn)
- Updating CLI display for new/removed events
- New and updated tests for discovery and watch behavior

### Out of scope
- Changes to the daemon state machine (`WATCHING -> COUNTDOWN -> SHUTDOWN`)
- Changes to the abort/signal handling infrastructure (`setupSignalHandlers()`, abort controller)
- Changes to `startReadyPrds()` or the greedy scheduler algorithm itself
- Changes to parallelism configuration or queue ordering logic

## Acceptance Criteria

1. `pnpm type-check` passes
2. `pnpm test` - all existing and new tests pass
3. `pnpm build` - clean build
4. Manual verification: start daemon with `parallelism: 2`, enqueue PRD-A, wait for build to start, enqueue PRD-B, verify PRD-B starts within seconds (not waiting for PRD-A to complete)
5. `queue:prd:discovered` event is emitted when a new PRD file appears in the queue directory
6. `discoverNewPrds()` is called on build completion before `startReadyPrds()`, so newly arrived PRDs fill freed slots
7. `fs.watch` on the queue directory (debounced ~500ms) triggers discovery and scheduling of new PRDs
8. The watcher process is long-lived and exits only on SIGTERM (abort signal), draining in-flight builds before exiting
9. Poll-based events (`queue:watch:waiting`, `queue:watch:poll`, `queue:watch:cycle`) are fully removed from event types, CLI display, and tests
10. Daemon respawns the watcher only on non-zero exit (crash recovery), not on clean exit
