---
id: plan-01-fix-inline-title
name: Fix Inline Title Inference
depends_on: []
branch: untitled-prd/fix-inline-title
---

# Fix Inline Title Inference

## Architecture Context

When inline descriptions are enqueued via the MCP `eforge_build` tool, `inferTitle()` runs on the raw source content before the formatter processes it. For multi-line inline text with no `# ` heading and no filename fallback, this produces "Untitled PRD". The fix moves title inference to run on the formatter's output, which will now include a heading.

## Implementation

### Overview

Two changes:
1. Add an instruction to the formatter prompt requiring it to emit a `# Title` heading as the first line of its output.
2. In `enqueue()`, move the `inferTitle()` call to after the formatter runs, so it operates on `formattedBody` instead of `sourceContent`.

### Key Decisions

1. The formatter already restructures content into sections — adding a title heading is a natural extension of its job, not a new responsibility.
2. `inferTitle()` itself stays unchanged — the existing heading regex (`/^#\s+(.+)$/m`) will match the formatter's new heading line. The fallback chain remains as a safety net.
3. `options.name` still takes priority via the `??` operator — no change to override behavior.

## Scope

### In Scope
- `src/engine/prompts/formatter.md` — add title heading instruction
- `src/engine/eforge.ts` — reorder `inferTitle()` call in `enqueue()`

### Out of Scope
- Changes to `inferTitle()` logic
- Changes to any other agent prompts or engine files

## Files

### Modify
- `src/engine/prompts/formatter.md` — Add instruction to output a concise `# Title` heading as the first line, above the existing PRD sections.
- `src/engine/eforge.ts` — Move the `inferTitle()` call from line 283 (before formatting) to after line 296 (after formatting completes), so it runs on `formattedBody`. Keep `options.name` as the priority override via `??`.

## Verification

- [ ] `inferTitle('some multi-line\ninline description without heading')` returns "Untitled PRD" (unchanged baseline behavior)
- [ ] After formatting, the formatter output starts with a `# ` heading line derived from the input content
- [ ] In `enqueue()`, `inferTitle()` is called with `formattedBody` as the first argument, not `sourceContent`
- [ ] When `options.name` is provided, it is used as the title regardless of formatted content
- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes with zero failures
