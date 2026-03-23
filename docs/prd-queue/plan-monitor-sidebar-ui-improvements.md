---
title: Plan: Monitor Sidebar UI Improvements
created: 2026-03-23
status: pending
---

# Monitor Sidebar UI Improvements

## Problem / Motivation

The monitor's left sidebar has several UX issues that make it harder to use:
- Every session shows a "2 runs" badge (compile + build) that provides no useful information
- "Recent Enqueues" section shows completed enqueues that clutter the sidebar
- Sessions lack visual separation, making it hard to scan
- Missing useful context: plan count and base workflow profile type (errand/excursion/expedition)

## Goal

A cleaner sidebar that surfaces useful metadata (plan count, base profile type) and removes noise (completed enqueues, "N runs" badge).

## Approach

### 1. New `/api/session-metadata` batch endpoint

Add a single-query endpoint that returns plan count + base profile name for all sessions, avoiding N+1 queries from the frontend.

**`src/monitor/db.ts`** — Add `SessionMetadata` type and `getSessionMetadataBatch()` method:
- Query: `SELECT r.session_id, e.type, e.data FROM events e JOIN runs r ON e.run_id = r.id WHERE e.type IN ('plan:profile', 'plan:complete')`
- Parse results in JS, group by session_id:
  - From `plan:complete`: extract `plans.length` → `planCount`
  - From `plan:profile`: resolve the **base** profile name (not the actual profile name, which may be a custom/generated name)
- Return `Record<string, { planCount: number | null; baseProfile: string | null }>`

**Base profile resolution logic** (server-side, in the batch query result processing):
```typescript
function resolveBaseProfile(profileName: string, config?: { extends?: string }): string {
  const builtins = ['errand', 'excursion', 'expedition'];
  // Built-in profile selected directly — profileName IS the base
  if (builtins.includes(profileName)) return profileName;
  // Custom/generated profile — config.extends points to the base builtin
  if (config?.extends && builtins.includes(config.extends)) return config.extends;
  // Fallback: return whatever extends says, or the profileName itself
  return config?.extends ?? profileName;
}
```

This handles both cases:
- Built-in selection: `{ profileName: 'excursion', config: { description: '...', compile: [...] } }` → base = `'excursion'`
- Generated profile: `{ profileName: 'generated', config: { extends: 'excursion', ... } }` → base = `'excursion'`

**`src/monitor/server.ts`** — Add route handler for `GET /api/session-metadata` that calls `db.getSessionMetadataBatch()`.

### 2. Frontend type + API client

**`src/monitor/ui/src/lib/types.ts`** — Add `SessionMetadata` interface (`planCount: number | null`, `baseProfile: string | null`).

No separate API function needed — sidebar uses `useApi<Record<string, SessionMetadata>>('/api/session-metadata')` directly.

### 3. Replace "N runs" badge with plan count + base profile badges

**`src/monitor/ui/src/components/layout/sidebar.tsx`**:

- Fetch metadata via `useApi` alongside runs, refetch on same `refreshTrigger`
- Pass `metadata?.[group.key]` to each `SessionItem`
- Remove `runCount` / "N runs" badge
- Add base profile badge (errand=green, excursion=yellow, expedition=purple) using existing `Badge` component from `@/components/ui/badge`
- Add plan count badge showing e.g. "3 plans"
- Layout: profile badge + duration on bottom-left, plan count on bottom-right

```
[StatusIcon] [Label]                    [relative time]
             [profile badge] [duration]  [N plans]
```

Profile color helper:
- errand → `bg-green/15 text-green border-green/30`
- excursion → `bg-yellow/15 text-yellow border-yellow/30`
- expedition → `bg-purple/15 text-purple border-purple/30`
- default → neutral

### 4. Filter completed enqueues

**`src/monitor/ui/src/lib/session-utils.ts`** — In `partitionEnqueueSessions()`, only include enqueue groups where `group.status === 'running'`. Completed/failed enqueues are silently dropped (they appear in the Queue section).

### 5. Visual separation between sessions

**`src/monitor/ui/src/components/layout/sidebar.tsx`**:
- Add a thin divider (`border-t border-border/40`) between session items (not before the first)
- Remove the "SESSIONS" header text — it's redundant when enqueues are mostly hidden

### 6. Enqueue section: only show when active

**`src/monitor/ui/src/components/layout/enqueue-section.tsx`** — Rename header from "Recent Enqueues" to "Enqueuing" since it now only shows in-progress items. Simplify styling since it will rarely appear.

## Scope

**In scope:**

| File | Change |
|------|--------|
| `src/monitor/db.ts` | Add `SessionMetadata` type + `getSessionMetadataBatch()` |
| `src/monitor/server.ts` | Add `GET /api/session-metadata` endpoint |
| `src/monitor/ui/src/lib/types.ts` | Add `SessionMetadata` interface |
| `src/monitor/ui/src/components/layout/sidebar.tsx` | Fetch metadata, replace badges, add dividers, remove header |
| `src/monitor/ui/src/lib/session-utils.ts` | Filter completed enqueues |
| `src/monitor/ui/src/components/layout/enqueue-section.tsx` | Rename to "Enqueuing", minor cleanup |

**Out of scope:** N/A

## Acceptance Criteria

1. `pnpm build` passes with no type errors
2. `pnpm test` passes (existing tests)
3. Sessions display a base profile badge with correct color coding:
   - errand → green
   - excursion → yellow
   - expedition → purple
4. Sessions display a plan count (e.g. "3 plans") instead of the former "N runs" badge
5. Completed enqueues no longer appear in the sidebar
6. Clear visual separation (thin divider) between session items in the sidebar
7. Running enqueues remain visible under an "Enqueuing" header
8. The "SESSIONS" header text is removed
9. `/api/session-metadata` endpoint returns batch metadata for all sessions in a single query (no N+1)
10. Base profile resolution correctly handles both built-in profile selection and custom/generated profiles that extend a built-in
