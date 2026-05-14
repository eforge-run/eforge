---
title: Document UI profile using Playwright MCP toolbelt
created: 2026-05-14
profile: claude-sdk-4-7
---

# Document UI profile using Playwright MCP toolbelt

## Problem / Motivation

Source epic `TOOLBELTS_06` asks for user-facing documentation that makes a UI-oriented profile backed by a Playwright MCP toolbelt the canonical MCP-backed profile toolbelt example. While the runtime implementation has shipped (toolbelt registry, runtime filtering, validation, and observability), the canonical Playwright UI profile example is deferred and public user-facing docs do not yet cover this pattern.

Evidence gathered:

- `docs/roadmap.md` lists Profile toolbelts under Extensibility and says runtime filtering/observability have shipped while the canonical Playwright UI profile example is deferred.
- `docs/prd/profile-toolbelts.md` already contains the design-level canonical example: `tools.toolbelts.browser-ui` references MCP server `playwright`, `eforge/profiles/ui.yaml` assigns `browser-ui` to implementation/review and `none` to planning/evaluation, and `.mcp.json` uses `npx -y @playwright/mcp@latest`. It also states the MVP non-goals: no Pi extension support, no Claude plugin support, no multiple toolbelts per tier, and documents the toolbelt-vs-extension relationship.
- `docs/config.md` already documents MCP servers and toolbelts in the full repository docs, including `browser-ui`, `toolbelt: none`, omitted toolbelt behavior, runtime semantics, validation, and observability.
- `web/content/docs/configuration.md` is the main public configuration guide but currently has no visible Toolbelts/Profile Toolbelts section; it only links to the generated config reference.
- `web/content/reference/config.md` is generated and intentionally minimal, so the human-authored public docs should be updated in `web/content/docs/configuration.md` rather than editing generated reference output directly.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` and `eforge-plugin/skills/profile-new/profile-new.md` are the profile creation skill docs. They currently explain metadata but do not mention the MCP-backed UI toolbelt/profile pattern. Both should stay in sync. If the Claude plugin skill is changed, `eforge-plugin/.claude-plugin/plugin.json` must have its version bumped per project policy.
- `packages/pi-eforge/skills/eforge-profile/SKILL.md` already tells inspect mode to render tier toolbelts. Profile editing guidance appears mostly in configuration docs and profile-new skills rather than a dedicated profile-edit page.
- `packages/engine/src/config.ts` validates toolbelt references against `tools.toolbelts` and `.mcp.json`; filtering is already implemented, so this is documentation-only.

Classification: this is a **docs / focused** change with high confidence. Required dimensions: `scope`, `documentation-impact`, `acceptance-criteria`, `assumptions-and-validation`.

## Goal

Publish user-facing documentation that establishes a UI-oriented profile backed by a Playwright MCP toolbelt as the canonical MCP-backed profile toolbelt example, covering the `browser-ui` toolbelt, the `ui` profile, the Playwright `.mcp.json` setup, MVP constraints, and the relationship between toolbelts and extensions/plugins, with Pi and Claude Code consumer-facing skill docs kept synchronized.

## Approach

- Treat this as a documentation-only change; no runtime/config schema changes are required because toolbelt filtering and validation already exist.
- Update public-facing user docs in `web/content/docs/configuration.md` with a new section (e.g. `## Profile Toolbelts for UI Work`) after Agent Runtime Profiles or near Agent Tiers/MCP-related configuration, containing the canonical `browser-ui` + `ui` profile + `.mcp.json` Playwright example and the MVP constraints/relationship notes.
- Verify and expand `docs/config.md` so it explicitly serves as canonical repo docs for the `browser-ui`/`ui` Playwright pattern and includes the extensions/plugins out-of-scope and relationship-to-extensions note in the same user-facing place.
- Update `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` with guidance on when to use MCP-backed profile toolbelts, with a brief pointer to UI-heavy/browser-validation profiles and the `browser-ui`/Playwright pattern.
- Mirror the Pi profile-new skill guidance in `eforge-plugin/skills/profile-new/profile-new.md` so Pi and Claude Code stay in sync. Because this touches `eforge-plugin/`, bump `eforge-plugin/.claude-plugin/plugin.json` version.
- Optionally adjust `packages/pi-eforge/skills/eforge-profile/SKILL.md` and `eforge-plugin/skills/profile/profile.md` only if wording needs a short `when to use` note; leave `docs/prd/profile-toolbelts.md` as historical/design documentation unless small wording changes improve consistency.
- Do not edit generated `web/content/reference/config.md` or `web/public/reference/*` by hand; if generated docs drift, regenerate through the docs pipeline.
- Use the `npx -y @playwright/mcp@latest` invocation from the existing design doc as the `.mcp.json` example.
- Recommended eforge profile: **Excursion**. A single cohesive planner can cover the public docs, repo docs, Pi skill docs, Claude plugin skill docs, and plugin version bump without delegated module planning. Expedition is unnecessary because there are no independently planned subsystems or runtime architecture changes.

