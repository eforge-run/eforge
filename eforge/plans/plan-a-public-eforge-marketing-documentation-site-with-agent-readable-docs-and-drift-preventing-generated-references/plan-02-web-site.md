---
id: plan-02-web-site
name: Next.js web/ public site, dev/build wiring, README and CI integration
branch: plan-a-public-eforge-marketing-documentation-site-with-agent-readable-docs-and-drift-preventing-generated-references/plan-02-web-site
agents:
  builder:
    effort: high
    rationale: Scaffolds a new Next.js app inside an existing pnpm monorepo, wires
      it into the workspace, adds new root scripts, and updates CI. Touches many
      files and requires careful coordination of routing for raw .md artifacts
      under app/ vs static assets under public/.
  doc-author:
    effort: medium
    rationale: Authors three hand-written docs pages (getting-started, concepts,
      configuration) plus the landing page copy from existing README content.
---

## Architecture Context

This plan delivers the public site itself at `eforge.build` and the developer/CI workflow around it. It depends on plan-01: the generated reference Markdown under `web/content/reference/` and `web/public/reference/`, the JSON schemas under `web/public/schemas/`, and the agent-readable `web/public/llms.txt` / `web/public/llms-full.txt` are already on disk and tracked in git when plan-02 starts.

Design decisions enforced here:

- **Minimal custom docs shell, no Fumadocs.** Authored docs and generated reference Markdown are rendered with a small in-house Markdown loader (`remark` + `rehype` toolchain — single dep choice baked in). No MDX, no plugin architecture, no full-text search, no versioning. Sidebar is a checked-in `web/lib/nav.ts` manifest.
- **Raw `.md` URLs are stable for agents.** `/reference/cli.md`, `/reference/api.md`, `/reference/events.md`, `/reference/config.md`, `/reference/tools.md`, `/llms.txt`, `/llms-full.txt`, `/schemas/events.schema.json`, and `/schemas/config.schema.json` are served directly from `web/public/` so Next.js never re-encodes or transforms them. This guarantees agents see the exact same bytes that ship from `pnpm docs:generate`.
- **Human-readable HTML pages live under `/docs/...` and `/reference/<slug>`.** The HTML rendering reads from `web/content/`. The raw `.md` URLs read from `web/public/`. Both come from the same generator output, so they cannot disagree.
- **`pnpm docs:dev` is the primary developer command.** It first runs `pnpm docs:generate` (so a fresh checkout works even before any code-owned source-of-truth file has been edited) and then starts the Next.js dev server on `http://localhost:3000`. It must not require the eforge daemon, LLM credentials, or Vercel. Generator watch mode is not required for MVP.
- **CI extends the existing single `test` job in `.github/workflows/ci.yml`** by appending `pnpm docs:check` (drift gate) and `pnpm docs:build` (site build gate) after the existing `pnpm test` step. The order matters: drift first (fast and explanatory), site build second.
- **README links to the public site.** A single 'Public docs' callout near the top of `README.md` points to `https://eforge.build` and explains that the canonical reference docs live there. `README.md` continues to be the repo overview.

## Implementation

### Overview

Scaffold a Next.js 15 App Router app at `web/`, add it to `pnpm-workspace.yaml`, render hand-written `web/content/docs/*.md` and generated `web/content/reference/*.md` as HTML pages via a small `web/lib/content.ts` Markdown loader and a sidebar manifest, expose the agent-readable raw routes from `web/public/`, add `docs:dev` / `docs:build` to the root `package.json`, link from `README.md`, and extend CI to fail on drift or broken builds.

### Key Decisions

1. **Next.js 15 App Router, React 19, static export not used.** Use the standard build target for Vercel; the site is small enough that Vercel handles it via the framework's normal output.
2. **No Tailwind for MVP.** Ship a single `web/app/globals.css` with hand-written CSS variables and a simple typography reset. Keeps the dep surface small per the source's explicit preference for a boring shell.
3. **No shadcn/ui.** The monitor UI uses shadcn, but the public site is a different product with different goals. Reuse no monitor-ui code.
4. **Markdown renderer: `remark` + `remark-html` + `remark-gfm`.** Three small, well-known deps. No syntax highlighter for MVP — code blocks render as plain `<pre><code>`. Acceptable trade-off per scope.
5. **Raw `.md` routes are served from `public/` only.** Next.js serves anything under `public/` byte-for-byte. We do NOT add per-file `route.ts` handlers, because doing so would re-encode UTF-8 content unnecessarily.
6. **Sidebar manifest, not file-system routing for docs nav.** `web/lib/nav.ts` exports the docs tree shape so the order is intentional. Adding a new doc requires a one-line manifest edit.
7. **`docs:dev` always regenerates first.** This makes the dev loop self-healing — if a generator source-of-truth file has been edited since the last commit, the dev preview reflects the change.

