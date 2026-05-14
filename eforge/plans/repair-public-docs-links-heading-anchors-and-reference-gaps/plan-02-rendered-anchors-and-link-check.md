---
id: plan-02-rendered-anchors-and-link-check
name: Add Rendered Anchors and Docs Link Checking
branch: repair-public-docs-links-heading-anchors-and-reference-gaps/plan-02-rendered-anchors-and-link-check
---

# Add Rendered Anchors and Docs Link Checking

## Architecture Context

The public Next.js docs site renders Markdown through `web/lib/content.ts`. `pnpm docs:check` currently builds `@eforge-build/docs-gen` and runs a drift-only comparison. After plan-01 creates the missing reference anchors and raw mirrors, this plan can add slugged rendered headings and a static link/fragment checker without introducing known failures.

## Implementation

### Overview

Add heading IDs to rendered docs/reference HTML, then add a docs link checker that validates internal pages, raw files, fragments, selected repo docs, and eforge skill docs. Integrate that checker into `docs-gen check` so `pnpm docs:check` fails on missing internal targets or fragments.

### Key Decisions

1. Use `rehype-slug` in the shared Markdown processor so both `/docs/*` and `/reference/*` headings receive GitHub-style stable IDs.
2. Use a `github-slugger`-compatible slug implementation in the static checker so Markdown fragments are validated against the same anchor semantics as rendered pages.
3. Treat `https://eforge.build/...` links as internal docs links and validate them against local content, raw public files, routes, schemas, or known public paths.
4. Keep external third-party URLs out of scope for the static checker; this work targets internal docs integrity.
5. Make mirror completeness a check: every `DOCS_NAV` slug must have `web/content/docs/<slug>.md` and `web/public/docs/<slug>.md`.

## Scope

### In Scope

- Heading ID generation for docs and reference Markdown rendering.
- Rendered HTML tests for representative anchors, including `event-patterns`, `trust-and-security`, `toolbelts`, and `hooks`.
- Static internal link/page/file/fragment checking for:
  - `web/content/docs`
  - `web/content/reference`
  - `web/public/docs`
  - `web/public/reference`
  - selected repo docs: `docs/config.md`, `docs/hooks.md`, `docs/extensions.md`, `docs/extensions-api.md`, and `packages/extension-sdk/README.md`
  - eforge skill docs under `eforge-plugin/skills` and `packages/pi-eforge/skills`
- `pnpm docs:check` integration for link and anchor validation.
- Tests that fail when a current internal docs link, raw mirror, or fragment regresses.

### Out of Scope

- Runtime engine, daemon, plugin, or Pi extension behavior.
- Network checking of external URLs.
- Adding visible permalink icons beside headings.

## Files

### Create

- `packages/docs-gen/src/link-check.ts` — static docs link checker with scan roots, selected repo files, route/raw-file resolution, fragment validation, `DOCS_NAV` mirror checks, and issue reporting.
- `test/docs-link-check.test.ts` — Vitest coverage for the checker against the repository and at least one missing-fragment fixture or helper case.

### Modify

- `web/package.json` — add `rehype-slug` dependency.
- `packages/docs-gen/package.json` — add `github-slugger` dependency if the checker imports it directly.
- `pnpm-lock.yaml` — update dependency lock entries for the new packages.
- `web/lib/content.ts` — register `rehype-slug` between `remarkRehype` and `rehypePrettyCode` in the shared processor.
- `web/__tests__/content.test.ts` — assert representative rendered heading IDs for docs and reference pages.
- `packages/docs-gen/src/check.ts` — expose `runLinkCheck` or a combined check result, and keep `runDriftCheck` usable by existing tests.
- `packages/docs-gen/src/cli.ts` — make the `check` subcommand run both drift and link checks, printing link issues with source file, href, and reason before exiting nonzero.
- `test/docs-gen-determinism.test.ts` — if the combined docs check API changes, update imports while retaining the existing drift and determinism assertions.

## Link Checker Requirements

- Resolve `/docs/<slug>` to `web/content/docs/<slug>.md` and `/docs/<slug>.md` to `web/public/docs/<slug>.md`.
- Resolve `/reference/<slug>` to `web/content/reference/<slug>.md` and `/reference/<slug>.md` to `web/public/reference/<slug>.md`.
- Resolve `/schemas/<file>` to `web/public/schemas/<file>`.
- Resolve relative Markdown links from the source file directory, trying the literal path and a `.md` suffix for extensionless Markdown links.
- Validate `#fragment` against generated heading IDs for Markdown targets.
- Validate same-file fragments.
- Ignore third-party `http(s)` URLs except `https://eforge.build/...`, which must be mapped back to local docs artifacts.
- Ignore `mailto:`, `tel:`, and code-fence contents.
- Report public-doc references to unpublished repo-only paths such as `web/content/` or `docs/prd/` as issues.

## Verification

- [ ] `loadDocPage('extensions')` HTML contains `id="event-patterns"` and `id="trust-and-security"`.
- [ ] `loadReferencePage('config')` HTML contains `id="toolbelts"` and `id="hooks"`.
- [ ] `runLinkCheck()` returns zero issues for the repository after plan-01 outputs are present.
- [ ] A test fixture or helper case with a missing internal fragment returns at least one link-check issue containing the source file and fragment.
- [ ] `pnpm docs:check` exits nonzero when an internal docs link points at a missing page/file/fragment.
- [ ] `pnpm docs:check` exits 0 with the checked-in docs artifacts.
- [ ] `pnpm test` passes with the new rendered-anchor and link-check tests.