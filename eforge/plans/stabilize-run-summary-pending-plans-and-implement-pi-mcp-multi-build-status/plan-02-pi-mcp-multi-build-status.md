---
id: plan-02-pi-mcp-multi-build-status
name: Pi Extension and MCP Proxy Multi-Build Status Awareness
branch: stabilize-run-summary-pending-plans-and-implement-pi-mcp-multi-build-status/plan-02-pi-mcp-multi-build-status
---

# Pi Extension and MCP Proxy Multi-Build Status Awareness

## Architecture Context

Today's Pi footer status and the `eforge_status` tool (both Pi and MCP variants) assume a single preferred run via `getPreferredRun(cwd)` — the first run from `/api/runs` whose `status === 'running'`. When more than one session is concurrently running (the default given `maxConcurrentBuilds: 2`), the footer and status output silently mask the other build. The Pi `checkActiveBuilds` helper has the same single-run blind spot.

This plan adds first-class multi-build awareness across three layers:
- **Shared client helpers** (`packages/client/src/api/queue.ts`): `apiGetRunningRuns` and `apiGetRunningSessionSummaries` so the Pi extension and MCP proxy do not duplicate filtering logic. Re-exported from the package root.
- **Pi extension** (`packages/pi-eforge/extensions/eforge/index.ts`): extracts pure helpers (`aggregateRunningSummaries`, `formatSingleBuildFooter` (renamed from `formatBuildFooter`), `formatAggregateFooter`, `checkActiveBuildsMessage`) that the new unit test file can exercise without registering an extension. Rewrites `refreshStatus`, `checkActiveBuilds`, and the `eforge_status` tool to consume the shared helpers.
- **MCP proxy** (`packages/eforge/src/cli/mcp-proxy.ts`): rewrites the `eforge_status` tool and the `eforge_daemon` action `stop`/`restart` `checkActiveBuilds` to use the shared helpers, mirroring the Pi response shape and active-builds messaging.

Depends on plan-01 because:
- The aggregate denominator `pending + running + completed + failed` requires `RunSummary.plans[]` to include pending entries seeded from `planning:complete`.
- The TypeScript `plan.status` switch in the Pi renderer needs the `'pending'` literal in `RunSummary.plans[].status`.

Key existing seams (current `main`):
- `packages/pi-eforge/extensions/eforge/index.ts` lines 115–193 hold `formatBuildFooter`, `formatQueueFooter`, `getPreferredRun`, and `checkActiveBuilds`. Lines 277–349 hold the `refreshStatus` polling loop. Lines 604–646 hold the `eforge_status` tool `execute`; lines 648–739 hold its `renderResult`.
- `packages/eforge/src/cli/mcp-proxy.ts` lines 372–400 hold the `eforge_status` tool definition. Lines 588–663 hold the `eforge_daemon` tool with the inline `checkActiveBuilds` / `stopDaemon` helpers.
- `packages/client/src/api/queue.ts` lines 82–90 hold the existing `apiGetLatestRunFromRuns` helper; new helpers go alongside it.
- `packages/client/src/index.ts` is the package root that re-exports the per-route helpers.

## Implementation

### Overview

1. **Add shared client helpers** in `packages/client/src/api/queue.ts`:
   - `export async function apiGetRunningRuns(opts: { cwd: string }): Promise<{ data: RunInfo[]; port: number }>` — calls `daemonRequest<RunInfo[]>(opts.cwd, 'GET', API_ROUTES.runs)`, filters to `r.status === 'running' && r.sessionId !== undefined`, dedupes by `sessionId` keeping the first occurrence (since `/api/runs` is sorted `started_at DESC`, the most recent run wins for any duplicate session).
   - `export async function apiGetRunningSessionSummaries(opts: { cwd: string }): Promise<Array<{ run: RunInfo; summary: RunSummary }>>` — calls `apiGetRunningRuns`, then for each run uses `apiGetRunSummary({ cwd: opts.cwd, id: run.sessionId! })` to fetch summaries in parallel via `Promise.allSettled`. Drops rejected entries silently. Preserves the input run order in the output array.
