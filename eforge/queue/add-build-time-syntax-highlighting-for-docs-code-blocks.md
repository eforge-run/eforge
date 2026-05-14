---
title: Add build-time syntax highlighting for docs code blocks
created: 2026-05-14
profile: claude-sdk-4-7
---

# Add build-time syntax highlighting for docs code blocks

## Problem / Motivation

TypeScript code blocks on the public docs site, especially `/docs/extensions`, currently render as plain monospace text. Fenced ` ```ts ` / ` ```typescript ` examples have no syntax highlighting, which hurts readability of code samples in the documentation.

## Goal

Add syntax highlighting for TypeScript code blocks on the public docs site (especially `/docs/extensions`), so that fenced `ts`/`typescript` examples render with highlighted tokens instead of plain monospace text.

## Approach

Use build/server-time Markdown highlighting with Shiki via `rehype-pretty-code`, not a client-side highlighter. The docs are already rendered from Markdown in `web/lib/content.ts`, so highlighting should be produced as static HTML with no extra browser JavaScript.

- Update the Markdown rendering pipeline in `web/lib/content.ts`.
- Replace the current `remark-html` rendering path with a remark-to-rehype pipeline that supports syntax highlighting:
  - `remark`
  - `remark-gfm`
  - `remark-rehype`
  - `rehype-pretty-code`
  - `rehype-stringify`
- Add required dependencies to `@eforge-build/web`:
  - `remark-rehype`
  - `rehype-stringify`
  - `rehype-pretty-code`
  - `shiki` if needed by the chosen `rehype-pretty-code` version
- Configure light/dark themes, preferably:
  - light: `github-light`
  - dark: `github-dark`
- Preserve existing docs styling as much as possible in `web/app/globals.css`, including block background, border radius, spacing, overflow behavior, and inline-code styling.

## Scope

**In scope:**
- Update the Markdown rendering pipeline in `web/lib/content.ts`.
- Replace the current `remark-html` rendering path with a remark-to-rehype pipeline (`remark`, `remark-gfm`, `remark-rehype`, `rehype-pretty-code`, `rehype-stringify`).
- Add required dependencies to `@eforge-build/web` (`remark-rehype`, `rehype-stringify`, `rehype-pretty-code`, and `shiki` if needed).
- Configure light/dark themes (preferably `github-light` and `github-dark`).
- Ensure fenced Markdown blocks like ` ```ts ` and ` ```typescript ` render with highlighted tokens.
- Preserve existing docs styling as much as possible in `web/app/globals.css`, including block background, border radius, spacing, overflow behavior, and inline-code styling.
- Add or update tests in `web/__tests__/content.test.ts` if appropriate so rendered Markdown output verifies highlighted code blocks receive highlighting-related markup while regular Markdown still renders correctly.

**Out of scope / Constraints:**
- Do not add a client-side highlighter or client-side JavaScript for code highlighting.
- Keep the Markdown renderer safe for existing docs/reference pages.
- Do not change generated reference docs unless the implementation requires it.
- Follow repo conventions in `AGENTS.md`.
- Exclude `node_modules` and `dist` from searches.

## Acceptance Criteria

- `/docs/extensions` TypeScript code fences render with visible syntax highlighting in both light and dark modes.
- Existing inline code styling still works.
- Existing fenced non-TypeScript blocks remain readable.
- `pnpm --filter @eforge-build/web type-check` passes.
- Relevant tests pass, or a clear explanation is provided if no tests were changed.
