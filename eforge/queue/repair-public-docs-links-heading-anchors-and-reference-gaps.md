---
title: Repair Public Docs Links, Heading Anchors, and Reference Gaps
created: 2026-05-14
depends_on: ["add-extension-discovery-config-and-loader"]
profile: pi-codex-5-5
---

# Repair Public Docs Links, Heading Anchors, and Reference Gaps

## Problem / Motivation

Public documentation has broken links, missing rendered heading anchors, sparse generated reference content, incomplete raw Markdown mirrors, and broken skill-doc links.

Evidence gathered from the public docs site, generated reference docs, docs generator, and repo docs:

- `web/lib/content.ts` renders Markdown with `remarkParse`, `remarkGfm`, `remarkRehype`, `rehypePrettyCode`, and `rehypeStringify`; there is no slugging plugin. Therefore rendered headings do not receive `id` attributes, so same-page heading links such as `/docs/extensions` → `#relationship-to-shell-hooks-playbooks-and-toolbelts` cannot work in the browser.
- `web/content/docs/extensions.md` contains the user-reported link `[Relationship to shell hooks](#relationship-to-shell-hooks-playbooks-and-toolbelts)`. The target heading exists in Markdown, but the renderer does not emit heading IDs.
- `web/content/docs/configuration.md` links to `/reference/config#toolbelts` twice and `/reference/config#hooks` once. The generated `web/content/reference/config.md` currently has only `## Top-level fields` and `## JSON Schema`; no `## Toolbelts` or `## Hooks` anchors exist.
- `packages/docs-gen/src/generators/config.ts` generates the config reference from `z.toJSONSchema(eforgeConfigSchema)`, but only emits a top-level field table and the JSON Schema link. Top-level descriptions are blank because many top-level Zod schema fields have no `.describe()` metadata.
- The richer config docs, including `## Toolbelts` and `## Hooks`, exist in repo-only `docs/config.md`, but the public `/reference/config` page is generated and sparse.
- `packages/docs-gen/src/generators/llms.ts` mirrors only four guide pages to `web/public/docs`: getting-started, concepts, configuration, and glossary. `web/content/docs/extensions.md` and `web/content/docs/extensions-api.md` render on the site but are not mirrored to raw `/docs/*.md` agent-readable files.
- `packages/docs-gen/src/manifest.ts` includes only Getting Started and Configuration as primary guides; Extensions docs are not in `llms.txt`.
- `web/__tests__/content.test.ts` checks rendering and syntax highlighting, but does not check heading IDs, internal link targets, fragments, or raw mirror coverage.
- `packages/docs-gen/src/check.ts` performs drift checking for generated outputs, but does not validate links or anchors.
- A local static link audit found 16 concrete issues across public content and skill docs, including the user-reported `/reference/config#toolbelts` and same-page anchor classes of failures.
- `docs/roadmap.md` includes ongoing Extensibility work and Schema library unification; this docs repair aligns with Integration & Maturity / docs quality rather than adding a new roadmap-level product feature.

## Goal

Fix broken documentation links, rendered heading anchors, config-reference gaps, raw docs mirror gaps, and skill-doc link issues. Add docs tooling/tests so these regressions fail during docs checks.

## Approach

### High-level implementation

- Add heading ID generation to the public Markdown renderer so same-page and cross-page fragment links work on `/docs/*` and `/reference/*` pages.
- Add tests for representative rendered anchors, including the known `/docs/extensions` relationship section.
- Add a static internal link checker for public docs, generated reference docs, raw public Markdown mirrors, and skill docs.
- Validate local route targets, raw `.md` targets, and fragment anchors.
- Integrate the checker into `pnpm docs:check` or an existing docs-related test so broken docs links fail CI.
- Keep `/reference/config` generated from the config schema, but make it rich enough to be a true reference.
- Generate nested field sections/anchors where practical and add curated explanations/examples for high-value sections such as `tools.toolbelts`, tier `toolbelt`, and `hooks`.
- Ensure `/reference/config#toolbelts` and `/reference/config#hooks` resolve to real useful sections.
- Mirror all public guide pages from `web/content/docs/` to `web/public/docs/`, including `extensions.md` and `extensions-api.md`.
- Update `llms.txt` manifest entries so extensions docs are discoverable by agents.
- Fix broken links in `eforge-plugin/skills/profile-new/profile-new.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`.
- Prefer public absolute docs links where appropriate, or correct repo-relative paths when linking to source files.
- Replace repo-only references from public docs with public links, or publish the referenced material if it should be public.
- Specifically address the `docs/hooks.md` and `docs/prd/profile-toolbelts.md` references currently visible in public docs.

