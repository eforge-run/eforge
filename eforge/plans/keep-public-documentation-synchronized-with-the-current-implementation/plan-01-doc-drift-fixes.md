---
id: plan-01-doc-drift-fixes
name: Correct doc drift in README and docs/
branch: keep-public-documentation-synchronized-with-the-current-implementation/doc-drift-fixes
---

# Correct doc drift in README and docs/

## Architecture Context

This is a documentation-only plan. No source code changes. The codebase is the source of truth - every doc edit below was identified by reading the current implementation in `packages/engine/src/` and comparing it to the prose in `README.md`, `docs/config.md`, `docs/architecture.md`, `docs/hooks.md`, and `docs/config-migration.md`.

The scope is **strictly correctional**: remove or fix claims that no longer match the implementation, and add the small number of fields the schema actually supports but docs miss (e.g. the per-role `shards` override). Do **not** rewrite for style, do not add tutorials, do not document internal-only behavior, and do not change implementation code.

## Implementation

### Overview

Make targeted edits to three files:

1. `docs/config.md` - the largest source of drift; the per-role override field list, tier `thinking` schema shape, `maxBudgetUsd`, the inline `profiles:` config-key section, and the `thinkingLevel` placement are all wrong relative to `packages/engine/src/config.ts`.
2. `docs/architecture.md` - `test-cycle` expansion claim is wrong, and the per-role config sentence claims fields that aren't supported.
3. `README.md` - minor: harmonize the monitor-port wording with what `packages/monitor/` actually does.

`docs/hooks.md`, `docs/config-migration.md`, and `docs/roadmap.md` were inspected and require no changes for this pass (see the verification list).

### Key Decisions

1. **Codebase is source of truth.** Every edit below cites a file:line in the current source. If a fact has multiple plausible readings, prefer the schema/code over the prose.
2. **Targeted edits, not rewrites.** Use small replacements that preserve surrounding paragraphs whenever possible.
3. **Drop the `profiles:` config-key section in `docs/config.md`.** The schema explicitly rejects a top-level `profiles:` key (`packages/engine/test/config.legacy-rejection.test.ts` lines 69-80). Workflow-profile selection is now driven dynamically by the `pipeline-composer` agent (`packages/engine/src/agents/pipeline-composer.ts`), with `errand`/`excursion`/`expedition` baked into the planner agent (`packages/engine/src/agents/planner.ts` lines 228-240). The previously-documented YAML-based `profiles:` extension mechanism does not exist.
4. **Keep the migration guide as-is.** `docs/config-migration.md` documents the old to new transition and remains useful for users with legacy configs (CHANGELOG 0.7.7 made the schema strict).
5. **Don't introduce new features.** The roadmap stays untouched in this plan.

## Scope

