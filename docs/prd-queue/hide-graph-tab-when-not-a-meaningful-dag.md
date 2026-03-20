---
title: Hide Graph Tab When Not a Meaningful DAG
created: 2026-03-20
status: pending
---

## Problem / Motivation

The Graph tab in the monitor dashboard currently appears whenever orchestration data exists with at least one plan. For single-plan runs (errands, excursions) or multi-plan runs where plans are independent (no dependencies), the graph shows one or more disconnected nodes - not a meaningful DAG. This adds visual clutter and presents a non-informative default tab for the majority of runs.

## Goal

Only show the Graph tab when there are actual dependency edges to visualize, and demote it from the default first tab to the last tab position so timeline is the default view.

## Approach

Two changes in `app.tsx`:

### 1. Gate on actual dependency edges (line ~142-143)

Current:
```typescript
const hasOrchestration = effectiveOrchestration !== null && effectiveOrchestration.plans.length > 0;
const graphEnabled = hasOrchestration;
```

Change to:
```typescript
const hasOrchestration = effectiveOrchestration !== null && effectiveOrchestration.plans.length > 0;
const hasDependencyEdges = effectiveOrchestration !== null &&
  effectiveOrchestration.plans.some((p: { dependsOn?: string[] }) => p.dependsOn && p.dependsOn.length > 0);
const graphEnabled = hasOrchestration && hasDependencyEdges;
```

The Graph tab only appears when at least one plan depends on another - i.e., there's an actual DAG to show. The early orchestration path (from `expedition:architecture:complete` events in the reducer) already includes `dependsOn` arrays from the module definitions, so this works for both server-fetched and early-synthesized orchestration.

### 2. Move Graph tab to last position (line ~214-237)

Current tab order: Graph, Timeline, Heatmap, Plans

New tab order: Timeline, Heatmap, Plans, Graph

Move the Graph `<button>` block (lines 215-222) to after the Plans button (line 236). Change the default `activeTab` initial state from `'graph'` to `'timeline'` (line 26) since timeline is always available. The existing fallback on line 164 (`if activeTab === 'graph' && !graphEnabled`) still serves as a safety net.

## Scope

**In scope:**
- Gating Graph tab visibility on the presence of actual dependency edges (`dependsOn` arrays with entries)
- Reordering tabs so Graph is last
- Changing default active tab to `'timeline'`

**Out of scope:**
- N/A

## Acceptance Criteria

- `pnpm build` compiles successfully
- `pnpm test` passes
- Running an errand or single-plan excursion: Graph tab does not appear
- Running an expedition with dependencies: Graph tab appears
- Multi-plan run with all independent plans: Graph tab does not appear
- Default active tab is `'timeline'`, not `'graph'`
- Tab order is: Timeline, Heatmap, Plans, Graph (when Graph is visible)
