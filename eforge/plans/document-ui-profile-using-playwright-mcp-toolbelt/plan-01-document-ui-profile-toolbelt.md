---
id: plan-01-document-ui-profile-toolbelt
name: Document UI Profile Toolbelt (Playwright canonical example)
branch: document-ui-profile-using-playwright-mcp-toolbelt/plan-01-document-ui-profile-toolbelt
---

# Document UI Profile Toolbelt (Playwright canonical example)

## Architecture Context

Profile toolbelts are already fully implemented and observable: the `tools.toolbelts` registry and per-tier `toolbelt` field are schema-valid, statically validated by `packages/engine/src/config.ts`, and runtime-enforced. The roadmap (`docs/roadmap.md`) records the canonical Playwright UI profile example (TOOLBELTS_06) as deferred, and the design doc `docs/prd/profile-toolbelts.md` already contains the canonical YAML for `tools.toolbelts.browser-ui`, the `ui` profile, and the matching `.mcp.json` entry.

This plan is documentation-only. No engine, config schema, or runtime behavior changes. The goal is to publish the canonical example in user-facing docs and keep the two consumer-facing profile-new skill docs (Pi and Claude Code plugin) synchronized so users encountering the profile-creation flow learn when to reach for an MCP-backed toolbelt profile.

Key existing-code constraints the builder must respect:

- `docs/config.md` already documents toolbelts under MCP Servers > Toolbelts (lines ~371-446). Builder must extend - not duplicate - that section. Existing content: name rules, tier field semantics, runtime semantics table, agent:start observability fields. Missing: explicit Pi-extension / Claude-plugin out-of-scope note and the toolbelts-vs-extensions relationship note.
- `web/content/docs/configuration.md` is the human-authored public docs page. It currently has no Toolbelts section. `web/content/reference/config.md` is generated and must not be edited by hand.
- `scripts/check-skill-parity.mjs` enforces that `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` and `eforge-plugin/skills/profile-new/profile-new.md` match after normalization. Tool-reference normalization aligns `mcp__eforge__eforge_<x>` <-> `eforge_<x>`, and the leading Pi `> **Note:** In Pi, ...` paragraph is stripped on the Pi side only. Any genuine platform-specific divergence must be wrapped in `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` markers, and a skip block on each side must describe only that platform. Builder must keep the new guidance identical on both sides (post-normalization).
- The Pi `eforge_profile` tool and the plugin `mcp__eforge__eforge_profile` tool currently accept the toolbelt registry under `tools.toolbelts` in the profile YAML body; profiles can themselves declare a `tools.toolbelts` map (see `docs/config.md` Toolbelts section, which states toolbelts can be defined in `eforge/config.yaml` or a profile). The skill guidance should reflect this: define the `browser-ui` toolbelt in `eforge/config.yaml` (canonical), and have the profile reference it on tiers. Do not add new flags to the skill tool payload - the existing `agents.tiers.*.toolbelt` field is already supported by the daemon.

## Implementation

### Overview

Add a canonical UI-profile + Playwright MCP-toolbelt example to user-facing docs, extend the repo docs with the missing relationship/out-of-scope notes, and add aligned guidance to both profile-new skills about when to use MCP-backed profile toolbelts. Bump the Claude Code plugin patch version because plugin skill content changes.

### Key Decisions

1. **Public docs section sits under MCP-adjacent content, not Agent Runtime Profiles.** Place the new section in `web/content/docs/configuration.md` after the existing `## Agent Runtime Profiles` block (after line ~99) and before `## Post-Merge Commands`. Naming: `## Profile Toolbelts for UI Work`. Rationale: a reader who just learned what a profile is will hit toolbelts immediately, and the section logically chains profile -> tier -> toolbelt -> MCP servers.
2. **Use the design doc's existing YAML verbatim as the canonical example.** The `tools.toolbelts.browser-ui`, `eforge/profiles/ui.yaml`, and `.mcp.json` shapes in `docs/prd/profile-toolbelts.md` lines 38-97 are the source of truth. The new public docs section must reproduce these (no field renames, no removed comments) so the public docs and design doc stay aligned.
3. **Public docs section uses the flat tier-recipe YAML shape, not the legacy nested `model: { id }` shape.** `web/content/docs/configuration.md` already uses the flat shape (`model: claude-opus-4-7`) at line 32-51. The `ui.yaml` example here must match that flat shape.
4. **`docs/config.md` Toolbelts subsection gains a new paragraph at the end of the `### Toolbelts` block** covering (a) the MVP constraint that toolbelts apply only to project MCP servers from `.mcp.json` and not to Pi extensions / Claude Code plugins / engine-internal / harness built-in tools, and (b) the toolbelts-vs-extensions relationship note (declarative MCP bundles vs imperative lifecycle behavior; extensions may inspect metadata but should not redefine toolbelts). The runtime-semantics table and observability fields stay where they are.
5. **Profile-new skill guidance is a new step or note, not a replacement of any existing step.** Add it as a short subsection after Step 5 (Offer to activate) titled `## When to use an MCP-backed toolbelt profile`, with a brief description of UI-heavy / frontend / browser-validation use cases, a pointer to the `browser-ui` + Playwright pattern, and a reminder that toolbelts live in `eforge/config.yaml` while profiles only reference the toolbelt name. Wording on Pi and plugin sides must be identical after normalization (no platform-specific paragraphs needed - both sides reference the documentation pages).
6. **Plugin version bump uses semver patch.** Current `eforge-plugin/.claude-plugin/plugin.json` is at `0.25.0`. Bump to `0.25.1` because the change is additive doc/skill text only - no behavior change.
7. **No edits to generated artifacts.** Do not edit `web/content/reference/config.md`, `web/public/reference/*`, or any schema/generated YAML. If drift surfaces, `pnpm docs:check` flags it and the docs pipeline (`pnpm docs:generate`) regenerates them; the builder must not patch generated files by hand.
8. **Do not modify `docs/prd/profile-toolbelts.md`.** The PRD is historical/design documentation and the source-of-truth YAML for the canonical example. Leaving it untouched avoids accidental drift between the design doc and the public docs.

