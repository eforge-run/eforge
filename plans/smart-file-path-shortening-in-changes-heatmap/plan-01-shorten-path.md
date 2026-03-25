---
id: plan-01-shorten-path
name: Smart file path shortening in Changes heatmap
depends_on: []
branch: smart-file-path-shortening-in-changes-heatmap/shorten-path
---

# Smart file path shortening in Changes heatmap

## Architecture Context

The monitor UI's Changes tab has a file heatmap (`file-heatmap.tsx`) that displays file paths alongside a risk-level grid. Paths are currently rendered raw with CSS `text-ellipsis`, which truncates from the right and hides the filename — the most important part. The format utilities live in `src/monitor/ui/src/lib/format.ts`.

## Implementation

### Overview

Add a `shortenPath()` utility to the existing format library and integrate it into the heatmap component. Widen the file path column from 216px to 320px to show more context.

### Key Decisions

1. `shortenPath()` uses a greedy right-to-left algorithm: always keep the filename, then add parent dirs from right to left until `maxChars` is reached. Prepend `…/` (unicode ellipsis, not ASCII `...`) when truncation occurs.
2. Never truncate the filename itself — if `…/<filename>` exceeds `maxChars`, return it anyway.
3. Column width increases from `w-[216px]` to `w-[320px]` with header padding from `218px` to `322px` to match.

## Scope

### In Scope
- `shortenPath()` utility function in `format.ts`
- Heatmap column width and header padding update
- Integration of `shortenPath()` into heatmap file path rendering
- Unit tests for `shortenPath()`

### Out of Scope
- Other monitor UI changes
- Changes to tooltip behavior (already shows full path via `title` attribute)

## Files

### Modify
- `src/monitor/ui/src/lib/format.ts` — Add `shortenPath(path: string, maxChars?: number): string` utility function at the end of the file.
- `src/monitor/ui/src/components/heatmap/file-heatmap.tsx` — Import `shortenPath` from format lib. Change `w-[216px]` to `w-[320px]` on line 117. Change `paddingLeft: '218px'` to `paddingLeft: '322px'` on line 96. Replace `{file.path}` with `{shortenPath(file.path)}` on line 121. Keep `title={file.path}` unchanged for full-path hover tooltip.

### Create
- `test/shorten-path.test.ts` — Unit tests for the `shortenPath()` function covering: short paths returned unchanged, deep paths truncated preserving filename, trailing parent dirs greedily included from right to left, `…/` prepended on truncation, very long filenames returned with `…/` prefix without filename truncation, empty string input, single-segment paths, custom `maxChars` values.

## Verification

- [ ] `shortenPath('src/a.ts', 50)` returns `'src/a.ts'` (fits within maxChars)
- [ ] `shortenPath('src/monitor/ui/src/components/preview/plan-preview-context.tsx', 50)` returns `'…/preview/plan-preview-context.tsx'`
- [ ] `shortenPath('', 50)` returns `''`
- [ ] `shortenPath('file.ts', 50)` returns `'file.ts'`
- [ ] `shortenPath('a/b.ts', 3)` returns `'…/b.ts'` (filename preserved even when exceeding maxChars)
- [ ] Heatmap file column uses `w-[320px]` class and header padding is `322px`
- [ ] Heatmap renders `shortenPath(file.path)` as display text with `title={file.path}` for tooltip
- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes including new `shorten-path.test.ts`
- [ ] `pnpm build` completes with exit code 0
