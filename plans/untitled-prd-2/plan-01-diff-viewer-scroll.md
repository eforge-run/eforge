---
id: plan-01-diff-viewer-scroll
name: Fix Diff Viewer Scroll in Changes Tab
depends_on: []
branch: untitled-prd-2/diff-viewer-scroll
---

# Fix Diff Viewer Scroll in Changes Tab

## Architecture Context

The monitor UI uses a resizable panel layout. The Changes tab renders a `<FileHeatmap>` component inside the upper `<ResizablePanel>`. The heatmap contains a `<DiffViewer>` whose content div has `overflow-auto` (line 160 of `diff-viewer.tsx`), but the height constraint from the resizable panel is not propagated through the flex column, so overflow never activates and content is clipped instead of scrolling.

## Implementation

### Overview

Establish a complete height constraint chain from the resizable panel down to the diff content div by adding two CSS class changes.

### Key Decisions

1. Wrap `<FileHeatmap>` in a `<div className="flex-1 min-h-0">` in `app.tsx` — this gives the component a bounded height within the flex column so children can overflow-scroll.
2. Add `h-full` to the top-level flex container in `file-heatmap.tsx` — this propagates the bounded height from the wrapper down into the heatmap's own layout.

## Scope

### In Scope
- Height constraint wrapper in `app.tsx` around `<FileHeatmap>`
- Height propagation class in `file-heatmap.tsx` flex container

### Out of Scope
- Changes to `diff-viewer.tsx` (its `overflow-auto` is already correct)
- Any other monitor UI layout fixes

## Files

### Modify
- `src/monitor/ui/src/app.tsx` — Wrap `<FileHeatmap>` (line 304) in `<div className="flex-1 min-h-0">` to establish bounded height
- `src/monitor/ui/src/components/heatmap/file-heatmap.tsx` — Add `h-full` to the flex container on line 80: `<div className="flex gap-3">` → `<div className="flex gap-3 h-full">`

## Verification

- [ ] The diff viewer in the Changes tab scrolls vertically when diff content exceeds the visible panel area (no clipping)
- [ ] The `<FileHeatmap>` component is wrapped in a `<div className="flex-1 min-h-0">` in `app.tsx`
- [ ] The flex container in `file-heatmap.tsx` has classes `flex gap-3 h-full`
- [ ] `pnpm build` completes without errors
