---
id: plan-01-parent-owns-session-id
name: Parent scheduler owns sessionId and emits session:start at spawn
depends_on: []
branch: close-the-cold-start-black-hole-in-auto-build/parent-owns-session-id
---

# Parent scheduler owns sessionId and emits session:start at spawn

## Architecture Context

The eforge auto-build pipeline spawns a child Node subprocess per PRD. Each child runs `eforge queue exec <prdId>` which invokes `EforgeEngine.buildSinglePrd`. Today, the **child** generates its own `sessionId` via `randomUUID()` inside `buildSinglePrd` and is the first party to emit `session:start`. The monitor's `withRecording` sink converts `session:start` into a `runs` row.

Because the child must finish Node import + module load + `EforgeEngine.create()` + backend init before it can emit anything, there is a 15-60s window post-spawn where:

- A queue lock file exists, so `/api/queue` marks the PRD `status='running'` and the Queue panel filter (correctly) hides it.
- No `runs` row exists yet, so the Sessions sidebar shows nothing.

The fix shifts ownership of the `sessionId` to the parent scheduler. The parent generates the UUID, emits `session:start` onto its own event queue (where `withRecording` picks it up within ms), and passes the UUID to the child via `--session-id`. The child uses the injected id and skips its own `session:start` emission so the DB row is not double-created.

No changes are needed to `withRecording`, the Sessions sidebar query, or the Queue panel filter - those layers already do the right thing once the parent's `session:start` lands.

## Implementation

### Overview

1. Parent path (`packages/engine/src/eforge.ts`): in both `watchQueue -> startReadyPrds` and `runQueue -> startReadyPrds`, generate `const prdSessionId = randomUUID()` at the moment a PRD transitions to `running`, push a `session:start` event onto the scheduler's `eventQueue`, and thread `prdSessionId` through `spawnPrdChild`.
2. Spawn path (`packages/engine/src/eforge.ts` `spawnPrdChild`): accept `prdSessionId` and append `'--session-id', prdSessionId` to the child `args`.
3. Child CLI (`packages/eforge/src/cli/index.ts` `queue exec` subcommand): accept `--session-id <uuid>` option, forward it to `buildSinglePrd`.
4. Child engine entry (`packages/engine/src/eforge.ts` `buildSinglePrd`): accept optional `sessionId?: string`. When provided, use it verbatim and do NOT emit `session:start` (parent already did). When absent (direct programmatic invocation paths), keep existing behavior - generate a new UUID and emit `session:start`.
5. `session:end` continues to be emitted by the child - it is still the authoritative party for terminal state.
6. Update or add tests that assert on the above.

### Key Decisions

1. **Parent emits `session:start`, child emits `session:end`.** The parent knows first that a PRD has transitioned to `running`; the child knows last what the terminal outcome is. Splitting the two terminal events across the process boundary matches who-holds-the-information.
2. **`sessionId` is passed as a CLI flag, not an env var.** Env vars leak to grandchildren and are harder to inspect in `ps`. The `--session-id` flag is explicit in the process tree and matches the existing style of `queue exec` options (`--auto`, `--verbose`, `--no-monitor`, `--no-plugins`).
3. **`buildSinglePrd` keeps `sessionId` optional.** Programmatic callers (tests, direct API use, any future in-process invocation) still work without an injected id. Only the spawn path uses the injection.
4. **Suppress child `session:start` only when `sessionId` is injected.** The branch condition is `if (sessionId === undefined) yield sessionStart`. If a caller ever passes an explicit id without separately emitting `session:start`, that is on the caller - but the spawn path is the only place that does this and it emits on the parent side.
5. **Both scheduler paths change identically.** `watchQueue` (daemon/auto-build) and `runQueue` (one-shot CLI `queue run`) both call `spawnPrdChild` via a nested `startReadyPrds`. Keeping them symmetric avoids surprises where the one-shot path exhibits the old black-hole behavior.

## Scope

### In Scope

- `packages/engine/src/eforge.ts`:
  - `watchQueue` / its `startReadyPrds`: generate `prdSessionId`, push `session:start` onto `eventQueue`, pass id to `spawnPrdChild`.
  - `runQueue` / its `startReadyPrds`: identical treatment for the non-watcher path.
  - `spawnPrdChild`: accept `prdSessionId: string`, append `'--session-id', prdSessionId` to `args`.
  - `buildSinglePrd`: add optional `sessionId?: string`; use `sessionId ?? randomUUID()`; skip the in-child `session:start` yield when `sessionId` was injected.
