---
title: Plan: Show PRD Queue in Monitor UI
created: 2026-03-18
status: pending
---

## Problem / Motivation

The web monitor shows run sessions but has no visibility into the PRD queue - users have to `eforge queue list` in the CLI to see what's enqueued. There's no at-a-glance view of pending work alongside session history in the monitor UI.

## Goal

Add a queue display to the monitor sidebar so users can see enqueued PRDs - their status, priority, and dependencies - directly in the web monitor without switching to the CLI.

## Approach

Thread `cwd` from the monitor server's argv into `startServer()`, add a `/api/queue` endpoint that reads `.md` files from the PRD queue directory and parses their frontmatter, then render the results in a new collapsible sidebar component that polls every 5 seconds.

Key technical decisions:

- **Deliberately duplicate the frontmatter parser** from the engine (`src/engine/prd-queue.ts:57-95` regex pattern) into the monitor server to avoid pulling zod/engine dependencies into the monitor process.
- **Hardcode the queue directory** to `docs/prd-queue/` (matching `DEFAULT_CONFIG`). Custom `prdQueue.dir` from `eforge.yaml` won't be reflected - acceptable for v1.
- **No git metadata** fetched (unlike the engine's `loadQueue`) to keep the endpoint fast.
- **Return empty array** if `cwd` is unset or the queue directory doesn't exist.

## Scope

**In scope:**

- Threading `cwd` into `startServer()` via options (`src/monitor/server-main.ts`, `src/monitor/server.ts`)
- `/api/queue` endpoint with lightweight frontmatter parsing, returning `{ id, title, status, priority?, created?, dependsOn? }[]`
- `QueueItem` TypeScript interface in `src/monitor/ui/src/lib/types.ts`
- `fetchQueue()` API function in `src/monitor/ui/src/lib/api.ts`
- New `src/monitor/ui/src/components/layout/queue-section.tsx` component:
  - Uses `useApi<QueueItem[]>('/api/queue')` with 5-second polling
  - Returns `null` when queue is empty (no wasted sidebar space)
  - Collapsible section (Radix `Collapsible` already available) with "Queue" header and pending count badge
  - Items sorted: running first, then pending, then terminal states; within same status, by priority ascending (nulls last)
  - Each item: colored status dot + truncated title + optional priority badge
  - Status dot colors: yellow=pending, blue+pulse=running, green=completed, red=failed, gray=skipped
  - Matches sidebar text sizing (`text-[11px]`) and color system (`text-text-dim`, `text-foreground`)
- Integration into `src/monitor/ui/src/components/layout/sidebar.tsx`, rendered above the "Sessions" heading

**Out of scope:**

- Custom `prdQueue.dir` from `eforge.yaml` (hardcoded to `docs/prd-queue/` for v1)
- Git metadata for queue items
- Shared frontmatter parsing code between engine and monitor

## Acceptance Criteria

1. `pnpm build` completes with no type errors.
2. `pnpm test` passes - existing tests unaffected.
3. `/api/queue` endpoint returns a JSON array of queue items parsed from `.md` files in `{cwd}/docs/prd-queue/`, with fields `id`, `title`, `status`, `priority?`, `created?`, `dependsOn?`.
4. `/api/queue` returns `[]` when `cwd` is unset or the queue directory doesn't exist.
5. The Queue section appears in the monitor sidebar above the Sessions heading when PRDs exist in the queue directory.
6. The Queue section disappears entirely when the queue is empty or the directory is missing.
7. New PRD files added to the queue directory appear in the sidebar within ~5 seconds (polling).
8. Items are sorted: running first, then pending, then terminal states; within same status by priority ascending (nulls last).
9. Status dots use the correct colors: yellow=pending, blue+pulse=running, green=completed, red=failed, gray=skipped.
10. Sidebar styling matches existing conventions (`text-[11px]`, `text-text-dim`, `text-foreground`).

### Files

| File | Change |
|------|--------|
| `src/monitor/server-main.ts` | Pass `cwd` to `startServer` via options |
| `src/monitor/server.ts` | Accept `cwd` in options, add frontmatter parser, add `serveQueue`, add route |
| `src/monitor/ui/src/lib/types.ts` | Add `QueueItem` interface |
| `src/monitor/ui/src/lib/api.ts` | Add `fetchQueue` function |
| `src/monitor/ui/src/components/layout/queue-section.tsx` | **New** - collapsible queue display |
| `src/monitor/ui/src/components/layout/sidebar.tsx` | Render `<QueueSection />` above sessions |