### Assumptions and Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| This is documentation-only; no runtime behavior needs implementation. | `docs/roadmap.md` says toolbelt registry, runtime enforcement, and observability have shipped; `packages/engine/src/config.ts` contains static validation for tier toolbelt references and `.mcp.json` server names; the epic asks specifically to document the UI profile pattern. | high | low | Run `pnpm test`/`pnpm type-check` if edits unexpectedly touch code. | Medium: build plan would be under-scoped if runtime gaps remain, but current evidence points to shipped implementation. |
| Public user-facing docs should be updated in `web/content/docs/configuration.md`, not generated reference files. | `web/content/reference/config.md` is marked `Generated file. Do not edit.` while `web/content/docs/configuration.md` is human-authored and currently lacks toolbelt coverage. | high | low | Run `pnpm docs:check`; inspect generated docs diff after any docs generation. | Medium: editing generated files directly would cause drift or be overwritten. |
| `docs/config.md` remains a canonical repo doc and should be kept aligned with public docs. | It has current Toolbelts and MCP Servers sections with runtime semantics; project docs and README point to docs as user-facing material. | high | low | Search links/references after edits; run docs checks. | Low/medium: inconsistent docs could confuse users. |
| Profile creation guidance lives in both Pi and Claude Code profile-new skill docs and should stay synchronized. | Read `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` and `eforge-plugin/skills/profile-new/profile-new.md`; AGENTS requires `packages/pi-eforge/` and `eforge-plugin/` user-facing behavior/docs to stay in sync. | high | low | Diff the two skill docs around the added guidance. | Medium: one integration would lack guidance; plugin version bump could be missed. |
| The exact Playwright MCP package invocation should be `npx -y @playwright/mcp@latest`. | Existing design doc `docs/prd/profile-toolbelts.md` uses that `.mcp.json` example. | medium | low | Check Playwright MCP docs if the package name/arguments need current confirmation. | Low/medium: stale package command would make the example fail for users. |

No unresolved low-confidence/high-impact assumptions remain. The only medium-confidence item is the exact current Playwright MCP package invocation, and it has a low-cost validation path plus low/medium impact because the project design doc already uses the same command.

## Scope

### In scope

- Add or strengthen user-facing docs for the canonical MCP-backed UI profile pattern.
- Include a concrete `browser-ui` toolbelt definition under `tools.toolbelts` that references the Playwright MCP server name `playwright`.
- Include a concrete `ui` agent runtime profile example showing tier assignments that expose `browser-ui` only where browser automation is useful (typically implementation and review) and use `toolbelt: none` for tiers that should not receive project MCP servers.
- Include a `.mcp.json` Playwright MCP server example using `@playwright/mcp`.
- Explain the key constraints in user-facing language:
  - toolbelts filter only project MCP servers declared in `.mcp.json`;
  - each tier can select at most one toolbelt through a singular `toolbelt` field;
  - `toolbelt: none` explicitly passes no project MCP servers;
  - omitted `toolbelt` preserves the all-servers default;
  - Pi extensions and Claude Code plugins are out of scope for this MVP;
  - toolbelts are declarative MCP bundles while extensions/plugins are imperative integration/lifecycle behavior and may inspect metadata but should not redefine toolbelts.
- Update profile creation/editing guidance so users know to use this pattern for UI-heavy/frontend/layout/screenshot/browser-validation work rather than adding backend-visible MCP tool names or plugin/extension config.
- Keep Pi and Claude Code consumer-facing skill docs synchronized if skill documentation is changed. If any `eforge-plugin/` file changes, bump `eforge-plugin/.claude-plugin/plugin.json` version.