2. **Re-export** the two new helpers from `packages/client/src/index.ts` next to the existing `apiGetLatestRunFromRuns` re-export.
3. **Extract pure helpers** in `packages/pi-eforge/extensions/eforge/index.ts`:
   - Rename `formatBuildFooter` → `formatSingleBuildFooter` (no body change beyond using `summary.plans.length` as the denominator — already true today, now explicitly documents that pending plans count).
   - `export function aggregateRunningSummaries(summaries: Array<{ run: RunInfo; summary: RunSummary }>): { runningCount: number; totalPlans: number; completedPlans: number; activePlans: number; oldestStartedAt: string | null; totalErrors: number }` — `runningCount = summaries.length`; `totalPlans = Σ summary.plans.length`; `completedPlans = Σ summary.plans.filter(p => p.status === 'completed').length`; `activePlans = Σ summary.plans.filter(p => p.status === 'running').length`; `oldestStartedAt = min(summary.duration.startedAt where not null)`; `totalErrors = Σ summary.eventCounts.errors`.
   - `export function formatAggregateFooter(summaries: Array<{ run: RunInfo; summary: RunSummary }>): string` — returns `eforge builds: {N} running - {complete}/{total} plans - {active} active - {duration}` where duration is `formatDuration(elapsed_seconds_since_oldestStartedAt)`. Documents in JSDoc that duration anchors on the *oldest* still-running build so the value increases monotonically through new starts.
   - `export function checkActiveBuildsMessage(runs: RunInfo[]): string | null` — returns `null` for zero, `'An eforge build is currently active. Use force: true to stop anyway.'` for one, `'{N} eforge builds are currently active. Use force: true to stop anyway.'` for N > 1.
   - Existing `formatQueueFooter(queueItems, hasRunningBuild)` keeps its current signature and behavior — only the callers change.
4. **Rewrite `refreshStatus(ctx)`** in the Pi extension:
   - Replace the `getPreferredRun(ctx.cwd)` + single-summary fetch with `const { data: summaries } = await apiGetRunningSessionSummaries({ cwd: ctx.cwd });` (treat any thrown error the same as today: clear `eforge-build` status and continue).
   - When `summaries.length === 0`: clear `eforge-build` status.
   - When `summaries.length === 1`: `ctx.ui.setStatus('eforge-build', formatSingleBuildFooter(summaries[0].summary))`.
   - When `summaries.length > 1`: `ctx.ui.setStatus('eforge-build', formatAggregateFooter(summaries))`.
   - Set `hasRunningBuild = summaries.length > 0` and pass to `formatQueueFooter`.
5. **Rewrite `checkActiveBuilds(cwd)`** in the Pi extension to use `apiGetRunningRuns` + `checkActiveBuildsMessage`:
   - Wrap in `try/catch` and return `null` on any error (same conservative posture as today — daemon outages should not block stop).
6. **Rewrite the `eforge_status` tool** (`execute` + `renderResult`) in the Pi extension:
   - `execute`: call `apiGetRunningSessionSummaries({ cwd })`. When empty return `jsonResult({ status: 'idle', message: 'No active eforge sessions.', ...versions })`. Otherwise return `jsonResult({ status: 'active', builds: summaries.map(({ run, summary }) => ({ sessionId: summary.sessionId, runId: run.id, command: run.command, ...summary })), ...versions })` — each `builds` element carries the canonical `RunSummary` fields plus the source `run` identifiers (sessionId, runId, command) so the renderer can show title/command per build.
   - `renderResult`: when `data.builds` is present, iterate and render per build: status icon + sessionId/command header, `currentPhase › currentAgent` line, plan progress `{complete}/{total} plans`, optional error count. Idle case unchanged. Single-build branches (`data.builds.length === 1`) collapse to the existing single-summary rendering to preserve UX continuity.
7. **Rewrite the MCP proxy `eforge_status` handler** in `packages/eforge/src/cli/mcp-proxy.ts`:
   - Import `apiGetRunningSessionSummaries` from `@eforge-build/client`.
   - Replace the `apiGetLatestRunFromRuns` + single-summary fetch with `const summaries = await apiGetRunningSessionSummaries({ cwd: toolCwd });`.
   - When empty: return `{ status: 'idle', message: 'No active eforge sessions.', ...versions }`.
   - Otherwise: return `{ status: 'active', builds: summaries.map(({ run, summary }) => ({ sessionId: summary.sessionId, runId: run.id, command: run.command, ...summary })), ...versions }`.
