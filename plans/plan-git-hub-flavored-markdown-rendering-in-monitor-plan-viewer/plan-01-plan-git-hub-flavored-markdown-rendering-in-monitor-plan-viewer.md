---
id: plan-01-plan-git-hub-flavored-markdown-rendering-in-monitor-plan-viewer
name: "Plan: GitHub-flavored markdown rendering in monitor plan viewer"
depends_on: []
branch: plan-git-hub-flavored-markdown-rendering-in-monitor-plan-viewer/main
---

# Plan: GitHub-flavored markdown rendering in monitor plan viewer

## Context

The monitor UI's plan viewer currently treats markdown body content as source code and syntax-highlights it with Shiki (`lang: 'markdown'`). This means headings, lists, code blocks, and inline code all render as raw markdown text with syntax coloring - not as rendered HTML. The user wants proper GFM rendering where headings become `<h1>`s, lists become `<ul>`s, and fenced code blocks get language-specific syntax highlighting.

## Approach

Add `marked` (lightweight GFM markdown parser) and use the existing Shiki highlighter for code block syntax highlighting within rendered markdown.

### 1. Add `marked` dependency

**File:** `src/monitor/ui/package.json`

Add `marked` to dependencies. It's ~40KB, synchronous, and has built-in GFM support.

### 2. Rewrite `PlanBodyHighlight` to render markdown as HTML

**File:** `src/monitor/ui/src/components/preview/plan-body-highlight.tsx`

Changes:
- Load additional languages into Shiki: `typescript`, `javascript`, `tsx`, `jsx`, `json`, `bash`, `sql`, `css`, `html`, `go`, `python` (common plan code block languages)
- Create a custom `marked.Renderer` that overrides `code()` to call `highlighter.codeToHtml()` for fenced code blocks
- For unknown/unloaded languages, fall back to rendering as plain `<pre><code>` (no highlighting)
- Parse `body` with `marked.parse(body, { gfm: true, renderer })` instead of `highlighter.codeToHtml(body, { lang: 'markdown' })`
- Keep frontmatter rendering as Shiki YAML highlight (unchanged)
- Wrap the rendered markdown body in a container with a `.plan-prose` class for styling

### 3. Add prose CSS styles for rendered markdown

**File:** `src/monitor/ui/src/globals.css`

Add a `.plan-prose` class with styles for markdown elements, using the existing theme colors:

- Headings (`h1`-`h4`): `--color-text-bright`, descending sizes, bottom margin
- Paragraphs: standard foreground, line-height for readability
- Inline code: `--color-primary` tinted background, slightly different text color, border-radius
- Lists (`ul`, `ol`): proper indentation, bullet/number styling
- Blockquotes: left border with `--color-border`, dimmed text
- Links: `--color-primary`
- `hr`: `--color-border`
- Tables (GFM): bordered with `--color-border`, alternating row colors
- Code blocks (`pre > code`): inherit Shiki styling, don't conflict

## Files to modify

1. `src/monitor/ui/package.json` - add `marked`
2. `src/monitor/ui/src/components/preview/plan-body-highlight.tsx` - render markdown with marked + shiki
3. `src/monitor/ui/src/globals.css` - add `.plan-prose` styles

## Verification

1. `cd src/monitor/ui && pnpm install && pnpm build` - confirm it builds
2. `pnpm type-check` (from project root) - no type errors
3. Visual: run the monitor, open a plan with headings, code blocks, lists - confirm they render as formatted HTML with syntax-highlighted code blocks
