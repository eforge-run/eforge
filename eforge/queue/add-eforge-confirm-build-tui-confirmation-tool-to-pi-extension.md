---
title: Add `eforge_confirm_build` TUI confirmation tool to Pi extension
created: 2026-04-03
---



# Add `eforge_confirm_build` TUI confirmation tool to Pi extension

## Problem / Motivation

The eforge-build skill's Step 4 confirmation step presents "(confirm / edit / cancel)" as plain LLM text and waits for the user to type a response. Pi provides rich TUI components that would make this a much better experience - rendering the source preview as Markdown and presenting choices as a navigable SelectList instead of relying on free-text input.

## Goal

Replace the plain-text confirmation in eforge-build Step 4 with an interactive TUI overlay that renders the source preview as Markdown and presents confirm/edit/cancel as a keyboard-navigable SelectList.

## Approach

1. **Add a new `eforge_confirm_build` tool** to `pi-package/extensions/eforge/index.ts`:
   - Accepts `{ source: string }` - the assembled source preview text
   - Presents a `ctx.ui.custom()` overlay with:
     - `DynamicBorder` top/bottom borders
     - Title: "eforge — Confirm Build" (styled with accent + bold)
     - `Markdown` component rendering the source preview (use `getMarkdownTheme()`)
     - `SelectList` with three items:
       - "✓ Confirm" (description: "Enqueue for building")
       - "✎ Edit" (description: "Revise the source")
       - "✗ Cancel" (description: "Abort")
     - Help text showing keyboard hints (↑↓ navigate • enter select • esc cancel)
   - Returns the user's choice as the tool result: `{ choice: "confirm" | "edit" | "cancel" }` in `content` text so the LLM can proceed accordingly
   - Follow the patterns from `question.ts` and `preset.ts` Pi extension examples for the component structure
   - Include `renderCall` (show truncated source preview) and `renderResult` (show the choice with status icon) for clean TUI rendering

2. **Update `pi-package/skills/eforge-build/SKILL.md`** Step 4 to instruct the LLM to call the `eforge_confirm_build` tool with the assembled source instead of printing text and asking the user to type confirm/edit/cancel. The skill should describe how to interpret the returned choice.

## Scope

**In scope:**
- `pi-package/extensions/eforge/index.ts` - new `eforge_confirm_build` tool
- `pi-package/skills/eforge-build/SKILL.md` - Step 4 rewrite to use the new tool

**Out of scope:**
- No changes to the Claude Code plugin (it doesn't have TUI capabilities)
- No changes to the engine or CLI

## Acceptance Criteria

- When the LLM reaches Step 4 of eforge-build, it calls `eforge_confirm_build` instead of printing plain text
- The tool presents a bordered overlay with Markdown-rendered source and keyboard-navigable options
- Selecting "Confirm" returns the choice so the LLM proceeds to enqueue
- Selecting "Edit" returns the choice so the LLM asks for revisions
- Selecting "Cancel" (or pressing Esc) returns the choice so the LLM stops
- `renderCall` and `renderResult` provide clean inline display in the conversation
