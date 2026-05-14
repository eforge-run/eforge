---
title: Repair Public Docs Links, Heading Anchors, and Reference Gaps
created: 2026-05-14
profile: pi-codex-5-5
---

# Repair Public Docs Links, Heading Anchors, and Reference Gaps

## Problem / Motivation

Public documentation still has broken or fragile internal links, missing rendered heading anchors, sparse generated config reference content, incomplete raw Markdown mirrors, and broken skill-doc links.

Current validation:

- `web/lib/content.ts` still renders Markdown without a slugging plugin, so headings do not receive `id` attributes.
- `web/content/docs/configuration.md` still links to `/reference/config#toolbelts` and `/reference/config#hooks`.
- Generated `web/content/reference/config.md` still lacks `## Toolbelts` and `## Hooks`.
- `packages/docs-gen/src/generators/config.ts` still emits only top-level fields and a JSON Schema link.
- `packages/docs-gen/src/generators/llms.ts` still mirrors only getting-started, concepts, configuration, and glossary.
- `DOCS_NAV` includes `extensions` and `extensions-api`, but `web/public/docs/extensions.md` and `web/public/docs/extensions-api.md` are still missing.
- `packages/docs-gen/src/manifest.ts` still does not list extension guides in `llms.txt`.
- `packages/docs-gen/src/check.ts` still performs drift checking only, not link/anchor validation.
- `eforge-plugin/skills/profile-new/profile-new.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` still contain broken relative links.

## Goal

Fix broken documentation links, rendered heading anchors, config-reference gaps, raw docs mirror gaps, and skill-doc links. Add tooling/tests so regressions fail during docs checks.

## Scope

### In scope

1. Add heading ID generation to the public Markdown renderer for `/docs/*` and `/reference/*`.
2. Add rendered HTML tests for representative doc/reference anchors, including current extension page headings such as `#event-patterns` or `#trust-and-security`.
3. Add a static internal docs link checker covering:
   - `web/content/docs`
   - `web/content/reference`
   - `web/public/docs`
   - `web/public/reference`
   - selected linked repo docs
   - eforge skill docs
4. Integrate link/anchor checking into `pnpm docs:check` or docs-related tests.
5. Keep `/reference/config` generated, but enrich it with useful nested sections and curated prose for:
   - `tools.toolbelts`
   - tier `toolbelt`
   - `toolbelt: none`
   - default behavior
   - MCP-server filtering boundaries
   - validation semantics
   - `hooks`
6. Ensure `/reference/config#toolbelts` and `/reference/config#hooks` resolve.
7. Mirror every `DOCS_NAV` guide page to `web/public/docs/<slug>.md`, including `extensions.md` and `extensions-api.md`.
8. Update `llms.txt` manifest entries so extension docs are discoverable.
9. Fix broken profile-new skill links in both Claude Code and Pi skill docs.
10. Replace repo-only links in public docs with public docs links, raw artifact links, or intentionally published references.

### Out of scope

- Runtime behavior changes.
- Docs site IA redesign.
- Broad prose rewrites unrelated to link integrity, anchors, mirrors, or generated reference usefulness.

## Acceptance Criteria

1. Rendered docs/reference headings include stable `id` attributes.
2. Representative rendered anchors exist for docs and generated reference pages.
3. `/reference/config#toolbelts` and `/reference/config#hooks` resolve to real useful sections.
4. The config reference documents toolbelts and hooks at the level promised by `/docs/configuration`.
5. `pnpm docs:check` fails on missing internal pages/files/fragments.
6. Every `DOCS_NAV` doc page has a raw `web/public/docs/<slug>.md` mirror.
7. `llms.txt` includes or deliberately surfaces extension docs.
8. Profile-new skill docs no longer contain broken relative links.
9. `pnpm docs:generate` remains deterministic and `pnpm docs:check` passes.
10. No runtime behavior changes are introduced.