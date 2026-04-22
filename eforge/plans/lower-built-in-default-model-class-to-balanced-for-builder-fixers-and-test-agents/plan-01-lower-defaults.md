---
id: plan-01-lower-defaults
name: Lower default model class to balanced for builder/fixers/test agents
depends_on: []
branch: lower-built-in-default-model-class-to-balanced-for-builder-fixers-and-test-agents/lower-defaults
---

# Lower default model class to balanced for builder/fixers/test agents

## Architecture Context

eforge assigns each agent role a built-in default `ModelClass` (`max`/`balanced`/`fast`) via the `AGENT_MODEL_CLASSES` map in `packages/engine/src/pipeline.ts`. On the `claude-sdk` backend, `max` resolves to `claude-opus-4-7` and `balanced` resolves to `claude-sonnet-4-6` (see `MODEL_CLASS_DEFAULTS`). Today every "real work" role defaults to `max`; five of those roles (`builder`, `review-fixer`, `validation-fixer`, `test-writer`, `tester`) do tightly-scoped, well-specified work that Sonnet handles well. Moving their built-in default to `balanced` reduces per-run spend without requiring per-project config, while preserving the full opt-back-in path via `agents.roles.<role>.modelClass: max` in `eforge/config.yaml`.

The resolution chain in `resolveAgentConfig` (same file) and the tier-walk fallback logic are unchanged - flipping defaults for five roles is a one-line-per-role edit. Downstream effects are limited to tests that baked in the old defaults and docs/skill prose that names the three previously-balanced roles.

Per AGENTS.md: `eforge-plugin/` (Claude Code) and `packages/pi-eforge/` (Pi) must stay in sync, and any plugin change requires a patch bump in `eforge-plugin/.claude-plugin/plugin.json`.

Per memory `feedback_changelog_managed_by_release.md`: no `CHANGELOG.md` edits here.

## Implementation

### Overview

1. Flip five entries in `AGENT_MODEL_CLASSES` from `'max'` to `'balanced'`.
2. Update `test/pipeline.test.ts` assertions that baked in the old defaults.
3. Update `docs/config.md` per-role default-class table and fallback example narrative.
4. Update the two in-sync skill files (`packages/pi-eforge/skills/eforge-config/SKILL.md` and `eforge-plugin/skills/config/config.md`) to list both balanced groups explicitly.
5. Bump the plugin patch version in `eforge-plugin/.claude-plugin/plugin.json` (currently `0.5.32` → `0.5.33`).

### Key Decisions

1. **Only flip the five named roles** - `merge-conflict-resolver` stays `max` per source scope. Planner, reviewer, evaluator, architecture/cohesion/plan reviewers and evaluators, module-planner, formatter, doc-updater, pipeline-composer, and gap-closer all stay `max`.
2. **No changes to `MODEL_CLASS_DEFAULTS`, `MODEL_CLASS_TIER`, or `resolveAgentConfig`** - `balanced` already maps to `claude-sonnet-4-6` on `claude-sdk` and the tier-walk works out-of-the-box for `pi`.
3. **No new config knobs** - users can opt back to `max` per role today via `agents.roles.<role>.modelClass: max`.
4. **Update the existing "override to balanced" test to override to `max` instead** so it still proves a non-default override path (with the new default, overriding to balanced no-ops).
5. **Rewrite the test that enumerates balanced vs max roles** - the balanced list grows from 3 to 8 (`builder`, `review-fixer`, `validation-fixer`, `test-writer`, `tester`, `staleness-assessor`, `prd-validator`, `dependency-detector`).
6. **Regenerate the pi-backend error-message regex** - `builder` now defaults to `balanced`, so the fallback walks ascending (max) then descending (fast). The error message becomes: `model class "balanced"...Tried fallback: max, fast`.

## Scope

### In Scope
- Flip `builder`, `review-fixer`, `validation-fixer`, `test-writer`, `tester` from `'max'` to `'balanced'` in `AGENT_MODEL_CLASSES`.
- Update `test/pipeline.test.ts` assertions that hard-coded the old defaults (model id, balanced-role enumeration, pi fallback error regex, and the balanced-override test).
- Update `docs/config.md` per-role table rows and the fallback example narrative.
- Update the in-sync skill docs to name all 8 balanced-default roles.
- Bump the plugin patch version (`0.5.32` → `0.5.33`).

