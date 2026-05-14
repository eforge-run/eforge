---
id: plan-01-reference-and-mirror-content
name: Enrich Generated Reference Content and Raw Mirrors
branch: repair-public-docs-links-heading-anchors-and-reference-gaps/plan-01-reference-and-mirror-content
---

# Enrich Generated Reference Content and Raw Mirrors

## Architecture Context

The docs generator owns generated reference artifacts under `web/content/reference/`, public raw reference mirrors under `web/public/reference/`, raw guide mirrors under `web/public/docs/`, and `llms.txt` / `llms-full.txt`. Hand-authored guide content lives under `web/content/docs/` and is mirrored by `packages/docs-gen/src/generators/llms.ts` during `pnpm docs:generate`.

This plan fixes the content gaps before the stricter link checker lands in the dependent plan, so `docs:check` does not gain a new failing gate before the generated targets and skill links exist.

## Implementation

### Overview

Keep `/reference/config` generated, but extend the config generator with curated nested sections for toolbelts and hooks. Expand raw docs mirroring to include the extension guide pages, surface those pages in `llms.txt`, and replace broken repo-relative profile-new skill links with public documentation URLs.

### Key Decisions

1. Keep generated config reference content in `packages/docs-gen/src/generators/config.ts`; do not hand-edit `web/content/reference/config.md` beyond regenerating it.
2. Add explicit output path keys for `extensions.md` and `extensions-api.md` raw mirrors so drift checks compare the new checked-in files.
3. Use public `https://eforge.build/...` links in profile-new skill docs because those files are consumed from plugin/extension packages where repo-relative paths are fragile.
4. Remove or rewrite public-doc references to unpublished repo-only paths such as `docs/prd/profile-toolbelts.md`; public docs must point at public docs pages, raw artifacts, schemas, or deliberately external references.

## Scope

### In Scope

- Generated `/reference/config` sections for `## Toolbelts` and `## Hooks`.
- Curated config-reference prose for `tools.toolbelts`, tier `toolbelt`, `toolbelt: none`, default behavior, MCP-server filtering boundaries, validation semantics, and hooks.
- Raw Markdown mirrors for `web/content/docs/extensions.md` and `web/content/docs/extensions-api.md`.
- `llms.txt` manifest entries that expose extension docs.
- Public configuration guide link/prose updates needed for the new config-reference anchors.
- Profile-new skill doc link fixes in both `eforge-plugin/` and `packages/pi-eforge/`.

### Out of Scope

- Runtime config parsing, toolbelt filtering, hook execution, extension loading, or daemon behavior.
- Documentation information architecture changes.
- Broad prose rewrites unrelated to link integrity, mirrors, or generated reference coverage.

## Files

### Create

- `web/public/docs/extensions.md` — generated raw mirror of `web/content/docs/extensions.md`.
- `web/public/docs/extensions-api.md` — generated raw mirror of `web/content/docs/extensions-api.md`.

### Modify

- `packages/docs-gen/src/generators/config.ts` — append deterministic curated `## Toolbelts` and `## Hooks` sections after the top-level field table and before `## JSON Schema`; include examples and validation/runtime boundary notes.
- `packages/docs-gen/src/output-paths.ts` — add output path keys for `publicDocsExtensions` and `publicDocsExtensionsApi` so drift checks cover the new mirrors.
- `packages/docs-gen/src/generators/llms.ts` — mirror extension guide Markdown to `web/public/docs/` along with the existing guide mirrors.
- `packages/docs-gen/src/manifest.ts` — add extension guide/API entries to the LLMs manifest, using raw URLs `/docs/extensions.md` and `/docs/extensions-api.md`.
- `web/content/docs/configuration.md` — replace repo-only/public-fragile references with public docs/reference links and align hook examples with the generated hooks reference.
- `web/public/docs/configuration.md` — regenerated mirror of the configuration guide after the source changes.
- `web/content/reference/config.md` — regenerated config reference with `## Toolbelts` and `## Hooks`.
- `web/public/reference/config.md` — regenerated raw config reference mirror.
- `web/public/llms.txt` — regenerated manifest output that lists extension docs.
- `web/public/llms-full.txt` — regenerated full reference bundle containing the enriched config reference.
- `eforge-plugin/skills/profile-new/profile-new.md` — replace broken `web/content/...` and `docs/config.md#toolbelts` links with public docs/reference URLs.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — mirror the profile-new skill link fixes for the Pi integration.

## Verification

- [ ] `pnpm docs:generate` creates `web/public/docs/extensions.md` and `web/public/docs/extensions-api.md` from the matching `web/content/docs/` sources.
- [ ] `web/content/reference/config.md` and `web/public/reference/config.md` each contain headings `## Toolbelts` and `## Hooks`.
- [ ] The generated config reference contains the strings `tools.toolbelts`, `toolbelt: none`, `omitted`, `.mcp.json`, and `validation` in the Toolbelts section.
- [ ] The generated config reference contains hook fields `event`, `command`, and `timeout` in the Hooks section.
- [ ] `web/public/llms.txt` contains `/docs/extensions.md` and `/docs/extensions-api.md` entries.
- [ ] Profile-new skill docs contain `https://eforge.build/docs/configuration#profile-toolbelts-for-ui-work` and `https://eforge.build/reference/config#toolbelts`.
- [ ] `rg 'web/content/docs/configuration.md|docs/config.md#toolbelts|docs/prd/profile-toolbelts.md' eforge-plugin/skills/profile-new/profile-new.md packages/pi-eforge/skills/eforge-profile-new/SKILL.md web/content/docs/configuration.md web/public/docs/configuration.md` returns no matches.
- [ ] `pnpm docs:check` exits 0 after regeneration.