### In Scope
- Edit `docs/config.md` to: (a) replace the boolean tier `thinking` documentation with the actual schema; (b) remove `maxBudgetUsd` from tier and per-role examples; (c) remove `model` from the per-role override field list and example; (d) add `shards` to the per-role override field list with a one-line note that it is builder-only; (e) move `thinkingLevel` under the `pi:` block in the tier example to match `piConfigSchema`; (f) delete the inline `profiles:` config-key section (and its example) and replace it with one short paragraph explaining that workflow profile selection (`errand`/`excursion`/`expedition`) is selected per-build by the `pipeline-composer` agent; (g) reword the 'Backend Profiles' section heading and prose to use the implementation term 'agent runtime profiles' consistently with `README.md`; (h) leave the role-to-tier table, tier-defaults table, config-layers prose, parallelism prose, and playbook prose unchanged (verified accurate).
- Edit `docs/architecture.md` to: (a) correct the `test-cycle` row in the build-stages table to say it expands to `test` then `evaluate` (the tester agent already runs production fixes inline; there is no `test-fix` substage - see `packages/engine/src/pipeline/stages/build-stages.ts` lines 747-764); (b) reword the per-role configuration sentence (line 175) to remove `model` and `budget` from the list of per-role tunables (since the schema doesn't allow per-role `model` or `maxBudgetUsd`); (c) reconcile the monitor port wording (line 233) with README - say the monitor prefers port 4567 and falls back to the next free port in the 4567-4667 range (`packages/monitor/src/registry.ts` constants).
- Edit `README.md` line 38 to harmonize with the corrected architecture-doc port description (preferred default 4567, dynamic fallback if taken).

### Out of Scope
- Any edits to `docs/hooks.md` (verified accurate against `packages/engine/src/hooks.ts`).
- Any edits to `docs/config-migration.md` (still useful as a legacy transition guide).
- Any edits to `docs/roadmap.md` (future-looking; not in scope for drift-fix).
- Any source code changes (e.g. don't add a `maxBudgetUsd` field or a `profiles:` config key just to satisfy old docs).
- Marketing copy, tutorials, expanded examples, or new sections.
- Wholesale rewrites of any file.
- Changes to the `docs/prd/` directory or `docs/images/`.
- Changes to `CHANGELOG.md` (release-flow-managed).

## Files

### Modify
- `docs/config.md` - Apply edits (a)-(h) above. Source-of-truth references for each edit:
  - Tier `thinking` schema is `z.boolean().optional()` - `packages/engine/src/config.ts` line 181. The currently-documented object form (`{ type: adaptive | enabled | disabled, budgetTokens }`) is wrong for `eforge/config.yaml`. Replace with: `thinking: true   # Optional: enable thinking; coerced to adaptive for adaptive-only models`.
  - Per-tier `maxBudgetUsd` does not exist in `tierConfigSchema` (`packages/engine/src/config.ts` lines 175-207). Remove the `maxBudgetUsd: 5.0` example line.
  - Per-role override schema (`packages/engine/src/config.ts` lines 213-222) supports exactly: `tier`, `effort`, `thinking` (boolean), `maxTurns`, `allowedTools`, `disallowedTools`, `promptAppend`, `shards`. The current docs list `model` and `maxBudgetUsd`; remove both. Add `shards` with: `shards    # Builder-only: parallel implementation shards (see plan frontmatter for full schema)`.
  - `thinkingLevel` (`packages/engine/src/config.ts` lines 142, 151) lives under `pi:` (`piConfigSchema.thinkingLevel`), not directly on the tier. Move the `# thinkingLevel: xhigh` comment under the `pi:` sub-block in the tier-recipe example.
  - The `profiles:` top-level key is rejected by the schema (`packages/engine/test/config.legacy-rejection.test.ts` lines 69-80). Delete the existing '## Profiles' section's `profiles:` YAML block and the prose around `extends:` / `compile:`. Replace with a 2-3 sentence paragraph noting that the planner classifies each input as `errand`, `excursion`, or `expedition` via the `pipeline-composer` agent, and that custom YAML profiles are not configurable in `eforge/config.yaml`.
  - The 'Backend Profiles' heading should become 'Agent Runtime Profiles' to match `README.md` (line 121) and `set-resolver.ts` (`SetArtifactSource = 'project-local' | 'project-team' | 'user'`). Adjust the body prose to drop the legacy 'backend profile' phrasing.
  - Update inline commented examples (lines 56-65 area) so the `agents.roles` example only uses fields actually in the role schema (`tier`, `effort`, `maxTurns`, `promptAppend`, `shards`). Drop the misleading `builder.model: claude-sonnet-4-6` and `staleness-assessor.model: claude-haiku-4-5` lines.
- `docs/architecture.md` - Apply the three edits above:
  - Line 142 `test-cycle` row: change description to `Composite: iterates test then evaluate up to maxRounds. The tester agent runs tests, debugs failures, and writes production fixes as unstaged changes inline; the evaluator then judges those fixes. There is no separate test-fix substage.` (verified against `build-stages.ts` lines 756-764).
  - Line 175 per-role configuration sentence: change to: `Per-role configuration (effort level, thinking, tool filters, maxTurns, promptAppend, and builder-only shards) is set via eforge/config.yaml under agents.roles. See [config.md](config.md). Model, harness, and provider always flow from the role's tier - they cannot be overridden per role.`
  - Line 233 monitor port: change to: `The web monitor tracks cost, token usage, and progress in real time. The default preferred port is 4567; if that port is in use, the daemon allocates the next free port in the 4567-4667 range and writes the actual port to the daemon lockfile.`
- `README.md` - Update line 38 to match: `A web monitor (default port 4567, with dynamic fallback if taken) tracks progress, cost, and token usage in real time.` Keep the rest of the README unchanged. Spot-check the install/CLI/config snippets against current behavior; the explore pass already verified these match.

## Verification

- [ ] `docs/config.md` no longer contains the string `maxBudgetUsd` outside of intentionally-deleted contexts (grep returns 0 matches).
- [ ] `docs/config.md` per-role override field list matches exactly the keys in `roleOverrideSchema` at `packages/engine/src/config.ts` lines 213-222: `tier`, `effort`, `thinking`, `maxTurns`, `allowedTools`, `disallowedTools`, `promptAppend`, `shards`.
- [ ] `docs/config.md` no longer contains a top-level `profiles:` YAML block describing custom workflow profiles with `extends:` / `compile:`.
- [ ] `docs/config.md` tier `thinking` example uses the boolean form (`thinking: true`) and not the object form.
- [ ] `docs/config.md` `thinkingLevel` example appears under the `pi:` sub-block of a tier (not at the tier's top level).
- [ ] `docs/architecture.md` line for `test-cycle` describes a `test` then `evaluate` loop with no `test-fix` substage.
- [ ] `docs/architecture.md` per-role configuration sentence does not list `model` or `budget` as per-role fields.
- [ ] `docs/architecture.md` monitor section and `README.md` monitor sentence describe the port the same way (preferred 4567, dynamic fallback).
- [ ] `docs/hooks.md` is byte-identical to its current content (no edits required this pass).
- [ ] `docs/config-migration.md` is byte-identical to its current content.
- [ ] `docs/roadmap.md` is byte-identical to its current content.
- [ ] No source files under `packages/`, `eforge-plugin/`, `scripts/`, or `test/` are modified.
- [ ] `pnpm type-check` exits 0 (sanity - should be unaffected by docs).