## Scope

### In Scope

- New Next.js app at `web/` with App Router, TypeScript, React 19, and a workspace `package.json` named `@eforge-build/web`.
- Landing page (`web/app/page.tsx`) with eforge value proposition, install paths (Claude Code, Pi, standalone CLI), and links to docs / GitHub / npm.
- Docs section under `web/app/docs/` with at least four pages: getting-started, concepts, configuration, and the generated-reference index.
- Generated reference pages under `web/app/reference/[slug]/page.tsx`, sourced from `web/content/reference/*.md`.
- Raw agent-readable artifacts served from `web/public/`: `/llms.txt`, `/llms-full.txt`, `/reference/{cli,api,events,config,tools}.md`, `/schemas/{events,config}.schema.json` (already on disk from plan-01).
- Markdown loader `web/lib/content.ts` and sidebar manifest `web/lib/nav.ts`.
- Root scripts `docs:dev` and `docs:build` in the repo `package.json`.
- `web` added to `pnpm-workspace.yaml`.
- `.github/workflows/ci.yml` extended with `pnpm docs:check` and `pnpm docs:build` steps.
- `README.md` updated with a 'Public docs' callout linking to `https://eforge.build`.
- A minimal vitest spec verifying the Markdown loader and sidebar manifest.

### Out of Scope

- Tailwind, shadcn, or any design-system component library.
- Full-text search, versioned docs, blog, auth.
- Custom 404 pages beyond Next.js defaults.
- Vercel project setup (deployment configuration is out — the `homepage` in root `package.json` already points to `https://eforge.build`; provisioning a Vercel project is a separate manual step).
- Replacing or moving existing repo docs under `docs/`. They remain the source of truth for contributors; the public site is the source of truth for users and agents.

## Files

### Create

- `web/package.json` — name `@eforge-build/web`, `private: true`, scripts `dev`, `build`, `start`, `type-check`; deps: `next@^15`, `react@^19`, `react-dom@^19`, `remark`, `remark-html`, `remark-gfm`, `gray-matter`; devDeps: `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `vitest`.
- `web/tsconfig.json` — extends `../tsconfig.base.json` (relative path from `web/`), `jsx: preserve`, Next.js standard `include`.
- `web/next.config.mjs` — minimal config; `experimental: {}`; no rewrites needed because raw `.md` and `.json` are served straight from `public/`.
- `web/next-env.d.ts` — standard Next.js types file.
- `web/app/layout.tsx` — root layout with `<html>`, `<head>` (title 'eforge — agentic build system'), and a top nav bar linking to /docs, /reference, GitHub, npm.
- `web/app/globals.css` — hand-written CSS: CSS variables for color and spacing, a system font stack, basic typography for `.prose` content, code-block styling.
- `web/app/page.tsx` — landing page: hero with eforge tagline, three install-path cards (Claude Code, Pi, standalone CLI), feature highlights, link to docs and GitHub.
- `web/app/docs/layout.tsx` — docs-section layout with a left sidebar driven by `web/lib/nav.ts`.
- `web/app/docs/page.tsx` — docs index page (redirects to getting-started or renders a TOC).
- `web/app/docs/[slug]/page.tsx` — dynamic route that reads `web/content/docs/<slug>.md`, renders it via the loader, and 404s on unknown slugs. `generateStaticParams()` enumerates the manifest.
- `web/app/reference/layout.tsx` — reference-section layout reusing the docs sidebar or its own simple nav.
- `web/app/reference/page.tsx` — generated-reference index page that lists the 5 canonical references plus the 2 schemas plus links to `/llms.txt` and `/llms-full.txt`.
- `web/app/reference/[slug]/page.tsx` — dynamic route that reads `web/content/reference/<slug>.md` (rendered HTML view of the generator output). Strips the provenance header from the displayed body but renders it as a callout. `generateStaticParams()` enumerates the five known slugs (cli, api, events, config, tools).
- `web/lib/content.ts` — exports `loadDocPage(slug)` and `loadReferencePage(slug)` that read from `web/content/docs/` and `web/content/reference/` respectively, parse with `gray-matter`, render Markdown via `remark` + `remark-gfm` + `remark-html`, and return `{ frontmatter, html, provenance? }`.
- `web/lib/nav.ts` — exports `DOCS_NAV` (array of `{ slug, title, group }`) and `REFERENCE_NAV` (array of `{ slug, title, raw: string, schema?: string }`). Order is intentional.
- `web/lib/paths.ts` — exports content-root constants used by the loader (so tests can override).
- `web/content/docs/getting-started.md` — hand-written: installation paths for Claude Code, Pi, and standalone CLI (sourced from existing README content), first build, where to look next.
- `web/content/docs/concepts.md` — hand-written: agentic build system overview, separation of concerns, plan-build-review pipeline, harnesses, profiles. Drawn from README and `docs/architecture.md`.
- `web/content/docs/configuration.md` — hand-written explanatory companion that complements the generated `/reference/config.md` — explains the most important config blocks and links to the canonical reference for the full schema.
- `web/__tests__/content.test.ts` — vitest spec for `loadDocPage`/`loadReferencePage`: asserts known slugs return non-empty HTML; unknown slugs throw a typed error; provenance headers in reference files are stripped from `html` and surfaced separately.
- `.github/workflows/ci.yml` — extended (see Modify).

### Modify

- `pnpm-workspace.yaml` — add `web` to the packages list so pnpm manages the new app.
  ```yaml
  packages:
    - "packages/*"
    - "web"
  ```
- `package.json` (repo root) — add scripts:
  - `docs:dev`: `pnpm docs:generate && pnpm --filter @eforge-build/web dev`
  - `docs:build`: `pnpm docs:generate && pnpm --filter @eforge-build/web build`
  Also add `@eforge-build/web: workspace:*` to `devDependencies` so `pnpm -r ...` reaches the new package consistently.
- `.github/workflows/ci.yml` — after the existing `pnpm test` step in the `test` job, append two steps in this order: `- run: pnpm docs:check` then `- run: pnpm docs:build`. Use the existing Node 22 / pnpm setup, no new job needed.
- `README.md` — add a top-of-file 'Public docs' callout linking to `https://eforge.build/docs` and a footer line referencing the canonical agent-readable artifacts at `/llms.txt`. Do not remove existing content; the README continues to serve repository visitors.
- `tsconfig.json` (repo root) — if the root tsconfig references workspace projects, add `web` to the references; otherwise no change (the file currently only lists workspace globs).

