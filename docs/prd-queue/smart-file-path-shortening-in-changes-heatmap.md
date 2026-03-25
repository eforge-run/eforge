---
title: Smart file path shortening in Changes heatmap
created: 2026-03-25
status: pending
---

# Smart file path shortening in Changes heatmap

## Problem / Motivation

The Changes tab file heatmap truncates file paths from the right using CSS `text-ellipsis`, which loses the most important part of the path — the filename. For example, `src/monitor/ui/src/components/preview/plan-preview-context.tsx` renders as `src/monitor/ui/src/components/prev...`. Additionally, the file path column is unnecessarily narrow at 216px, exacerbating the truncation problem.

## Goal

Implement smart path shortening that always preserves the filename and as many trailing parent directories as fit, so users can immediately identify which file changed without hovering for a tooltip.

## Approach

### 1. Add `shortenPath()` utility to `src/monitor/ui/src/lib/format.ts`

A pure utility that takes a path and `maxChars` (default 50), preserving the filename and as many trailing parent directories as fit:

- If path fits within `maxChars`, return unchanged.
- Split on `/`, always keep the last segment (filename).
- Greedily add parent dirs from right to left.
- Prepend `…/` (unicode ellipsis) when directories are truncated.
- If even `…/<filename>` exceeds `maxChars`, return it anyway (never truncate the filename).

Examples with `maxChars=50`:
- `src/a.ts` → `src/a.ts` (fits)
- `src/monitor/ui/src/components/preview/plan-preview-context.tsx` → `…/preview/plan-preview-context.tsx`

### 2. Update `src/monitor/ui/src/components/heatmap/file-heatmap.tsx`

- **Widen column**: `w-[216px]` → `w-[320px]` (line 117).
- **Update header padding**: `paddingLeft: '218px'` → `paddingLeft: '322px'` (line 96).
- **Use shortener**: Replace `{file.path}` with `{shortenPath(file.path)}` (line 121).
- Keep existing `title={file.path}` for full-path tooltip on hover.

### 3. Add tests in `test/shorten-path.test.ts`

Cover: short paths unchanged, deep paths truncated preserving filename, trailing dirs greedily included, very long filenames, empty/single-segment edge cases, custom `maxChars`.

## Scope

**In scope:**
- New `shortenPath()` utility function
- Updated heatmap column width and header padding
- Integration of `shortenPath()` into heatmap file path rendering
- Unit tests for the utility

**Out of scope:**
- N/A

## Acceptance Criteria

- `shortenPath()` returns short paths unchanged when they fit within `maxChars`.
- `shortenPath()` truncates deep paths while always preserving the full filename.
- `shortenPath()` greedily includes trailing parent directories from right to left.
- `shortenPath()` prepends `…/` when directories are truncated.
- `shortenPath()` never truncates the filename, even if `…/<filename>` exceeds `maxChars`.
- `shortenPath()` handles edge cases: empty paths, single-segment paths, very long filenames, custom `maxChars`.
- File heatmap column is widened from `w-[216px]` to `w-[320px]` with corresponding header padding update (`218px` → `322px`).
- File paths in the Changes heatmap display shortened paths via `shortenPath()` while retaining the full path in the `title` attribute for hover tooltip.
- `pnpm type-check` passes with no type errors.
- `pnpm test` passes, including new `shortenPath` tests.
- `pnpm build` completes successfully.
- Visual verification: file paths in the Changes heatmap show filenames clearly in the monitor UI.
