---
id: plan-01-docs-sync
name: Sync Public Documentation with Current Implementation
branch: keep-public-documentation-synchronized-with-the-current-implementation/docs-sync
agents:
  builder:
    effort: high
    rationale: Cross-doc consistency requires careful reading of the current schema
      and CLI source. Several edits are subtle (thinking boolean vs object, role
      overrides without model, removing a Profiles section that documents a
      non-existent feature). Standard effort risks reintroducing drift.
  reviewer:
    effort: high
    rationale: Reviewer must verify each edit against the actual code (config.ts
      schema, cli.ts flags, server.ts routes) rather than rubber-stamping prose
      changes.
---

# Sync Public Documentation with Current Implementation

## Architecture Context

eforge is a pnpm workspace with packages under `packages/` (`engine`, `eforge`, `monitor`, `monitor-ui`, `client`, `pi-eforge`) and the Claude Code plugin under `eforge-plugin/`. Public documentation lives at the repo root (`README.md`), in `docs/`, and in two package READMEs (`packages/client/README.md`, `packages/pi-eforge/README.md`).

A codebase audit identified drift between several docs and the current implementation. The source of truth is the code itself:

- **Config schema**: `packages/engine/src/config.ts` exports `eforgeConfigSchema` (built from `tierConfigSchema`, `roleOverrideSchema`, `piConfigSchema`, etc.). `tierConfigSchema.thinking` is `z.boolean()`, no `maxBudgetUsd` exists on tiers, and `roleOverrideSchema` does not include a `model` field.
- **No `profiles:` config block**: `eforgeConfigBaseSchema` has no `profiles` key. Workflow profile selection (errand/excursion/expedition) is performed by the planner, not by user-defined config profiles. There is no `--profiles` CLI flag.
- **Daemon**: `/api/health` returns `{ status, pid }` (per `packages/monitor/src/server.ts`).
- **Workspace package names**: confirmed `@eforge-build/*` scope across packages.
- **Workflow policy**: `AGENTS.md` says "Delete PRDs after implementation - `docs/` should reflect current state and planned work only." The gap-close PRD has shipped.
- **Out of scope**: `CHANGELOG.md` is owned by the release flow per project memory; do not edit it here even though duplicate entries exist.

This plan aligns the docs to the code rather than the other way around — the source PRD says "Do not change implementation code unless required to verify documentation accuracy."

## Implementation

### Overview

Make targeted edits across five public docs and delete one stale PRD file. Every edit must be verifiable against a specific code reference. No content invented; no marketing copy added; no speculative future behavior introduced.

### Key Decisions

1. **Strip per-role `model:` examples from `docs/config.md` and `docs/config-migration.md`.** `roleOverrideSchema` (config.ts:213-222) has no `model` field, so documented examples would fail validation. Source explicitly forbids changing implementation code. The fix is doc-side: remove the examples and replace with `tier:` reassignment guidance, which IS supported.
2. **Rewrite, do not delete, the Profiles section in `docs/config.md`.** Replace the misleading "user-defined profiles in config.yaml" content with a one-paragraph explanation that workflow profile selection is performed automatically by the planner (errand/excursion/expedition). Cross-link to `docs/architecture.md` where the planner pipeline is described.
3. **Delete `docs/prd/prd-gap-close-v2.md` and the empty `docs/prd/` directory.** Gap-close shipped (see `docs/architecture.md` references) and AGENTS.md policy says to delete shipped PRDs.
4. **Do not edit `CHANGELOG.md`.** Release flow owns it (project memory).
5. **Do not edit `AGENTS.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/hooks.md`, `packages/client/README.md`, `packages/pi-eforge/README.md`.** Audit confirmed these are accurate.

## Scope

### In Scope

- Edit `README.md` profile YAML examples to use string `model:` form
- Rewrite `docs/config.md` sections that misdescribe schema (thinking shape, tier `maxBudgetUsd`, per-role override field list, Pi-only fields wording, Backend Profile scope subsection placement) and replace the Profiles section with planner-based explanation
- Edit `docs/config-migration.md` to remove per-role `model:` override examples and fix any thinking shape references; ensure migration patterns map to current schema only
- Tighten `docs/roadmap.md` line about `/eforge:update-docs` skill
- Delete `docs/prd/prd-gap-close-v2.md`; remove the `docs/prd/` directory if empty afterward

### Out of Scope

- `CHANGELOG.md` edits (release flow owns it)
- Code/schema changes to add a `model:` field to `roleOverrideSchema` (PRD forbids implementation changes)
- Adding new tutorials, marketing copy, or speculative content
- Editing internal prompts (`packages/engine/src/prompts/*.md`), plugin skills (`eforge-plugin/skills/`, `packages/pi-eforge/skills/`), or in-repo plan files (`eforge/plans/`)
- Wholesale rewrites of accurate files
- Documenting internal implementation details that are not user-facing

## Files

### Modify