### Recommendation for `/reference/config`

Choose generated-rich reference, option A, not wholesale replacement with hand-authored `docs/config.md`, option B.

Rationale:

- `/reference/config` is advertised as schema-derived and machine-readable-adjacent; keeping it generated prevents drift from runtime schema.
- Hand-authored `docs/config.md` is useful narrative/reference prose, but publishing it directly as the canonical reference risks divergence from `eforgeConfigSchema`.
- The best outcome is a generated nested schema reference with curated examples/explanations spliced in for sections users actually navigate to: `toolbelts`, `hooks`, tiers/profiles.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| The primary cause of the `#relationship-to-shell-hooks-playbooks-and-toolbelts` failure is missing rendered heading IDs. | Inspected `web/lib/content.ts`; Markdown pipeline lacks `rehype-slug` or equivalent. Inspected `web/content/docs/extensions.md`; target heading exists in Markdown. | high | low | Add heading slug plugin and a rendered HTML assertion for the known anchor. | If wrong, adding slugging alone would not fix the browser behavior; tests should catch this. |
| `/reference/config#toolbelts` and `/reference/config#hooks` fail because generated config reference lacks those sections. | Inspected `web/content/reference/config.md`; only `## Top-level fields` and `## JSON Schema` exist. Inspected `packages/docs-gen/src/generators/config.ts`; it emits only top-level field table plus schema link. | high | low | Update generator and assert generated Markdown/rendered HTML include expected headings/anchors. | If wrong, user-facing config links might remain broken despite generator changes. |
| A generated-rich `/reference/config` is preferable to publishing `docs/config.md` wholesale. | Current `/reference/config` is produced by docs-gen from `eforgeConfigSchema`; `docs:check` enforces generated drift. Hand-authored `docs/config.md` is richer but separate and can drift. | medium | medium | Confirm with maintainers; prototype nested generated reference with curated sections; ensure generated output remains useful. | If team prefers hand-authored public reference, implementation may over-invest in generator work. |
| Adding `rehype-slug` is acceptable dependency/tooling-wise. | Searched `package.json`, `pnpm-lock.yaml`, and web package files; no slug plugin currently installed. The current renderer already uses rehype plugins. | high | low | Add dependency to `web/package.json`, install/update lockfile, run web tests/build. | If dependency is undesirable, implement a local slugging rehype plugin or use another existing package. |
| Link checking can run without network access. | The known failures are internal routes/files/fragments. Existing docs-gen check already runs local generation and file comparisons only. | high | low | Implement checker to skip external `http(s)` links by default and validate only local links. | If external checking is required, docs:check could become flaky or slow; avoid for this scope. |
| Skill docs should be part of docs link integrity coverage. | User explicitly requested skill docs be fixed. The broken links were found in both profile-new skill files. | high | low | Include skill docs in checker input roots and fix links. | If checker covers too broad a set, it may flag intentional examples; provide ignore rules or scoped roots. |
| Raw docs mirror should cover all public `DOCS_NAV` pages. | Inspected `web/lib/nav.ts`; DOCS_NAV includes extensions pages. Inspected `packages/docs-gen/src/generators/llms.ts`; only four guides are mirrored. | high | low | Generate raw mirrors from a central list or add missing entries and assert all DOCS_NAV slugs have mirrors. | If raw mirror scope is intentionally smaller, adding mirrors may change public artifact surface, but it aligns with agent-readable docs claims. |

Additional assumptions and unknowns:

- Assumption: adding `rehype-slug` is acceptable for the public renderer.
  - Confidence: high.
  - Evidence: current unified/rehype pipeline and common ecosystem practice.
  - Validation path: add dependency, render docs, assert heading IDs in tests.
- Assumption: improving `/reference/config` can be done in docs-gen without changing runtime config behavior.
  - Confidence: high.
  - Evidence: generator-only code path.
  - Validation path: update docs-gen output and run `pnpm docs:check`.
- Unknown: whether the team wants `/reference/config` to duplicate the rich hand-authored `docs/config.md` or remain generated from schema with nested sections.
  - This is a product/docs-source decision to capture in design decisions.
