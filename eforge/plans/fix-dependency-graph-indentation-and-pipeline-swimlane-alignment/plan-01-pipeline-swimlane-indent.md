---
id: plan-01-pipeline-swimlane-indent
name: Fix pipeline swimlane indentation
dependsOn: []
branch: fix-dependency-graph-indentation-and-pipeline-swimlane-alignment/pipeline-swimlane-indent
---

# Fix pipeline swimlane indentation

## Architecture Context

The pipeline view in the monitor UI uses a `ThreadLineGutter` component to render dependency indentation for plan rows. This component reserves a fixed-width gutter for ALL rows (including PRD and independent plans) based on `maxDepth`, pushing everything right even when most rows have depth 0. The fix replaces this with per-row `marginLeft` so only dependent plans are indented.

The graph tab fixes (depth-based X offset and step-style edges) are already implemented in `use-graph-layout.ts` and `dag-edge.tsx` - no changes needed there.

## Implementation

### Overview

Remove the `ThreadLineGutter` component and `maxDepth` prop entirely. Replace with a simple `marginLeft` style on each `PlanRow` outer div, computed from the row's `depth` value. Increase `DEPTH_LEVEL_WIDTH` from 8 to 20 for visible indentation.

### Key Decisions

1. **marginLeft over gutter component** - A CSS margin on the row div is simpler and only affects rows with depth > 0, avoiding the fixed-width gutter that pushes all rows right.
2. **Remove maxDepth entirely** - It was only used by `ThreadLineGutter` to calculate gutter width. With per-row margins, each row only needs its own `depth`.
3. **Keep depthMap computation** - The `useMemo` that computes `depthMap` is still needed to provide `depth` values to each plan row; only `maxDepth` is removed from its output.
4. **Skip vertical connector lines** - Indentation alone communicates dependency hierarchy clearly enough; connector lines add complexity for marginal benefit.

## Scope

### In Scope
- Remove `ThreadLineGutter` component definition (lines 702-722)
- Remove `MAX_GUTTER_WIDTH` constant (line 454)
- Remove `maxDepth` from `PlanRowProps` interface and PlanRow destructuring
- Remove `maxDepth` from the `useMemo` return value (keep `depthMap`)
- Remove `depth={0}` and `maxDepth={maxDepth}` from the PRD/Compile `PlanRow` call (lines 626-627)
- Remove `maxDepth={maxDepth}` from the plan entries `PlanRow` call (line 647)
- Replace `ThreadLineGutter` usage in PlanRow return (line 820) with `marginLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH` on the outer div
- Change `DEPTH_LEVEL_WIDTH` from 8 to 20

### Out of Scope
- Graph tab layout changes (`use-graph-layout.ts`) - already implemented
- Graph tab edge style changes (`dag-edge.tsx`) - already uses `getSmoothStepPath`
- Vertical connector lines in pipeline view

## Files

### Modify
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Remove `ThreadLineGutter` component, `MAX_GUTTER_WIDTH` constant, and `maxDepth` prop; replace gutter with per-row `marginLeft`; increase `DEPTH_LEVEL_WIDTH` from 8 to 20

## Verification

- [ ] `pnpm build` completes with zero type errors
- [ ] `ThreadLineGutter` component definition does not exist in `thread-pipeline.tsx`
- [ ] `maxDepth` does not appear in `PlanRowProps` interface
- [ ] `MAX_GUTTER_WIDTH` constant does not exist in `thread-pipeline.tsx`
- [ ] PRD/Compile `PlanRow` call has no `depth` or `maxDepth` props
- [ ] Plan entry `PlanRow` calls pass `depth` but not `maxDepth`
- [ ] PlanRow outer div uses `style={{ marginLeft: (depth ?? 0) * 20 }}` (or equivalent) instead of `ThreadLineGutter`
- [ ] `DEPTH_LEVEL_WIDTH` equals 20
- [ ] A depth-0 plan row renders with zero left margin (flush left, same as PRD)
- [ ] A depth-1 plan row renders with 20px left margin