- `README.md` — In the profile YAML example block (around lines 125-150), replace each `model:\n    id: <name>` object form with a plain string `model: <name>`. Verify against `tierConfigSchema.model: z.string()` (`packages/engine/src/config.ts:179`). Also confirm the surrounding `harness:` and `pi.provider:` example shape matches `tierConfigSchema`.

- `docs/config.md` — Multiple targeted edits:
  1. Tier `thinking:` example (around lines 122-125): replace the object form `thinking: { type: adaptive, budgetTokens: ... }` with a boolean `thinking: true`. Source: `tierConfigSchema.thinking: z.boolean().optional()` (config.ts:181). Drop any `thinkingLevel: xhigh` line from the tier block (this enum lives only inside `piConfigSchema`).
  2. Remove `maxBudgetUsd` from the tier example (around line 126). Source: not present in `tierConfigSchema` (config.ts:175-207).
  3. "Available per-role override fields" list (around line 290): remove `model` and `maxBudgetUsd`. Final supported list per `roleOverrideSchema` (config.ts:213-222): `tier`, `effort`, `thinking` (boolean), `maxTurns`, `allowedTools`, `disallowedTools`, `promptAppend`, `shards` (builder only).
  4. "Profiles" section (around lines 292-306): replace with a short subsection titled "Workflow profile selection" explaining that profiles (errand, excursion, expedition) are selected by the planner via the `planning:pipeline` event — not declared in `eforge/config.yaml`. Remove the `--profiles` CLI flag reference. Cross-link to `docs/architecture.md`.
  5. "ignored unless harness: pi" wording (lines 40 and 130): change to "rejected unless harness: pi" (or equivalent) since `tierConfigSchema.superRefine` (config.ts:187-207) returns a validation error rather than silently ignoring the field.
  6. "Backend Profile / Scope Parameter" subsection (around lines 326-337): either move it out of `docs/config.md` into a clearly-labeled MCP tool section, or annotate at the top of the subsection that `scope` is an MCP/Pi tool parameter, not a `config.yaml` field. Pick the lighter edit (annotation) unless content reorganization is necessary.

- `docs/config-migration.md` — Pattern 3 "After" block (around lines 197-205): remove per-role `model:` override examples (e.g. `formatter: model: claude-haiku-4-5`). Replace with a `tier:` reassignment example (e.g. assign the role to a `tier-haiku` tier defined in `agents.tiers`). Source: `roleOverrideSchema` (config.ts:213-222) has no `model` field. Audit any other migration patterns and remove or correct anything that references per-role `model` overrides or object-shaped `thinking`. Keep `tier:`, `effort:`, `thinking: <boolean>`, `maxTurns:`, etc.

- `docs/roadmap.md` — Tighten the "Plugin skill coverage" line (around line 29). The repo already has `/eforge-plugin-update-docs` as a project-local skill (per `CLAUDE.md`), so the example should either be removed or rewritten as "promote project-local update-docs skill to plugin". Per project memory, roadmap is future-only.

### Delete

- `docs/prd/prd-gap-close-v2.md` — gap-close has shipped. Reference: AGENTS.md says "Delete PRDs after implementation". Use `git rm` so the deletion is staged.
- `docs/prd/` directory — remove if it has no remaining files after the PRD deletion.

## Verification

- [ ] `README.md` profile YAML example uses `model: <string>` form on every tier (no `model: { id: ... }` object form anywhere in the file)
- [ ] `docs/config.md` tier example shows `thinking: true` (boolean), with no `thinking.type`/`budgetTokens` object form on a tier
- [ ] `docs/config.md` does not reference `maxBudgetUsd` on tiers or per-role overrides
- [ ] `docs/config.md` per-role override field list matches exactly: `tier`, `effort`, `thinking`, `maxTurns`, `allowedTools`, `disallowedTools`, `promptAppend`, `shards`
- [ ] `docs/config.md` does not document a `profiles:` config field or a `--profiles` CLI flag; the workflow profile selection subsection states the planner makes the selection
- [ ] `docs/config.md` describes Pi-only fields as "rejected unless harness: pi" rather than "ignored unless"
- [ ] `docs/config.md` Backend Profile scope subsection is either moved out of config.md or annotated as an MCP tool parameter (not a config.yaml field)
- [ ] `docs/config-migration.md` contains no `model:` lines under per-role overrides; per-role examples use `tier:` reassignment instead
- [ ] `docs/roadmap.md` line about `/eforge:update-docs` is either removed or rewritten to acknowledge the existing project-local skill
- [ ] `docs/prd/prd-gap-close-v2.md` no longer exists in the working tree (`git ls-files docs/prd/` returns nothing or only files unrelated to gap-close)
- [ ] `docs/prd/` directory is removed if empty
- [ ] `pnpm type-check` exits with status 0 (no accidental code edits crept in)
- [ ] `pnpm build` exits with status 0
- [ ] `pnpm test` exits with status 0
- [ ] `git diff --stat` shows changes only under `README.md`, `docs/`, and no edits to `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `docs/architecture.md`, `docs/hooks.md`, `packages/client/README.md`, or `packages/pi-eforge/README.md`