## Verification

- [ ] `pnpm install` succeeds with `web` listed in `pnpm-workspace.yaml`.
- [ ] `pnpm --filter @eforge-build/web build` exits with code 0 and writes `web/.next/`.
- [ ] `pnpm docs:build` exits with code 0 (regenerates first, then builds).
- [ ] `pnpm docs:dev` starts a Next.js dev server reachable on `http://localhost:3000` without requiring the eforge daemon, an `ANTHROPIC_API_KEY`, or a Vercel link. Confirmed by running it on a fresh git checkout with no prior `pnpm docs:generate` run.
- [ ] Loading `http://localhost:3000/` returns HTTP 200 and the response body contains the strings 'eforge', a value proposition, and links to '/docs' and 'github.com/eforge-build/eforge'.
- [ ] Loading `http://localhost:3000/docs/getting-started`, `/docs/concepts`, and `/docs/configuration` each return HTTP 200 with non-empty rendered HTML bodies.
- [ ] Loading `http://localhost:3000/reference` returns HTTP 200 and lists the five canonical references (cli, api, events, config, tools) and the two schema files.
- [ ] Loading `http://localhost:3000/reference/cli`, `/reference/api`, `/reference/events`, `/reference/config`, `/reference/tools` each return HTTP 200 with the rendered generator output, including a visible provenance callout containing the generated-at commit hash.
- [ ] Loading `http://localhost:3000/reference/cli.md` returns HTTP 200 with `Content-Type` starting with `text/markdown` or `text/plain` (whatever Next.js serves for `public/*.md`) and a body byte-identical to `web/public/reference/cli.md`. Same check for `/reference/api.md`, `/reference/events.md`, `/reference/config.md`, `/reference/tools.md`.
- [ ] Loading `http://localhost:3000/llms.txt` returns HTTP 200 and a body byte-identical to `web/public/llms.txt`.
- [ ] Loading `http://localhost:3000/llms-full.txt` returns HTTP 200 and a body byte-identical to `web/public/llms-full.txt`.
- [ ] Loading `http://localhost:3000/schemas/events.schema.json` returns HTTP 200 with `application/json` (or `application/octet-stream`) and a body that parses as valid JSON Schema. Same for `/schemas/config.schema.json`.
- [ ] `pnpm test` runs `web/__tests__/content.test.ts` along with the rest of the suite and passes.
- [ ] `pnpm type-check` succeeds across the workspace including `web`.
- [ ] `.github/workflows/ci.yml` ends with `pnpm docs:check` followed by `pnpm docs:build` as the last two steps of the `test` job.
- [ ] `README.md` contains an https://eforge.build link in the first 50 lines and an `/llms.txt` reference in its body.
- [ ] Removing any single output file from `web/public/reference/` and re-running `pnpm docs:check` exits non-zero (drift gate works).
- [ ] `web/lib/nav.ts` lists exactly the five reference slugs (cli, api, events, config, tools), matching the generator output set in plan-01.
- [ ] No file under `web/public/reference/`, `web/public/schemas/`, `web/public/llms.txt`, or `web/public/llms-full.txt` is hand-edited in this plan — those remain owned by the generator from plan-01.
