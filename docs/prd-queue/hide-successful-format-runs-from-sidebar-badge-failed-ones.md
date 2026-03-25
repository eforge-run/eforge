---
title: Hide Successful Format Runs from Sidebar, Badge Failed Ones
created: 2026-03-25
status: pending
---



# Hide Successful Format Runs from Sidebar, Badge Failed Ones

## Problem / Motivation

The monitor sidebar displays both build sessions and format (enqueue-only) runs. Successful format runs are just PRD normalization and add visual noise — they aren't interesting to the user unless they fail. This clutters the sidebar with short-duration, low-value entries and makes it harder to focus on meaningful build activity.

## Goal

Hide completed format runs from the sidebar to reduce noise, while keeping failed format runs visible and visually distinguished from pipeline build failures.

## Approach

Two targeted changes to the monitor web UI:

### 1. Filter out successful format runs

**File**: `src/monitor/ui/src/lib/session-utils.ts` — `partitionEnqueueSessions()`

Change the `else` branch (line 109) to `else if (group.status === 'failed')` so completed enqueue-only sessions are silently dropped, while failed ones remain visible in the sidebar.

### 2. Add "enqueue" badge to failed format runs

**File**: `src/monitor/ui/src/components/layout/sidebar.tsx` — `SessionItem`

Detect enqueue-only groups and render a red-tinted "enqueue" badge in the metadata area (where profile badges go), before the profile badge. This provides a clear visual signal that the failure occurred during PRD enqueue/formatting, not a build pipeline failure.

Detection logic:

```ts
const isEnqueueOnly = group.runs.length > 0 && group.runs.every((r) => r.command === 'enqueue');
```

Badge markup (following the existing profile badge pattern):

```tsx
{isEnqueueOnly && (
  <Badge
    variant="outline"
    className="text-[9px] px-1.5 py-0 rounded-sm font-medium bg-red/20 text-red border-red/30"
  >
    enqueue
  </Badge>
)}
```

## Scope

**In scope:**
- Filtering completed (successful) enqueue-only sessions from the sidebar
- Retaining failed enqueue-only sessions in the sidebar
- Adding a visually distinct "enqueue" badge to failed format runs

**Out of scope:**
- N/A

## Acceptance Criteria

- Successful format (enqueue-only) runs no longer appear in the sidebar
- Failed format runs remain visible in the sidebar
- Failed format runs display a red-tinted "enqueue" outline badge in the metadata area, visually distinguishing them from build pipeline failures
- `pnpm build` completes with a clean build
- `pnpm test` passes all existing tests
- Visual verification confirms no short-duration format entries in the sidebar and correct badge rendering on failed format runs
