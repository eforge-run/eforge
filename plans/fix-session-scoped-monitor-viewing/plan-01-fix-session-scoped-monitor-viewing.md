---
id: plan-01-fix-session-scoped-monitor-viewing
name: "Fix: Session-scoped monitor viewing"
depends_on: []
branch: fix-session-scoped-monitor-viewing/main
---

# Fix: Session-scoped monitor viewing

## Context

When `eforge run` executes, it creates two runs under one session - plan phase (runId A) and build phase (runId B). The monitor UI is entirely runId-scoped, so viewing the build run can't see plan data (plan preview shows "not found", orchestration/graph don't load). The fix: shift the monitor from runId-scoped to sessionId-scoped viewing, so all events from a session appear together.

This works naturally for standalone commands too, since sessionId defaults to runId when no explicit session exists.

## Changes

### 1. DB: Add session-level queries (`src/monitor/db.ts`)

Add to interface and implementation:

- `getEventsBySession(sessionId: string, afterId?: number): EventRecord[]` - joins events + runs, filters by `session_id`, ordered by `e.id`. Two prepared statements (all vs after-id), same pattern as existing `getEvents`.
- `getEventsByTypeForSession(sessionId: string, type: string): EventRecord[]` - same join, filtered by type.
- `getLatestSessionId(): string | undefined` - `SELECT session_id FROM runs ORDER BY started_at DESC LIMIT 1`.
- `getSessionRuns(sessionId: string): RunRecord[]` - reuse existing `getRunsBySession`.

SQL for `getEventsBySession`:
```sql
SELECT e.id, e.run_id as runId, e.type, e.plan_id as planId, e.agent, e.data, e.timestamp
FROM events e JOIN runs r ON e.run_id = r.id
WHERE r.session_id = ? ORDER BY e.id
```

Add index: `CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs(session_id)`.

### 2. Server: Session-aware endpoints (`src/monitor/server.ts`)

Add a resolution helper:
```typescript
function resolveSessionId(id: string): string {
  const run = db.getRun(id);
  return run?.sessionId ?? id;
}
```

This lets all endpoints accept either a runId or sessionId - they resolve to sessionId either way.

**`serveSSE`** (line 106): Resolve to sessionId. Change `SSESubscriber.runId` → `sessionId`. Poll loop uses `db.getEventsBySession(subscriber.sessionId, subscriber.lastSeenId)`.

**`/api/run-state/{id}`** (line 271): Resolve to sessionId. Return all events from session via `db.getEventsBySession(sessionId)`. Return session-level status (running if any run is running, failed if any failed, completed if all complete). Response shape: `{ status: string, events: EventRecord[] }`.

**`servePlans`** (line 212): Use `db.getEventsByTypeForSession(sessionId, 'plan:complete')`.

**`serveOrchestration`** (line 174): Same - use `db.getEventsByTypeForSession(sessionId, 'plan:complete')`.

**`serveLatestRunId`** (line 165): Use `db.getLatestSessionId()`. Return as `{ sessionId }` (keep `runId` field too for backward compat if needed, but UI will use sessionId).

### 3. UI: Sidebar passes sessionId (`src/monitor/ui/src/components/layout/sidebar.tsx`)

- `onSelectRun: (runId: string) => void` → `onSelectSession: (sessionId: string) => void`
- `RunItem.onSelect` calls `onSelectSession(run.sessionId || run.id)`
- Active state: highlight runs where `run.sessionId === currentSessionId || run.id === currentSessionId`
- `currentRunId` prop → `currentSessionId`

### 4. UI: App state becomes session-scoped (`src/monitor/ui/src/app.tsx`)

- `currentRunId` → `currentSessionId`
- `handleSelectRun` → `handleSelectSession`
- `fetchLatestRunId()` → `fetchLatestSessionId()` (returns sessionId)
- `useEforgeEvents(currentSessionId)` instead of `useEforgeEvents(currentRunId)`
- `fetchOrchestration(currentSessionId)` - works because server resolves
- Pass `currentSessionId` to `PlanCards`, `PlanPreviewPanel`

### 5. UI: Event hook uses session (`src/monitor/ui/src/hooks/use-eforge-events.ts`)

- Parameter: `sessionId` instead of `runId`
- Fetch URL: `/api/run-state/{sessionId}` (server resolves it)
- SSE URL: `/api/events/{sessionId}`
- Cache key: sessionId
- Completion check: use session-level status from response (`data.status`) instead of `data.run?.status`

### 6. UI: API helpers (`src/monitor/ui/src/lib/api.ts`)

- `fetchLatestRunId` → `fetchLatestSessionId`: calls `/api/latest-run`, returns `data.sessionId ?? data.runId`
- `fetchPlans(sessionId)`, `fetchOrchestration(sessionId)` - same endpoints, just passing sessionId now

### 7. UI: Components that receive the ID

These components receive `runId` prop and pass it to API calls. Rename prop to `sessionId`:
- `PlanCards` (`src/monitor/ui/src/components/plans/plan-cards.tsx`)
- `PlanPreviewPanel` (`src/monitor/ui/src/components/preview/plan-preview-panel.tsx`)

### 8. UI: RunItem active state (`src/monitor/ui/src/components/layout/run-item.tsx`)

Change `isActive` check to compare against sessionId rather than runId.

## Files modified

- `src/monitor/db.ts` - new session-level queries + index
- `src/monitor/server.ts` - resolveSessionId helper, session-aware endpoints
- `src/monitor/ui/src/app.tsx` - state rename, pass sessionId
- `src/monitor/ui/src/hooks/use-eforge-events.ts` - session-scoped fetch/SSE
- `src/monitor/ui/src/lib/api.ts` - fetchLatestSessionId
- `src/monitor/ui/src/components/layout/sidebar.tsx` - pass sessionId on select
- `src/monitor/ui/src/components/layout/run-item.tsx` - active state check
- `src/monitor/ui/src/components/plans/plan-cards.tsx` - prop rename
- `src/monitor/ui/src/components/preview/plan-preview-panel.tsx` - prop rename

## Verification

1. `pnpm build` to bundle
2. `eforge run` on a PRD, open monitor at localhost:4567
3. Timeline shows both plan and build events in one view
4. Click plan ID in pipeline → plan preview loads correctly
5. Graph tab loads orchestration data during build phase
6. Standalone `eforge plan` and `eforge build` work the same as before
7. `pnpm test` passes
