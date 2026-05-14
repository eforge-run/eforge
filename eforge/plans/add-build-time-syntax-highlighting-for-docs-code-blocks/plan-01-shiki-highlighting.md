---
id: plan-01-shiki-highlighting
name: Markdown pipeline with rehype-pretty-code syntax highlighting
branch: add-build-time-syntax-highlighting-for-docs-code-blocks/plan-01-shiki-highlighting
---

# Markdown pipeline with rehype-pretty-code syntax highlighting

## Architecture Context

The public docs site (`@eforge-build/web`) is a Next.js 15 App Router app under `web/`. Markdown content lives in `web/content/docs/*.md` and `web/content/reference/*.md`. `web/lib/content.ts` exposes two loaders, `loadDocPage` and `loadReferencePage`, each parsing frontmatter with `gray-matter` and rendering the body with a shared `renderMarkdown` helper. The current helper is:

```ts
async function renderMarkdown(content: string): Promise<string> {
  const result = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
  return result.toString();
}
```

The rendered HTML is consumed by server components (`web/app/docs/[slug]/page.tsx`, `web/app/reference/[slug]/page.tsx`) and injected via `dangerouslySetInnerHTML` into a `.prose` container. Styling for that container is defined in `web/app/globals.css` (`.prose`, `.prose code`, `.prose pre`, etc.). Fenced TypeScript blocks (` ```ts ` / ` ```typescript `) currently render as plain monospace text because `remark-html` does not attach any per-token markup; the most code-heavy page is `/docs/extensions` (`web/content/docs/extensions.md` and `web/content/docs/extensions-api.md` both contain ` ```ts ` fences).

Tests for the loaders live in `web/__tests__/content.test.ts` and run under root `vitest`. There is one custom assertion that verifies provenance comments are stripped from reference pages.

No build-step (Webpack/Turbopack) loader is involved — Markdown rendering happens at request/build time in server components. This means we can swap the unified pipeline transparently without any client-side JS impact.

## Implementation

### Overview

Replace the `remark-html` rendering path with a remark → rehype pipeline using `rehype-pretty-code` (Shiki under the hood) for syntax highlighting, while leaving every other behavior of the loaders unchanged. Themes are configured for both light and dark mode (`github-light` / `github-dark`); `rehype-pretty-code` emits dual-theme markup that swaps via the existing `prefers-color-scheme` media query already used in `globals.css`. Existing prose styles are preserved by augmenting (not replacing) `.prose pre` / `.prose code` rules so Shiki-emitted markup inherits the same background, border radius, spacing, and overflow behavior.

### Key Decisions

1. **Use `rehype-pretty-code` instead of `rehype-shiki` directly.** `rehype-pretty-code` is the standard wrapper used by Next.js docs sites; it handles dual themes, inline code highlighting, and emits stable `data-*` attributes that survive React's HTML pass.
2. **Configure dual themes via the `theme: { light, dark }` option.** The package emits both color schemes inline and toggles them based on a `data-theme` or media query. We use the media-query mode so it integrates with the existing `@media (prefers-color-scheme: dark)` block in `web/app/globals.css`.
3. **Disable `remark-rehype`'s default sanitization escape** by setting `allowDangerousHtml: true` and pairing with `rehype-stringify({ allowDangerousHtml: true })`. This matches the current `remark-html({ sanitize: false })` behavior and preserves raw HTML in reference pages (provenance comments are stripped earlier in the loader, not by the renderer).
4. **Pin Shiki theme set to the two requested themes** to keep the bundled grammar/theme payload small. We do not register additional themes.
5. **Keep a single shared `renderMarkdown` helper.** Both `loadDocPage` and `loadReferencePage` continue to call the same function so reference pages get highlighting too — there is no functional reason to gate it to one loader.
6. **Build a single shared unified processor instance** at module scope rather than rebuilding per call. Constructing the Shiki highlighter is the expensive part; reuse keeps repeated page loads fast in dev mode.
7. **Preserve existing styling by additive CSS rules.** Shiki emits `<pre><code>` with inline `style` attributes for each token; the `.prose pre` rule still sets background, padding, border-radius and overflow. We add a narrow set of `[data-theme]` / `code[data-line-numbers]` rules only if needed to stop Shiki's inline styles from clashing (e.g. ensure the `<pre>` background still wins on the outer container).

## Scope

### In Scope
- Replace `remark-html` with a `remark` → `remark-gfm` → `remark-rehype` → `rehype-pretty-code` → `rehype-stringify` pipeline in `web/lib/content.ts`.
- Add `remark-rehype`, `rehype-stringify`, `rehype-pretty-code`, and `shiki` as runtime dependencies of `@eforge-build/web`.
- Remove the `remark-html` dependency from `web/package.json` (and its import in `web/lib/content.ts`) since the new pipeline supersedes it.
- Configure `rehype-pretty-code` with `theme: { light: 'github-light', dark: 'github-dark' }` and `keepBackground: false` so the existing `.prose pre` background wins.
- Preserve all existing `.prose` styling in `web/app/globals.css`; add only the minimal additional CSS needed for Shiki-emitted markup (color inheritance on highlighted `code`, no double-padding, and a `[data-theme='dark']` / `prefers-color-scheme: dark` rule that hides the light-theme spans when in dark mode).
- Update `web/__tests__/content.test.ts` to:
  - Assert that rendering a fenced ` ```ts ` block from a known doc page (e.g. `extensions` or `extensions-api`) produces highlighted markup. Verifiable signal: presence of `data-language="ts"` (or `data-language="typescript"`) and at least one token span with an inline `style` containing `color:` in the rendered HTML.
  - Assert that plain (non-code) Markdown still renders as expected (an `<h1>` / `<p>` continues to appear) — keeps a regression guard against accidentally breaking the GFM path.
  - Keep the existing provenance-comment test passing unchanged.

### Out of Scope
- Any client-side syntax highlighter or runtime JS for code rendering.
- Adding line numbers, copy buttons, or filename headers (deferred).
- Highlighting languages other than the defaults shipped with the chosen themes — every Shiki bundled grammar still works, but no per-language tuning is added.
- Changes to the docs generator (`packages/docs-gen/`) or the source Markdown content itself.
- Refactoring the loader API (`DocPage` / `ReferencePage` shapes, `loadDocPage` / `loadReferencePage` signatures) — these stay byte-identical from a caller's perspective.
- Touching `eforge-plugin/` or `packages/pi-eforge/` — this is a web-only change; the consumer-facing-parity rule in AGENTS.md does not apply.

## Files

### Modify
- `web/package.json` — Add dependencies: `remark-rehype` (^11), `rehype-stringify` (^10), `rehype-pretty-code` (^0.14 or current stable that pairs with `shiki` ^1/^2), `shiki` (^1 or ^2 matching `rehype-pretty-code` peer). Remove `remark-html`. Use the latest stable versions discoverable at install time; pin to caret ranges consistent with the other unified ecosystem deps already in this file.
- `web/lib/content.ts` — Rewrite `renderMarkdown` to build a unified processor: `unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypePrettyCode, { theme: { light: 'github-light', dark: 'github-dark' }, keepBackground: false }).use(rehypeRaw or pass-through).use(rehypeStringify, { allowDangerousHtml: true })`. Either keep the `remark` facade (it composes the same internally) or switch to `unified` directly — whichever yields cleaner types. Cache the processor at module scope. Remove the `import remarkHtml from 'remark-html'` line. Public exports (`loadDocPage`, `loadReferencePage`, `DocPage`, `ReferencePage`) and their behavior must stay unchanged.
- `web/app/globals.css` — Keep all existing `.prose` rules intact. Add (after the existing `.prose pre code` rule) the minimum additional rules to integrate Shiki markup: (a) `.prose pre[data-language] { background-color: var(--color-code-bg); }` to keep the existing block background under Shiki's `keepBackground: false` output; (b) a `@media (prefers-color-scheme: dark)` rule that hides `.prose span[data-light-theme]` and shows `.prose span[data-dark-theme]` (and the inverse for light mode) per `rehype-pretty-code`'s documented dual-theme markup. Confirm exact selector names against the installed `rehype-pretty-code` version before authoring; if the package emits a single set of token spans with both `style--shiki-light` / `style--shiki-dark` style props instead, use those selectors. Leave inline-code styling (`.prose code` not inside `pre`) exactly as it is today.
- `web/__tests__/content.test.ts` — Add two new test cases inside the existing `loadDocPage` describe block:
  1. `it('applies syntax highlighting to TypeScript fenced blocks', ...)` that loads `extensions` (or whichever existing doc contains a ` ```ts ` fence — verify with `grep '```ts' web/content/docs/extensions.md` before authoring) and asserts the rendered `html` contains `data-language="ts"` and at least one element with an inline `style` attribute containing `color:` (i.e. evidence of token-level styling).
  2. `it('still renders plain Markdown headings and paragraphs', ...)` that loads any doc page and asserts the rendered html contains a `<h1` and a `<p` tag — guards against the new pipeline accidentally dropping GFM features.
  Keep the existing tests unchanged.

## Verification

- [ ] `pnpm --filter @eforge-build/web type-check` exits 0.
- [ ] `pnpm --filter @eforge-build/web build` exits 0 (the Shiki theme bundle resolves at build time on Node, not edge).
- [ ] `pnpm test --filter web/__tests__/content.test.ts` (or `pnpm test` from root) passes, including the two new assertions.
- [ ] In the rendered HTML of `loadDocPage('extensions')`, the substring `data-language="ts"` appears at least once, and there is at least one element whose `style` attribute contains `color:` (token-level styling present).
- [ ] The rendered HTML for `loadReferencePage('cli')` still excludes the `<!-- Generated file` provenance comment and that comment is surfaced on the returned `provenance` field — the existing test continues to pass without modification.
- [ ] `web/lib/content.ts` no longer imports `remark-html`, and `web/package.json` no longer lists `remark-html` under `dependencies`.
- [ ] `web/app/globals.css` still contains the original `.prose pre`, `.prose pre code`, and `.prose code` rules (background-color, border-radius, padding, font-size) unmodified except for additions; a `diff` confirms only additive lines for the Shiki integration.
- [ ] No new files are added under `web/` outside of dependency updates; no client component is introduced for highlighting (`grep -r 'use client' web/lib web/app/docs` returns no new occurrences attributable to this change).
