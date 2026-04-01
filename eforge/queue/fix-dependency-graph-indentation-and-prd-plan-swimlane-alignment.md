---
title: Fix dependency graph indentation and PRD/Plan swimlane alignment
created: 2026-04-01
---

# Fix dependency graph indentation and PRD/Plan swimlane alignment

## Problem / Motivation

Two visual issues exist in the monitor UI pipeline view:

1. **Graph tab**: Dependent plans are not indented. A simple A->B dependency chain places both nodes at the same X coordinate, making the bezier edge look like a straight vertical bar instead of showing tree-like structure with proper connectors.

2. **Pipeline swimlanes**: The PRD (compile) row's content is horizontally misaligned with Plan rows. Plan rows with dependencies render a `ThreadLineGutter` (taking horizontal space), but the PRD row does not receive `depth`/`maxDepth` props, so it skips the gutter entirely, causing a horizontal offset mismatch.

## Goal

Make the pipeline view visually correct: PRD and Plan swimlane rows should be horizontally aligned, and the Graph tab should display dependency trees with indentation and L-shaped connectors.

## Approach

### Fix 1: PRD/Plan swimlane alignment

**File**: `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx`

**Root cause** (lines 611-626): The PRD `PlanRow` is called without `depth` or `maxDepth` props. In the render (line 818), `(maxDepth ?? 0) > 0` evaluates to false, so no gutter is rendered. Plan rows DO get these props, so they render a gutter that pushes their content right.

**Fix**: Pass `depth={0}` and `maxDepth={maxDepth}` to the PRD PlanRow call (line 611). With `depth=0`, the `ThreadLineGutter` will render at the correct width but with no lines (the `Array.from` produces an empty array for depth 0), just reserving the space to keep alignment.

```tsx
// line 611 - add depth and maxDepth to the PRD PlanRow
<PlanRow
  key="__compile__"
  planId="Compile"
  threads={globalThreads}
  ...
  depth={0}
  maxDepth={maxDepth}
/>
```

### Fix 2: Graph tab - indent dependent plans with tree connectors

#### 2a. Add depth-based horizontal indentation

**File**: `src/monitor/ui/src/components/graph/use-graph-layout.ts`

After Dagre computes the layout, calculate dependency depth and apply horizontal offset:

- **Depth calc**: `depth(root) = 0`, `depth(node) = max(depth(dep) for dep in dependsOn) + 1`
- **Apply offset**: Add `DEPTH_INDENT * depth` (50px per level) to each node's X position
- Handles diamond dependencies correctly (max of all dependency depths + 1)
- Root nodes stay at their original X, children shift right progressively

#### 2b. Switch to step-style edges

**File**: `src/monitor/ui/src/components/graph/dag-edge.tsx`

Replace `getBezierPath` with `getSmoothStepPath` from `@xyflow/react`:

- Creates L-shaped connectors with rounded corners (`borderRadius: 8`)
- With the indentation from 2a, source and target are at different X positions, producing visible horizontal/vertical step segments
- No changes to the animated edge overlay - it uses the same path string

## Scope

**In scope:**

- Passing `depth={0}` and `maxDepth={maxDepth}` to the PRD PlanRow in `thread-pipeline.tsx`
- Computing dependency depth and applying X offset in `use-graph-layout.ts`
- Replacing `getBezierPath` with `getSmoothStepPath` in `dag-edge.tsx`

**Out of scope:**

- Any other monitor UI changes
- Backend or data model changes
- Changes to the animated edge overlay logic

**Files to modify:**

1. `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` (line ~611)
2. `src/monitor/ui/src/components/graph/use-graph-layout.ts`
3. `src/monitor/ui/src/components/graph/dag-edge.tsx`

## Acceptance Criteria

1. `pnpm build` completes with no type errors
2. In builds with dependent plans, the PRD row swimlane aligns horizontally with Plan row swimlanes in the pipeline view
3. In the Graph tab, root plans appear at the left and dependent plans are indented progressively to the right
4. Graph tab edges render as L-shaped step connectors with rounded corners instead of straight vertical bezier lines
5. Single-plan builds (no edges) render unchanged in both pipeline and graph views
6. Diamond dependencies (a node depending on multiple parents) use the max parent depth + 1 for correct indentation