- No low-confidence/high-impact assumptions remain unresolved.
- The only medium-confidence product decision is the config-reference strategy.
- Recommendation is generated-rich reference with curated sections.
- If the user rejects that, the fallback is to publish/merge `docs/config.md` as the public config reference and update generated-reference claims accordingly.

### Recommended eforge profile

Recommended eforge profile: **Excursion**.

Rationale: this is a focused docs/tooling repair touching several files across the web docs renderer, docs generator, generated artifacts, and skill docs. A single cohesive plan can cover the work end-to-end, including dependencies between renderer anchors, generated config reference anchors, raw docs mirrors, and link-check enforcement. It does not require delegated module planning or separate subsystem architecture, so Expedition would add unnecessary overhead. It is more than an Errand because the fix spans content, generation, tests, and CI-style checks.

## Scope

### In scope

1. **Rendered heading anchors**
   - Add heading ID generation to the public Markdown renderer so same-page and cross-page fragment links work on `/docs/*` and `/reference/*` pages.
   - Add tests for representative rendered anchors, including the known `/docs/extensions` relationship section.

2. **Automated internal link and anchor checking**
   - Add a static internal link checker for public docs, generated reference docs, raw public Markdown mirrors, and skill docs.
   - Validate local route targets, raw `.md` targets, and fragment anchors.
   - Integrate the checker into `pnpm docs:check` or an existing docs-related test so broken docs links fail CI.

3. **Config reference repair**
   - Recommended approach: keep `/reference/config` generated from the config schema, but make it rich enough to be a true reference.
   - Generate nested field sections/anchors where practical and add curated explanations/examples for high-value sections such as `tools.toolbelts`, tier `toolbelt`, and `hooks`.
   - This preserves the generated reference as canonical/drift-safe while avoiding full duplication of `docs/config.md`.
   - Ensure `/reference/config#toolbelts` and `/reference/config#hooks` resolve to real useful sections.

4. **Raw docs mirror and LLM docs index**
   - Mirror all public guide pages from `web/content/docs/` to `web/public/docs/`, including `extensions.md` and `extensions-api.md`.
   - Update `llms.txt` manifest entries so extensions docs are discoverable by agents.

5. **Skill doc link cleanup**
   - Fix broken links in `eforge-plugin/skills/profile-new/profile-new.md` and `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`.
   - Prefer public absolute docs links where appropriate, or correct repo-relative paths when linking to source files.

6. **Public docs content cleanup**
   - Replace repo-only references from public docs with public links, or publish the referenced material if it should be public.
   - Specifically address the `docs/hooks.md` and `docs/prd/profile-toolbelts.md` references currently visible in public docs.

### Out of scope

- Redesigning the docs site IA/navigation beyond the pages needed for broken-link repair.
- Building a complete hand-written HTTP API guide; note API reference shall be reported as a gap, but only link integrity/config-reference issues are in this repair scope unless implementation chooses an incremental API docs improvement.
- Changing eforge runtime behavior, config semantics, toolbelt behavior, extension behavior, or MCP/tool behavior.
- Broad prose rewrites unrelated to broken links, missing anchors, raw mirror consistency, or reference discoverability.

### Documentation impact

#### Public guide pages

- `web/content/docs/extensions.md`
  - Same-page anchor link to `Relationship to shell hooks, playbooks, and toolbelts` currently fails in rendered HTML because headings have no IDs.
  - Reference to `docs/hooks.md` is repo-oriented and not useful on the public site. Replace with a public route/reference link or publish a hooks page.

- `web/content/docs/configuration.md`
  - Links to `/reference/config#toolbelts` and `/reference/config#hooks` currently target missing anchors.
  - Text claims the Configuration Reference contains full schema/details, but generated `/reference/config` is currently sparse.
  - Repo-only reference to `docs/prd/profile-toolbelts.md` should be replaced with public-facing rationale or a published raw/source link.

- `web/content/docs/getting-started.md`
  - Raw Markdown links like `./concepts` work as rendered routes but are ambiguous/broken in raw `/docs/getting-started.md` agent-readable context. Link checker should decide/enforce the intended convention.

#### Generated public reference