### Out of Scope
- No changes to `MODEL_CLASS_DEFAULTS` (sonnet/opus/haiku mappings).
- No changes to `merge-conflict-resolver` (stays `max`).
- No CHANGELOG edits (release flow owns it).
- No new config knobs.
- No changes to any role's `effort`, `thinking`, or `maxTurns` defaults in `AGENT_ROLE_DEFAULTS`.

## Files

### Create
- (none)

### Modify
- `packages/engine/src/pipeline.ts` — In the `AGENT_MODEL_CLASSES` map (around lines 447-471), change these five entries from `'max'` to `'balanced'`:
  - `builder: 'balanced'`
  - `'review-fixer': 'balanced'`
  - `'validation-fixer': 'balanced'`
  - `'test-writer': 'balanced'`
  - `tester: 'balanced'`
  Leave all other 18 entries untouched.

- `test/pipeline.test.ts` — Four targeted updates. Do NOT blanket-replace `'claude-opus-4-7'` / `'max'`; only the assertions whose meaning was "builder/fixer/test-* default to max" should change:
  1. **Around line 532-545** (test: `resolveAgentConfig returns model class default for SDK fields when not configured`): builder now defaults to `balanced`. Update the comment to say builder defaults to the `balanced` class and change `expect(result.model).toEqual({ id: 'claude-opus-4-7' })` to `expect(result.model).toEqual({ id: 'claude-sonnet-4-6' })`. Leave the `effort: 'high'` expectation alone - that comes from `AGENT_ROLE_DEFAULTS`, not from the model class.
  2. **Around line 756-770** (test: `most roles default to max class, three roles default to balanced`): rename the test to reflect the new split (eight balanced, the rest max) and update `balancedRoles` to the full list `['builder', 'review-fixer', 'validation-fixer', 'test-writer', 'tester', 'staleness-assessor', 'prd-validator', 'dependency-detector']`. The loop logic (balanced → `claude-sonnet-4-6`, else `claude-opus-4-7`) stays the same.
  3. **Around line 772-785** (test: `per-role modelClass override to balanced resolves to sonnet on claude-sdk`): builder's new default is already `balanced`, so the current override is a no-op delta. Rewrite the test to override builder to `'max'` and assert `result.model` equals `{ id: 'claude-opus-4-7' }`. Rename the test to reflect that it covers `modelClass: max` over the new `balanced` default. This keeps a meaningful override-mechanism assertion.
  4. **Around line 812-817** (test: `pi backend with no model config throws for default max class with fallback tiers listed`): builder now defaults to `balanced` on pi. Update the test name and the regex to `/No model configured for role "builder".*model class "balanced".*backend "pi".*Tried fallback: max, fast/`.
  5. **Around line 848-853** (test: `fallback total failure lists attempted tiers in error`): builder's fallback list changes. Update the regex from `/Tried fallback: balanced, fast/` to `/Tried fallback: max, fast/`.
  6. **Around line 834-846** (test: `fallback descending: max role resolves to balanced model when only balanced is configured`): this test uses `builder` and asserts `result.fallbackFrom` equals `'max'`. With builder's new default of `balanced`, configuring a `balanced` model resolves directly - there is no fallback, `fallbackFrom` becomes `undefined`, and the test breaks. Replace the role in this test with one that still defaults to `max` (e.g. `reviewer` or `planner`) so the "max role falls back descending to balanced" scenario still holds.

  After editing, search the rest of `test/` for any other assertions that embed `'claude-opus-4-7'`, the string `model class "max"`, or a hard-coded `fallbackFrom` tier paired with `builder`/`review-fixer`/`validation-fixer`/`test-writer`/`tester` and fix only those whose meaning was tied to the old default. Do not touch assertions that still make sense (e.g. `per-role model overrides class-based resolution` uses `planner`, which still defaults to `max`).