## Scope

### In Scope

- Add a new public-facing section `## Profile Toolbelts for UI Work` to `web/content/docs/configuration.md` containing: the `browser-ui` toolbelt YAML, the `ui` profile YAML, the Playwright `.mcp.json` entry, the MVP constraint list, and the toolbelts-vs-extensions relationship note.
- Extend the existing `### Toolbelts` subsection in `docs/config.md` with explicit Pi-extension / Claude-plugin out-of-scope note and the toolbelts-vs-extensions relationship note. Keep the existing runtime-semantics table, name-rule list, and observability fields in place.
- Add an identical (post-parity-normalization) `## When to use an MCP-backed toolbelt profile` section to both `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` and `eforge-plugin/skills/profile-new/profile-new.md` after the existing Step 5.
- Bump `eforge-plugin/.claude-plugin/plugin.json` `version` from `0.25.0` to `0.25.1`.

### Out of Scope

- Any runtime, config schema, validation, or observability changes (already shipped per `docs/roadmap.md` and `docs/prd/profile-toolbelts.md`).
- Pi extension or Claude plugin support for toolbelts (explicitly an MVP non-goal).
- Multiple toolbelts per tier, per-role toolbelts, composition / `extends`, automatic profile selection, or a live `eforge toolbelt doctor` command.
- Direct edits to generated docs (`web/content/reference/config.md`, `web/public/reference/*`).
- Edits to `docs/prd/profile-toolbelts.md` (design doc retained as historical artifact).
- Adding `tier`-level rename or `tools.toolbelts` schema changes.
- Edits to `packages/pi-eforge/skills/eforge-profile/SKILL.md` or `eforge-plugin/skills/profile/profile.md` (the inspect-mode profile skill). Already renders tier toolbelts; not required by this plan.
- Bumping the `@eforge-build/pi-eforge` npm package version (per project policy: versioned at publish time).

## Files

### Modify

- `web/content/docs/configuration.md` - insert new section `## Profile Toolbelts for UI Work` after the existing `## Agent Runtime Profiles` section (after line ~99, before `## Post-Merge Commands` at line ~100). Section contents:
  - One-paragraph intro: toolbelts let a tier opt into a named bundle of MCP servers from `.mcp.json`. Reference the `Toolbelts` subsection in the generated config reference for the full field list.
  - Code block 1 - `tools.toolbelts.browser-ui` registry entry (description + `mcpServers: [playwright]`) under `eforge/config.yaml`.
  - Code block 2 - `eforge/profiles/ui.yaml` showing the four tiers with `implementation` and `review` set to `toolbelt: browser-ui` and `planning` and `evaluation` set to `toolbelt: none`. Use the flat `model: <id>` shape and the same `description` / `whenToUse` / `tags` metadata as in `docs/prd/profile-toolbelts.md` lines 50-57.
  - Code block 3 - `.mcp.json` entry for `playwright` using `command: npx` and `args: ["-y", "@playwright/mcp@latest"]`.
  - Bulleted MVP constraint list: (1) toolbelts filter only project MCP servers from `.mcp.json`; (2) each tier picks at most one toolbelt via the singular `toolbelt` field; (3) `toolbelt: none` passes no project MCP servers; (4) omitted `toolbelt` keeps the all-servers default; (5) Pi extensions and Claude Code plugins are out of scope for this MVP; (6) toolbelts are declarative MCP bundles, extensions are imperative lifecycle behavior - extensions may inspect toolbelt/profile metadata but do not redefine toolbelts.
  - Closing pointer: link to the `Toolbelts` subsection in `/reference/config` and to `docs/prd/profile-toolbelts.md` (or its rendered equivalent) for the design rationale.