- `packages/eforge/src/cli/index.ts`:
  - `queue exec` subcommand: add `.option('--session-id <uuid>', ...)`, forward the parsed value into the `buildSinglePrd` call.
- Tests under `test/`:
  - `test/agent-wiring.test.ts`, `test/greedy-queue-scheduler.test.ts`, `test/reconciler.test.ts`: update any assertion that expects `buildSinglePrd` to unconditionally emit `session:start`, so the suite still passes when `sessionId` is injected.
  - Add at least one assertion that, when `sessionId` is injected into `buildSinglePrd`, no `session:start` event is yielded and all downstream events carry the injected id.
  - Add at least one assertion that `spawnPrdChild` appends `--session-id <uuid>` to its child args (can be verified by inspecting the args array the function would spawn, without actually spawning).

### Out of Scope

- Changes to `withRecording` or any monitor-side SQLite persistence layer.
- Changes to where `session:end` is emitted.
- Changes to the Queue panel `/api/queue` `status='running'` filter.
- Changes to the Sessions sidebar query in `packages/monitor-ui`.
- Refactoring the scheduler structure beyond the minimal edits described above.
- Any new config surface (the behavior is always-on; there is no reason to gate it).

## Files

### Modify

- `packages/engine/src/eforge.ts` - parent-side sessionId ownership: `watchQueue`/`startReadyPrds`, `runQueue`/`startReadyPrds`, `spawnPrdChild`, `buildSinglePrd`. Keep all other behavior identical.
- `packages/eforge/src/cli/index.ts` - `queue exec` subcommand parses `--session-id <uuid>` and passes it to `engine.buildSinglePrd`.
- `test/agent-wiring.test.ts` - adjust any assertion that asserts unconditional `session:start` emission from `buildSinglePrd`.
- `test/greedy-queue-scheduler.test.ts` - adjust any assertion that asserts unconditional `session:start` emission from `buildSinglePrd`; add coverage for parent-side `session:start` emission and `--session-id` propagation to child args.
- `test/reconciler.test.ts` - adjust if any assertion depends on child-emitted `session:start`.

### Create

- None. All new test assertions can live inside existing test files alongside related cases.

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `pnpm test` exits 0, including `test/agent-wiring.test.ts`, `test/greedy-queue-scheduler.test.ts`, and `test/reconciler.test.ts`.
- [ ] Reading `packages/engine/src/eforge.ts`: `watchQueue`'s `startReadyPrds` contains a call to `randomUUID()` and a yield/push of a `session:start` event on the scheduler `eventQueue` before `spawnPrdChild(...)` is invoked, and passes the id to `spawnPrdChild`.
- [ ] Reading `packages/engine/src/eforge.ts`: `runQueue`'s `startReadyPrds` contains the same three edits.
- [ ] Reading `packages/engine/src/eforge.ts`: `spawnPrdChild` signature includes a `prdSessionId: string` parameter and the constructed child `args` array includes the literal strings `'--session-id'` and the value of `prdSessionId`.
- [ ] Reading `packages/engine/src/eforge.ts`: `buildSinglePrd` signature accepts an optional `sessionId?: string`; the line previously reading `const prdSessionId = randomUUID()` now reads `const prdSessionId = sessionId ?? randomUUID()`; the `yield { type: 'session:start', ... }` inside `buildSinglePrd` is guarded by a check that the `sessionId` parameter was undefined.
- [ ] Reading `packages/eforge/src/cli/index.ts`: the `queue exec` subcommand declares an option `--session-id <uuid>` and the parsed value is forwarded to the `buildSinglePrd` call.
- [ ] A test asserts that when `buildSinglePrd` is invoked with an explicit `sessionId`, the emitted event stream contains zero `session:start` events.
- [ ] A test asserts that `spawnPrdChild` produces a child `args` array containing both `'--session-id'` and the exact UUID string passed in.
- [ ] A test asserts that when the scheduler transitions a PRD to `running`, a `session:start` event with the same UUID is pushed onto its `eventQueue` before the child is spawned.