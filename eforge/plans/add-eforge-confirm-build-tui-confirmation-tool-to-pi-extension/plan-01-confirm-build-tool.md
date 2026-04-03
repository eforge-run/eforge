---
id: plan-01-confirm-build-tool
name: Add eforge_confirm_build TUI tool to Pi extension
depends_on: []
branch: add-eforge-confirm-build-tui-confirmation-tool-to-pi-extension/confirm-build-tool
---

# Add eforge_confirm_build TUI tool to Pi extension

## Architecture Context

The eforge Pi extension (`pi-package/extensions/eforge/index.ts`) registers tools that bridge the eforge daemon into Pi. The `eforge-build` skill (`pi-package/skills/eforge-build/SKILL.md`) orchestrates a 5-step workflow where Step 4 currently uses plain text to ask the user to confirm/edit/cancel before enqueuing. Pi provides rich TUI components (`ctx.ui.custom()`, `Container`, `SelectList`, `Markdown`, `DynamicBorder`) that can replace this with an interactive overlay. The existing example extensions `question.ts`, `preset.ts`, and `summarize.ts` in `@mariozechner/pi-coding-agent` demonstrate the exact patterns to follow.

## Implementation

### Overview

Add a new `eforge_confirm_build` tool to the Pi extension that presents an interactive TUI overlay with a Markdown-rendered source preview and a keyboard-navigable SelectList for confirm/edit/cancel. Update the eforge-build skill's Step 4 to instruct the LLM to call this tool instead of printing plain text.

### Key Decisions

1. **Use `ctx.ui.custom()` pattern from preset.ts/summarize.ts** - combines `Container` with `DynamicBorder` (top/bottom), `Text` (title), `Markdown` (source preview), `SelectList` (choices), and `Text` (help hints). This matches the established Pi extension UI conventions.
2. **Return choice as JSON text in `content`** - consistent with how all other eforge tools return results via `jsonResult()`. The LLM reads the `choice` field to decide next action.
3. **Esc maps to cancel** - `selectList.onCancel` fires on Esc, returning `"cancel"` as the choice. This matches the behavior described in the PRD and follows the preset.ts pattern.
4. **`renderCall` shows truncated source** - truncate at ~200 chars to keep inline display compact. `renderResult` shows choice with a status icon (checkmark for confirm, pencil for edit, cross for cancel).

## Scope

### In Scope
- New `eforge_confirm_build` tool in `pi-package/extensions/eforge/index.ts`
- Updated Step 4 in `pi-package/skills/eforge-build/SKILL.md` to use the new tool

### Out of Scope
- No changes to the Claude Code plugin (`eforge-plugin/`)
- No changes to the engine or CLI
- No changes to other skills or tools

## Files

### Modify
- `pi-package/extensions/eforge/index.ts` - Add `eforge_confirm_build` tool registration after the existing `eforge_init` tool block (~line 607) and before the command aliases section. The tool:
  - Accepts `{ source: string }` parameter
  - Imports `DynamicBorder`, `getMarkdownTheme` from `@mariozechner/pi-coding-agent` and `Container`, `Markdown`, `SelectList`, `Text` from `@mariozechner/pi-tui` (add to existing import block at top of file)
  - Calls `ctx.ui.custom()` to present a bordered overlay with:
    - `DynamicBorder` top border (accent color)
    - `Text` title: "eforge - Confirm Build" (accent + bold)
    - `Markdown` rendering the source with `getMarkdownTheme()`
    - `SelectList` with 3 items: Confirm (value `"confirm"`, description "Enqueue for building"), Edit (value `"edit"`, description "Revise the source"), Cancel (value `"cancel"`, description "Abort")
    - `Text` help: "↑↓ navigate - enter select - esc cancel" (dim color)
    - `DynamicBorder` bottom border (accent color)
  - `selectList.onSelect` calls `done(item.value)`, `selectList.onCancel` calls `done("cancel")`
  - Returns `jsonResult({ choice })` where choice is `"confirm" | "edit" | "cancel"`
  - Includes `renderCall` showing "Source preview ({N} chars)" with truncated source text
  - Includes `renderResult` showing the choice with status icon

- `pi-package/skills/eforge-build/SKILL.md` - Rewrite Step 4 to instruct the LLM to call `eforge_confirm_build` with `{ source: "<assembled source>" }` instead of printing plain text. Document how to interpret the returned `choice` value:
  - `"confirm"` - proceed to Step 5
  - `"edit"` - ask user for revisions, then re-call `eforge_confirm_build` with updated source
  - `"cancel"` - stop

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] The `eforge_confirm_build` tool is registered in `pi-package/extensions/eforge/index.ts` with parameter schema `{ source: Type.String() }`
- [ ] The tool's `execute` function calls `ctx.ui.custom()` and returns `jsonResult({ choice })` where choice is one of `"confirm"`, `"edit"`, or `"cancel"`
- [ ] The tool includes `renderCall` and `renderResult` functions
- [ ] The `SelectList` has exactly 3 items with values `"confirm"`, `"edit"`, `"cancel"`
- [ ] Pressing Esc in the overlay returns `{ choice: "cancel" }`
- [ ] SKILL.md Step 4 references `eforge_confirm_build` tool instead of plain-text confirmation
- [ ] SKILL.md Step 4 documents all three choice outcomes (confirm -> Step 5, edit -> revise and re-confirm, cancel -> stop)
- [ ] For file path sources (Branch A), SKILL.md still instructs showing a brief summary rather than full text