### Documentation Impact

Primary docs to update:

- `web/content/docs/configuration.md` — add a public-facing section such as `## Profile Toolbelts for UI Work` after Agent Runtime Profiles or near Agent Tiers/MCP-related configuration. This should contain the canonical `browser-ui` + `ui` profile + `.mcp.json` Playwright example and the MVP constraints/relationship notes.
- `docs/config.md` — already has a Toolbelts section, but should be checked/expanded so it explicitly serves as canonical repo docs for the `browser-ui`/`ui` Playwright pattern and includes the extensions/plugins out-of-scope and relationship-to-extensions note in the same user-facing place.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — add guidance in the profile creation docs for when to use MCP-backed profile toolbelts, with a brief pointer to UI-heavy/browser-validation profiles and the `browser-ui`/Playwright pattern.
- `eforge-plugin/skills/profile-new/profile-new.md` — mirror the Pi profile-new skill guidance so Pi and Claude Code stay in sync. Because this touches `eforge-plugin/`, bump `eforge-plugin/.claude-plugin/plugin.json` version.

Secondary docs to consider only if needed:

- `packages/pi-eforge/skills/eforge-profile/SKILL.md` and `eforge-plugin/skills/profile/profile.md` — already render/describe tier toolbelts in inspect mode; update only if the wording needs a short `when to use` note.
- `docs/prd/profile-toolbelts.md` — design doc already contains the example and relationship note. Leave as historical/design documentation unless small wording changes improve consistency with current docs.
- Generated references (`web/content/reference/config.md`, `web/public/reference/*`, schemas) should not be edited directly. Run docs generation/check if source docs or generated artifacts require refresh.

### Out of scope

- No runtime/config schema changes; implementation evidence shows toolbelt filtering and validation already exist.
- No new Pi extension support or Claude plugin support for toolbelts.
- No multiple toolbelts per tier, per-role toolbelts, composition/extends, automatic profile selection, or live MCP doctor command.
- Do not edit generated `web/content/reference/config.md` or `web/public/reference/*` by hand. If generated docs drift after source changes, regenerate through the docs pipeline.

## Acceptance Criteria

- `web/content/docs/configuration.md` includes a canonical UI/profile-toolbelt example with:
  - `tools.toolbelts.browser-ui`;
  - `mcpServers: [playwright]` or equivalent YAML list form;
  - `.mcp.json` server entry for Playwright MCP, e.g. `npx -y @playwright/mcp@latest`;
  - `eforge/profiles/ui.yaml` or equivalent profile example named `ui`.
- `docs/config.md` contains or links to the same canonical pattern and explicitly documents the relevant rules in the user-facing Toolbelts/Profile section.
- The example profile assigns exactly one `toolbelt` value per shown tier and does not imply multiple toolbelts, per-role toolbelts, or backend-visible MCP tool names.
- The docs explicitly state that toolbelts apply only to project MCP servers from `.mcp.json`; they do not include Pi extensions, Claude plugins, engine-internal tools, harness built-ins, or extension-contributed tools.
- The docs explicitly state the one-toolbelt-per-tier MVP rule.
- Profile creation/editing documentation tells users to use this pattern for UI-heavy/frontend/layout/browser-validation work and to define MCP server commands in `.mcp.json` while profiles reference server names via toolbelts.
- The docs clarify that Pi extensions and Claude Code plugins are out of scope for the profile toolbelts MVP.
- The docs include a short relationship-to-extensions note: toolbelts are declarative MCP bundles; extensions are imperative lifecycle behavior; extensions may inspect toolbelt/profile metadata but do not redefine toolbelts.
- Pi and Claude Code consumer-facing documentation stays synchronized for profile creation guidance. If `eforge-plugin/` changes, `eforge-plugin/.claude-plugin/plugin.json` version is bumped.
- Validation passes with the normal doc/code checks appropriate for docs-only changes, at minimum `pnpm docs:check` if generated docs can drift, and preferably `pnpm type-check` if any TypeScript-adjacent docs generation or plugin metadata changes are touched.
