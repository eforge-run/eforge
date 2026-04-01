---
id: plan-01-fix-indentation
name: Fix PlanRow Swimlane Indentation
depends_on: []
branch: fix-pipeline-swimlane-indentation-for-dependent-plans/fix-indentation
---

# Fix PlanRow Swimlane Indentation

## Architecture Context

PlanRow in `thread-pipeline.tsx` uses `marginLeft` on its outer container to indent dependent plans. This shifts the entire row (pill + swimlane) right, misaligning swimlane bars across rows at different depth levels. Only the pill label should be indented. The `ThreadLineGutter` component referenced in the PRD does not exist in the codebase - no removal needed.

## Implementation

### Overview

Move depth-based indentation from the outer container's `marginLeft` to `paddingLeft` on the three `leftLabel` wrapper elements. Since these elements use `w-[100px]` with Tailwind's default `box-sizing: border-box`, padding eats into the fixed width, shifting the pill text right while the overall row layout stays aligned.

### Key Decisions

1. Use `paddingLeft` on the label wrappers instead of `marginLeft` on the outer div - keeps swimlane bars vertically aligned across all depth levels.
2. Apply padding to all three leftLabel variants (prdSource div, planArtifact div, fallback span) so indentation works regardless of which branch renders.

## Scope

### In Scope
- Remove `marginLeft` from PlanRow's outer container div (line 785)
- Add `paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH` to the three `w-[100px] shrink-0` label wrapper elements (lines 732, 749, 773)

### Out of Scope
- `ThreadLineGutter` removal (does not exist in codebase)
- Dependency visualization (handled by Graph tab)

## Files

### Modify
- `src/monitor/ui/src/components/pipeline/thread-pipeline.tsx` - Remove `marginLeft` from PlanRow outer div; add `paddingLeft` based on depth to the three leftLabel wrapper elements

## Verification

- [ ] PlanRow outer container div at ~line 785 has no `style` prop with `marginLeft`
- [ ] The `<div className="w-[100px] shrink-0 ...">` at ~line 732 has `style={{ paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH }}`
- [ ] The `<div className="w-[100px] shrink-0 ...">` at ~line 749 has `style={{ paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH }}`
- [ ] The `<span className="w-[100px] shrink-0 ...">` at ~line 773 has `style={{ paddingLeft: (depth ?? 0) * DEPTH_LEVEL_WIDTH }}`
- [ ] `pnpm build` completes without errors
- [ ] No references to `ThreadLineGutter` exist in the file