8. **Rewrite the MCP proxy `checkActiveBuilds`** inside the `eforge_daemon` tool handler:
   - Import `apiGetRunningRuns` from `@eforge-build/client`.
   - Replace the body of the inner `checkActiveBuilds` function with `const { data: runs } = await apiGetRunningRuns({ cwd: toolCwd }); return checkActiveBuildsMessage(runs);` — but since `checkActiveBuildsMessage` lives in the Pi extension package, replicate the message-building logic inline in `mcp-proxy.ts` as a private function with identical branching (matches the keep-prompts-closed boundary between packages and avoids pulling Pi into the CLI). The two implementations are unit-tested for parity via fixture-only checks in the Pi test file (the Pi pure helper is the canonical version; the inline MCP version is a manually mirrored copy with a code comment pointing back to the Pi helper).

### Key Decisions

1. **Shared helpers in `@eforge-build/client`**: `apiGetRunningRuns` and `apiGetRunningSessionSummaries` go in `packages/client/src/api/queue.ts` alongside `apiGetLatestRunFromRuns`. Mirrors the existing per-route helper pattern; both consumers (Pi extension, MCP proxy) import the same function so a future filtering rule change happens in one place.
2. **Dedupe by `sessionId`**: a single session may have multiple rows in `/api/runs` (recovery runs, retries). The newest row wins because `/api/runs` is sorted `started_at DESC`. Without dedupe, the footer's `N running` count would inflate past the true session count.
3. **Pure helpers for testability**: extracting `aggregateRunningSummaries`, `formatSingleBuildFooter`, `formatAggregateFooter`, and `checkActiveBuildsMessage` lets the new test exercise them without registering an extension or running a daemon. There are no existing Pi-eforge tests in `test/`; these helpers are the seam.
4. **Aggregate-vs-single threshold of `summaries.length > 1` (not `>= 2`)**: the moment a second build appears, the footer must make concurrency explicit. Reverting to single-detail when one of two completes is correct — the user gets the richer view automatically.
5. **`oldestStartedAt` as the duration anchor**: aggregate duration reflects "how long the project has had something running", not "how long since the newest started". Documented in `aggregateRunningSummaries` and `formatAggregateFooter` JSDoc.
6. **Response shape changes for `eforge_status`**: returning `{ status, builds, ...versions }` is a structural change from the current `{ ...singleSummary, ...versions }` shape. Old MCP/Pi consumers that read top-level `plans`/`currentPhase`/etc. will no longer see them. The `builds` array is the canonical multi-build surface; clients should iterate it. This is acceptable because (a) the source PRD AC #10/#11 require all running builds to be visible, (b) the rendered Pi UI consumes the new `builds` field directly, (c) the MCP/Claude-facing change is documented in `DAEMON_API_VERSION` comment alongside plan-01's bump (a v29 bump already lands in plan-01; no second bump required because `eforge_status` is an MCP/Pi tool surface, not part of the daemon HTTP API).
7. **Silent per-summary error handling in `apiGetRunningSessionSummaries`**: a transient DB error mid-poll should not blank the entire footer. `Promise.allSettled` plus dropping rejected entries preserves the rest. Logged at debug level only (consistent with the Pi extension's existing best-effort refresh posture).
8. **MCP `checkActiveBuilds` message mirrors the Pi helper inline** rather than importing from `@eforge-build/pi-eforge`: the CLI must not depend on the Pi extension package. The message-building branch is short (3 cases) and identical to the Pi version; the test file asserts parity via fixture inputs.

## Scope

### In Scope
- `apiGetRunningRuns` and `apiGetRunningSessionSummaries` helpers in `@eforge-build/client` plus root re-exports.
- Pi extension: rename `formatBuildFooter` → `formatSingleBuildFooter`; add `aggregateRunningSummaries`, `formatAggregateFooter`, `checkActiveBuildsMessage` pure helpers; rewrite `refreshStatus`, `checkActiveBuilds`, and the `eforge_status` tool's `execute` + `renderResult`.
- MCP proxy: rewrite `eforge_status` handler; rewrite `eforge_daemon`'s inner `checkActiveBuilds`.
- New unit test file `test/pi-eforge-multi-build.test.ts` covering aggregation math, footer formatting (single + aggregate), queue-footer filtering, and `checkActiveBuildsMessage` branching.

### Out of Scope
- Monitor UI changes — the dashboard already renders multiple runs via the event stream.
- New daemon endpoints — only `/api/runs` and `/api/run-summary/:id` are consumed.
- Changes to queue scheduling, build cancellation, run dedup semantics in the daemon, or any wire changes beyond plan-01's `DAEMON_API_VERSION` bump.
- Re-shaping the `RunSummary` wire type — plan-01 owns the `'pending'` addition; no further changes here.

## Files

### Create
- `test/pi-eforge-multi-build.test.ts` — unit tests covering:
  - `aggregateRunningSummaries([])` → all zeros, `oldestStartedAt: null`.
  - `aggregateRunningSummaries(oneSummary)` → `runningCount: 1`, totals from the single summary's plans.
  - `aggregateRunningSummaries(twoSummaries)` with mixed plan statuses (e.g. summary A has 2 plans `[pending, running]`, summary B has 2 plans `[completed, failed]`) → `runningCount: 2`, `totalPlans: 4`, `completedPlans: 1`, `activePlans: 1`, `oldestStartedAt` equal to the earlier of the two `summary.duration.startedAt` strings, `totalErrors: Σ`.
  - `formatSingleBuildFooter(summary)` includes `eforge build: running` and a `{complete}/{total} plans` segment where total equals `summary.plans.length` (pending plans count in the denominator).
  - `formatAggregateFooter(twoSummaries)` matches the regex `/^eforge builds: 2 running - \d+\/\d+ plans - \d+ active - /` and ends with a duration segment.
  - `formatQueueFooter(queueItemsIncludingRunning, true)` excludes queue items whose `status === 'running'` from the rendered counts; `formatQueueFooter(queueItemsIncludingRunning, false)` includes them.
  - `checkActiveBuildsMessage([])` returns `null`.
  - `checkActiveBuildsMessage([oneRunningRun])` returns the singular `'An eforge build is currently active. Use force: true to stop anyway.'` message.
  - `checkActiveBuildsMessage([twoRunningRuns])` returns `'2 eforge builds are currently active. Use force: true to stop anyway.'`.
  - Fixtures are constructed inline by hand-typing `RunInfo` and `RunSummary` objects (no daemon, no mocks). Imports the pure helpers from `@eforge-build/pi-eforge/extensions/eforge` (add a typed subpath export in `packages/pi-eforge/package.json` if needed — see Modify list below).

### Modify
- `packages/client/src/api/queue.ts` — add `export async function apiGetRunningRuns(opts: { cwd: string })` returning `{ data: RunInfo[]; port: number }`. Implementation: call `daemonRequest<RunInfo[]>(opts.cwd, 'GET', API_ROUTES.runs)`, then return `{ data: data.filter(r => r.status === 'running' && r.sessionId !== undefined).filter((r, i, arr) => arr.findIndex(x => x.sessionId === r.sessionId) === i), port }`. Add `export async function apiGetRunningSessionSummaries(opts: { cwd: string }): Promise<Array<{ run: RunInfo; summary: RunSummary }>>`. Implementation: call `apiGetRunningRuns(opts)`; for each run call `apiGetRunSummary({ cwd: opts.cwd, id: run.sessionId! })` in `Promise.allSettled`; drop rejected entries; preserve input order.
- `packages/client/src/index.ts` — add `export { apiGetRunningRuns, apiGetRunningSessionSummaries } from './api/queue.js';` next to the existing `apiGetLatestRunFromRuns` re-export.
- `packages/pi-eforge/extensions/eforge/index.ts` — (1) rename `formatBuildFooter` → `formatSingleBuildFooter` and export it; (2) add and export `aggregateRunningSummaries`, `formatAggregateFooter`, `checkActiveBuildsMessage` pure helpers as described above; (3) rewrite `refreshStatus(ctx)` to use `apiGetRunningSessionSummaries` and branch on `summaries.length` (0/1/many) for the `eforge-build` status; (4) rewrite `checkActiveBuilds(cwd)` to use `apiGetRunningRuns` + `checkActiveBuildsMessage`, wrapped in `try/catch` returning `null` on error; (5) replace the `eforge_status` tool `execute` body to call `apiGetRunningSessionSummaries` and return `{ status: 'idle' | 'active', builds: …, …versions }`; (6) replace the `eforge_status` `renderResult` body to iterate `data.builds` (when present) and render one section per build (sessionId/command header, status, `currentPhase › currentAgent`, `{complete}/{total} plans`, error count); when `data.builds.length === 1` fall back to the existing single-summary rendering; idle case unchanged. Imports: add `apiGetRunningRuns`, `apiGetRunningSessionSummaries` to the destructured `@eforge-build/client` import block; remove the now-unused `getPreferredRun` if no other caller exists (otherwise leave it).
- `packages/pi-eforge/package.json` — if the package's `exports` map does not already expose the helpers at the path the test file imports, add a typed subpath. Recommended addition: `"./extensions/eforge": { "types": "./dist/extensions/eforge/index.d.ts", "import": "./dist/extensions/eforge/index.js" }` so the test can `import { aggregateRunningSummaries, … } from '@eforge-build/pi-eforge/extensions/eforge'`. Verify the existing `exports` block before adding to avoid duplicate keys; an alternative is to add a thin `packages/pi-eforge/src/test-helpers.ts` re-export module if no extensions subpath is desired in the public API.
- `packages/eforge/src/cli/mcp-proxy.ts` — (1) add `apiGetRunningRuns`, `apiGetRunningSessionSummaries` to the destructured `@eforge-build/client` import; (2) replace the `eforge_status` tool handler body so it calls `apiGetRunningSessionSummaries({ cwd: toolCwd })` and returns `{ status: 'idle' | 'active', builds: …, …versions }` matching the Pi shape; (3) inside the `eforge_daemon` handler, replace the inner `checkActiveBuilds` function body to call `apiGetRunningRuns({ cwd: toolCwd })` and build the message inline with the same 0/1/N branching as `checkActiveBuildsMessage` (comment that it mirrors the Pi pure helper); (4) the outer `stopDaemon(forceStop)` flow is unchanged — it still calls `checkActiveBuilds()` and short-circuits when the message is non-null.

## Verification

- [ ] `apiGetRunningRuns({ cwd })` returns only entries from `/api/runs` with `status === 'running'` and a non-empty `sessionId`, with duplicates collapsed to one row per `sessionId` (first occurrence wins).
- [ ] `apiGetRunningSessionSummaries({ cwd })` returns one `{ run, summary }` per running session, drops entries whose `apiGetRunSummary` call rejects, and preserves input run order.
- [ ] With exactly one running summary whose `plans` array has two `pending` entries, the Pi footer text reads `eforge build: running - 0/2 plans - {duration}` (denominator counts pending+running+completed+failed). Assertion uses a substring match on `0/2 plans` against `formatSingleBuildFooter(summary)`.
- [ ] With two running summaries whose combined `plans` total 4 entries (mixed statuses), the Pi footer text matches the regex `/^eforge builds: 2 running - \d+\/4 plans - \d+ active - /` and includes a trailing duration segment.
- [ ] With two running summaries, `refreshStatus` never sets the `eforge-build` status to the single-build format. The test asserts that `formatAggregateFooter([s1, s2])` does NOT start with `eforge build: running`.
- [ ] `formatQueueFooter(queueItems, true)` excludes items whose `status === 'running'` from the rendered counts when at least one running build exists.
- [ ] `eforge_status` (Pi extension) returns `{ status: 'active', builds: [...] }` with one element per running session when summaries are non-empty; `renderResult` shows each build's session/command, status, `{complete}/{total} plans` line, `currentPhase › currentAgent` activity, and error count.
- [ ] `eforge_status` (MCP proxy) returns `{ status: 'active', builds: [...] }` with the same per-build element shape as the Pi response (`sessionId, runId, command, ...RunSummary fields`).
- [ ] `checkActiveBuildsMessage(runs)` returns `null` for empty input, the singular message for length 1, and `'{N} eforge builds are currently active. Use force: true to stop anyway.'` for length N > 1. The MCP proxy's inline mirror produces the identical strings for the same inputs (asserted via parity fixture in the test file by exporting the inline MCP helper or running it against the same fixtures).
- [ ] The MCP proxy `eforge_daemon` action `stop` (without `force: true`) is blocked when any running run exists; the blocked-stop response message includes the count when more than one session is running.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0; `test/pi-eforge-multi-build.test.ts` exercises all assertions above.