- `docs/config.md` — Two changes:
  1. In the per-role default class table (around lines 118-144), change the `Default Class` column for these rows from `max` to `balanced`:
     - `builder`
     - `validation-fixer`
     - `review-fixer`
     - `test-writer`
     - `tester`
  2. Around line 110, the `max` row of the class-summary table reads "used by 20 of 23 roles". Update the count so it reflects the new split (15 of 23 roles use `max`; 8 of 23 use `balanced`). Update the `balanced` row summary in kind.
  3. Around line 195, the fallback Example 2 narrative uses `builder` as a canonical max-defaulting role. Replace that role with `reviewer` (or `planner`) so the example still illustrates a max-tier role walking descending to `balanced`. Keep the rest of the example intact.
  4. Around lines 197-213, the adjacent "downgrade some roles to cheaper models" YAML example uses `builder` with the comment `# Move builder from 'max' to 'balanced' class`. With the new default, `modelClass: balanced` for `builder` is a no-op. Replace the `builder` entry in this YAML example with a role that still defaults to `max` (e.g. `reviewer`) and update the trailing comment to match, so the example remains a meaningful demonstration of a class downgrade.

- `packages/pi-eforge/skills/eforge-config/SKILL.md` — In section 3 and section 5 (around lines 46 and 48 of the current file, both inside the numbered list), replace the sentence `Three roles (\`staleness-assessor\`, \`prd-validator\`, and \`dependency-detector\`) default to \`balanced\`; all others default to \`max\`.` with: `Eight roles (\`builder\`, \`review-fixer\`, \`validation-fixer\`, \`test-writer\`, \`tester\`, \`staleness-assessor\`, \`prd-validator\`, \`dependency-detector\`) default to \`balanced\`; all others default to \`max\`.` Update both occurrences (the note appears in the Model & thinking tuning section and in the Per-role agent overrides section).

- `eforge-plugin/skills/config/config.md` — Apply the identical wording change to both occurrences (same sentence appears in sections 3 and 5). Keep the two files in sync per AGENTS.md.

- `eforge-plugin/.claude-plugin/plugin.json` — Bump `version` from `0.5.32` to `0.5.33`.

## Verification

- [ ] `AGENT_MODEL_CLASSES` in `packages/engine/src/pipeline.ts` has exactly 8 entries set to `'balanced'`: the original three (`staleness-assessor`, `prd-validator`, `dependency-detector`) plus the five flipped here (`builder`, `review-fixer`, `validation-fixer`, `test-writer`, `tester`). All other 15 entries remain `'max'`. In particular, `merge-conflict-resolver` remains `'max'`.
- [ ] `pnpm type-check` exits with status 0.
- [ ] `pnpm test` exits with status 0.
- [ ] The test file contains an assertion that `resolveAgentConfig('builder', DEFAULT_CONFIG, 'claude-sdk').model` equals `{ id: 'claude-sonnet-4-6' }`, and an equivalent assertion resolves to `claude-sonnet-4-6` for each of `review-fixer`, `validation-fixer`, `test-writer`, `tester` (the rewritten `most roles default to max class` test covers this via its loop).
- [ ] The test file retains (or contains) an assertion that `resolveAgentConfig('reviewer', DEFAULT_CONFIG, 'claude-sdk').model` equals `{ id: 'claude-opus-4-7' }` (regression guard - covered by the rewritten role-enumeration test).
- [ ] The pi-backend no-config error test matches `/model class "balanced".*Tried fallback: max, fast/` for `builder` and passes.
- [ ] `docs/config.md` per-role default-class table shows `balanced` for all five flipped roles and `max` for `merge-conflict-resolver` and the 14 other max-default roles.
- [ ] `docs/config.md` fallback Example 2 no longer uses `builder` as the canonical max-role example; it uses `reviewer` or `planner` instead.
- [ ] `packages/pi-eforge/skills/eforge-config/SKILL.md` and `eforge-plugin/skills/config/config.md` both list all eight balanced-default roles by name (in the same order) and contain identical wording for the default-class note.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field equals `0.5.33`.
