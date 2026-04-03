---
id: plan-02-docs
name: Update docs and consumer packages for model class changes
dependsOn: [plan-01-engine]
branch: right-size-default-model-classes-per-agent-role-with-graceful-fallback/docs
---

# Update docs and consumer packages for model class changes

## Architecture Context

After plan-01 removes the `auto` model class, right-sizes role defaults, and adds fallback logic, all user-facing documentation and consumer package skills must reflect these changes. The eforge plugin and Pi package maintain parallel config skill docs that reference model classes.

## Implementation

### Overview

Update four documentation files and two consumer package skill files to reflect: (a) removal of `auto`, (b) the three-tier model class system, (c) per-role default assignments, (d) fallback chain behavior and examples.

### Key Decisions

1. **Per-role defaults table in config.md** - a table listing all 23 roles with their default model class makes the system transparent and scannable.
2. **Fallback examples in config.md** - concrete examples showing fallback behavior for Pi users who only configure one model class.
3. **Roadmap entry** - add a "Model class tuning" item under "Integration & Maturity" noting that evaluators, formatter, doc-updater, and test-writer are candidates for future `balanced`/`fast` experimentation.
4. **Plugin version bump** - required since plugin skill docs change.

## Scope

### In Scope
- Rewrite "Model Classes" section of `docs/config.md` with three-tier system, per-role defaults table, fallback behavior, examples
- Remove all `auto` references from `docs/config.md`
- Add "Model class tuning" roadmap entry to `docs/roadmap.md`
- Update `eforge-plugin/skills/config/config.md` - remove `auto`, document fallback, update `modelClass` options
- Update `pi-package/skills/eforge-config/SKILL.md` - same changes as plugin
- Bump `eforge-plugin/.claude-plugin/plugin.json` version

### Out of Scope
- Engine code changes (plan-01)
- README.md changes (no model class references exist there)
- Adding new skill files or commands

## Files

### Modify
- `docs/config.md` - Rewrite the "Model Classes" section (lines ~97-154): remove `auto` from the class list, add per-role defaults table (23 roles with their default class), document the fallback chain algorithm with ascending-then-descending logic, add concrete fallback examples for Pi users, update the model resolution order to include "fallback chain" as a step within tier 4.
- `docs/roadmap.md` - Add a "Model class tuning" bullet under "Integration & Maturity" section noting that evaluators, formatter, doc-updater, and test-writer are candidates for future re-classing to `balanced` or `fast` based on usage data.
- `eforge-plugin/skills/config/config.md` - Remove `auto` from the `modelClass` options list (line ~42-46). Change model class list from `max/balanced/fast/auto` to `max/balanced/fast`. Add a note about fallback behavior: "If a role's model class has no configured model, eforge walks up to more capable tiers, then down, before erroring." Document that three roles now default to `balanced`.
- `pi-package/skills/eforge-config/SKILL.md` - Mirror the same changes as the plugin config skill. Remove `auto`, update class list, add fallback note, document balanced defaults.
- `eforge-plugin/.claude-plugin/plugin.json` - Bump version from `0.5.19` to `0.5.20`.

## Verification

- [ ] `docs/config.md` contains zero occurrences of the string `auto` in the Model Classes section
- [ ] `docs/config.md` contains a table listing all 23 agent roles with their default model class
- [ ] `docs/config.md` describes the fallback chain algorithm (ascending then descending) with at least 2 concrete examples
- [ ] `docs/roadmap.md` contains a "Model class tuning" entry mentioning evaluators, formatter, doc-updater, test-writer as future candidates
- [ ] `eforge-plugin/skills/config/config.md` lists model class options as `max`, `balanced`, `fast` (no `auto`)
- [ ] `pi-package/skills/eforge-config/SKILL.md` lists model class options as `max`, `balanced`, `fast` (no `auto`)
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is `0.5.20`
- [ ] Both consumer skill files mention fallback behavior
- [ ] Both consumer skill files note that `staleness-assessor`, `prd-validator`, and `dependency-detector` default to `balanced`
