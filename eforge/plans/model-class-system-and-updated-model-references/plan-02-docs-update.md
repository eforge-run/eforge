---
id: plan-02-docs-update
name: Documentation - Model Class System and Updated Model References
depends_on: [plan-01-model-class-system]
branch: model-class-system-and-updated-model-references/docs-update
---

# Documentation - Model Class System and Updated Model References

## Architecture Context

Plan-01 introduces the model class system in code. This plan updates all documentation to reflect the new system and replaces outdated model name references. Three docs need updates: `docs/config.md` (primary config reference), `eforge-plugin/skills/config/config.md` (plugin skill reference), and `CLAUDE.md` (project-level architecture docs).

## Implementation

### Overview

Update `docs/config.md` with model class documentation: the `agents.models` config section, per-role `modelClass` override, resolution order explanation, and updated example YAML. Update all `claude-sonnet-4` / `claude-sonnet-4-20250514` model string references to `4-6` versions. Apply equivalent updates to the plugin config skill docs. Add model class system description to CLAUDE.md's architecture/config sections.

### Key Decisions

1. Document the resolution order prominently in `docs/config.md` since it's the key concept users need to understand - per-role model > global model > model class > backend default.
2. Keep the CLAUDE.md additions concise - add the model class concept to the existing "Configuration" section rather than creating a new top-level section.
3. Update the plugin config skill to include model class in the interview flow (step 3 "Model & thinking tuning" already covers model config - extend it to cover classes).

## Scope

### In Scope
- Update `docs/config.md`: add `agents.models` section, per-role `modelClass` examples, resolution order docs, replace all outdated model strings
- Update `eforge-plugin/skills/config/config.md`: same model string updates, add model class to config interview guidance
- Update `CLAUDE.md`: add model class system to architecture/config documentation

### Out of Scope
- Code changes (all in plan-01)
- API documentation or external docs

## Files

### Modify
- `docs/config.md` - Replace `claude-sonnet-4` with `claude-sonnet-4-6` and `claude-sonnet-4-20250514` with `claude-sonnet-4-6` in all examples. Add `models` subsection under the `agents` config example showing class-to-model mapping. Add `modelClass` to the per-role override examples. Add a "Model Resolution Order" subsection explaining the priority chain.
- `eforge-plugin/skills/config/config.md` - Replace `claude-sonnet-4` and `claude-sonnet-4-20250514` model strings with `claude-sonnet-4-6` versions. Add model class config (`agents.models`, per-role `modelClass`) to the interview flow and example config.
- `CLAUDE.md` - Add model class system description to the architecture/config sections: four classes (`max`, `balanced`, `fast`, `auto`), agent-to-class assignments, resolution order, config example.

## Verification

- [ ] Zero occurrences of `claude-sonnet-4"` or `claude-sonnet-4-20250514` in `docs/config.md` (search with `grep -c`)
- [ ] Zero occurrences of `claude-sonnet-4"` or `claude-sonnet-4-20250514` in `eforge-plugin/skills/config/config.md`
- [ ] `docs/config.md` contains the string `agents.models` and explains model class resolution
- [ ] `docs/config.md` contains the string `modelClass` in the per-role override section
- [ ] `eforge-plugin/skills/config/config.md` contains `modelClass` reference
- [ ] `CLAUDE.md` contains `ModelClass` or `model class` reference describing the system
- [ ] `CLAUDE.md` lists the four classes: `max`, `balanced`, `fast`, `auto`