- `docs/config.md` - extend the existing `### Toolbelts` subsection (line ~376 onward). After the `agent:start` observability table (around line ~446) and before the next `## Plugins` section (line ~448), add a new short paragraph block:
  - Sentence 1: "Toolbelts apply only to project MCP servers from `.mcp.json`. They do not filter Pi extensions, Claude Code plugins, engine-internal custom tools (such as `eforge_engine`), harness built-ins, or extension-contributed tools."
  - Sentence 2: "Pi extensions and Claude Code plugins are out of scope for the profile-toolbelts MVP - toolbelts are MCP-only and declarative."
  - Sentence 3 (relationship-to-extensions note): "Toolbelts and TypeScript extensions are complementary. Toolbelts answer 'Which project MCP servers should this tier expose?' Extensions answer 'What should eforge do when something happens?' Extensions may inspect toolbelt and profile metadata when making routing decisions, but extensions should not redefine toolbelts or act as a hidden profile/config layer."
  Keep the runtime-semantics table, the name-rule list, and the observability fields exactly as they are.

- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` - append a new section `## When to use an MCP-backed toolbelt profile` after the Step 5 `Offer to activate` block and before `## Error Handling` (around line ~149). Content:
  - One sentence: "When a profile is aimed at UI-heavy / frontend / layout / screenshot / browser-validation work, point users at the MCP-backed toolbelt pattern instead of plain tier reassignment."
  - The canonical pattern: define a `browser-ui` toolbelt under `tools.toolbelts` in `eforge/config.yaml` referencing the `playwright` MCP server (configured in `.mcp.json` with `npx -y @playwright/mcp@latest`), and assign `toolbelt: browser-ui` to the tiers that need browser automation (typically `implementation` and `review`). Use `toolbelt: none` for tiers that should not receive project MCP servers (typically `planning`, `evaluation`).
  - Cross-references: link to `web/content/docs/configuration.md#profile-toolbelts-for-ui-work` (public docs) and `docs/config.md#toolbelts` (repo docs) for full configuration details. Mention that MCP server *commands* live in `.mcp.json` and profiles reference only server *names* via toolbelts.
  - Brief constraint reminders: one toolbelt per tier (MVP), Pi extensions are out of scope, and backend-visible MCP tool names (`mcp_playwright_browser_navigate`, `mcp__playwright__browser_navigate`) should never appear in profile YAML.
  - Wording must be platform-neutral so the same paragraphs land in the plugin skill without parity-skip markers. Refer to MCP servers and toolbelts by config keys only, not by tool-reference syntax.

- `eforge-plugin/skills/profile-new/profile-new.md` - append the same `## When to use an MCP-backed toolbelt profile` section in the same location (after Step 5, before `## Error Handling`, around line ~146). Content must match the Pi skill verbatim except for tool-reference syntax that the parity script normalizes (`eforge_profile` <-> `mcp__eforge__eforge_profile`, `eforge_models` <-> `mcp__eforge__eforge_models`). The new section's prose does not call any tools, so no normalization should be needed - keep the two new sections byte-identical apart from any normalization the script already handles for the rest of the file.

- `eforge-plugin/.claude-plugin/plugin.json` - bump `version` from `0.25.0` to `0.25.1`. No other fields change.

### Create

None.

## Database Migration

Not applicable - documentation-only change.

## Verification

- [ ] `web/content/docs/configuration.md` contains a section whose heading is exactly `## Profile Toolbelts for UI Work` placed between `## Agent Runtime Profiles` and `## Post-Merge Commands`.
- [ ] That new section contains a YAML code block defining `tools.toolbelts.browser-ui` with `mcpServers: [playwright]`.
- [ ] That new section contains a YAML code block named or labeled `eforge/profiles/ui.yaml` whose `agents.tiers` block has exactly one `toolbelt` value per shown tier (`browser-ui` for `implementation` and `review`, `none` for `planning` and `evaluation`).
- [ ] That new section contains a JSON code block for `.mcp.json` whose `mcpServers.playwright.command` is `npx` and whose `args` array is `["-y", "@playwright/mcp@latest"]`.
- [ ] That new section contains six explicit bullets covering, in order: project-MCP-only filtering, one toolbelt per tier, `toolbelt: none` semantics, omitted-toolbelt default, Pi-extension/Claude-plugin out-of-scope, toolbelts-vs-extensions relationship.
- [ ] `docs/config.md` `### Toolbelts` subsection contains explicit sentences stating (1) toolbelts apply only to project MCP servers from `.mcp.json` and do not filter Pi extensions, Claude Code plugins, engine-internal tools, harness built-ins, or extension-contributed tools, (2) Pi extensions and Claude Code plugins are out of scope for the profile-toolbelts MVP, (3) the toolbelts-vs-extensions relationship as described in `docs/prd/profile-toolbelts.md`.
- [ ] `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` contains a new `## When to use an MCP-backed toolbelt profile` section placed between Step 5 and `## Error Handling`.
- [ ] `eforge-plugin/skills/profile-new/profile-new.md` contains the same new section in the same relative position.
- [ ] `node scripts/check-skill-parity.mjs` exits with status 0.
- [ ] `pnpm test` exits with status 0 (includes parity check + vitest).
- [ ] `pnpm docs:check` exits with status 0.
- [ ] `pnpm type-check` exits with status 0.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field equals the string `0.25.1`.
- [ ] No file under `web/content/reference/` or `web/public/reference/` is modified.
- [ ] `docs/prd/profile-toolbelts.md` is not modified.
- [ ] `packages/pi-eforge/package.json` `version` field is not changed by this plan.