- `web/content/reference/config.md` and `web/public/reference/config.md`
  - Need real `## Toolbelts` and `## Hooks` sections, or equivalent headings that produce expected anchors.
  - Should include nested config field detail sufficient for links from guide pages to be meaningful.
  - Top-level blank descriptions should be improved where feasible.

- `web/content/reference/tools.md` and `web/public/reference/tools.md`
  - Existing generated Pi tool row for `eforge_apply_recovery` has a blank description. This is a reference quality gap; include if practical or at least make the checker capable of catching blank public reference descriptions.

#### Raw agent-readable docs

- `web/public/docs/extensions.md` and `web/public/docs/extensions-api.md`
  - Missing today despite rendered `/docs/extensions` and `/docs/extensions-api` pages existing.

- `web/public/llms.txt`
  - Should include discoverable links for Extensions and Extensions API docs.

- `web/public/llms-full.txt`
  - May need updating if generated/reference content changes.
  - Current full bundle is reference-only by design, so adding guide pages is not necessarily required unless the manifest contract changes.

#### Skill docs

- `eforge-plugin/skills/profile-new/profile-new.md`
  - Broken relative links:
    - `web/content/docs/configuration.md#profile-toolbelts-for-ui-work`
    - `docs/config.md#toolbelts`
  - These are invalid from the skill directory.

- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`
  - Same broken relative link pattern as the Claude Code skill.

#### Docs tooling/tests

Affected files:

- `web/lib/content.ts` and `web/package.json` for heading slug support.
- `web/__tests__/content.test.ts` for rendered anchor assertions.
- `packages/docs-gen/src/generators/config.ts` for richer config reference output.
- `packages/docs-gen/src/generators/llms.ts`, `packages/docs-gen/src/output-paths.ts`, and `packages/docs-gen/src/manifest.ts` for raw mirror/LLM index completeness.
- `packages/docs-gen/src/check.ts` and/or docs-gen tests for link/anchor checking integrated with `pnpm docs:check`.

No runtime user docs outside the docs site and skill docs need intentional prose changes unless the link checker discovers additional broken internal targets.

## Acceptance Criteria

1. **Rendered heading anchors work**
   - Rendered docs/reference headings include stable `id` attributes.
   - The `/docs/extensions` link to `#relationship-to-shell-hooks-playbooks-and-toolbelts` navigates to an existing rendered heading anchor.
   - Tests assert representative heading IDs for docs and generated reference pages.

2. **Known broken config-reference links are fixed**
   - `/reference/config#toolbelts` resolves to a real, useful Toolbelts section.
   - `/reference/config#hooks` resolves to a real, useful Hooks section.
   - The Toolbelts section documents `tools.toolbelts`, tier `toolbelt`, `toolbelt: none`, default behavior, MCP-server filtering boundaries, and validation semantics at least at the level currently promised by `/docs/configuration`.

3. **Automated link/anchor checking exists and is enforced**
   - `pnpm docs:check`, or tests run by it, fails when an internal docs link points to a missing page/file or missing fragment anchor.
   - The checker covers:
     - `web/content/docs`
     - `web/content/reference`
     - `web/public/docs`
     - `web/public/reference`
     - selected repo docs linked from public docs
     - eforge skill docs
   - The checker ignores external `http(s)` URLs or treats them separately without adding network dependency.
   - The checker handles both rendered routes, such as `/docs/foo` and `/reference/bar`, and raw Markdown artifacts, such as `/docs/foo.md` and `/reference/bar.md`.

4. **Raw public docs mirror is complete**
   - Every public doc page in `DOCS_NAV` has a corresponding raw `web/public/docs/<slug>.md` mirror, including `extensions.md` and `extensions-api.md`.
   - `llms.txt` links include the extensions guide and extensions API reference, or otherwise make them discoverable in a deliberate section.

5. **Skill doc links are valid**
   - The profile-new skill docs in both Claude Code and Pi packages no longer contain broken relative links.
   - Link checker covers these skill docs so the issue cannot regress silently.

6. **Docs source/generation remains deterministic**
   - `pnpm docs:generate` updates all generated artifacts deterministically.
   - `pnpm docs:check` passes after generation.
   - Existing docs-gen determinism tests continue to pass.

7. **No runtime behavior changes**
   - Engine config semantics, toolbelt runtime behavior, extension runtime behavior, CLI behavior, and MCP tools remain unchanged except for generated/reference documentation and tests.
