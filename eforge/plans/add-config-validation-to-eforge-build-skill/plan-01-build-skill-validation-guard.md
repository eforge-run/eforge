---
id: plan-01-build-skill-validation-guard
name: Add config validation guard to build skill
depends_on: []
branch: add-config-validation-to-eforge-build-skill/build-skill-validation-guard
---

# Add config validation guard to build skill

## Architecture Context

The `/eforge:build` skill (`eforge-plugin/skills/build/build.md`) enqueues PRDs for the daemon to build but never validates `eforge/config.yaml` first. The `eforge_config` MCP tool already supports `{ action: "validate" }` returning `{ valid: boolean, errors: string[] }`. This plan adds a guard clause so config errors are caught before enqueueing.

## Implementation

### Overview

Two edits to `eforge-plugin/skills/build/build.md`:

1. **Validation guard at top of Step 5** - Before the `mcp__eforge__eforge_build` call, call `mcp__eforge__eforge_config` with `{ action: "validate" }`. If `valid` is `false`, display the errors, suggest `/eforge:config` to fix, and stop without enqueueing. If `valid` is `true`, proceed silently.

2. **Error Handling table row** - Add a new row: `Config validation fails | Show errors, suggest fixing config, do not enqueue`.

### Key Decisions

1. The guard goes at the top of Step 5 (not as a new step) to avoid renumbering steps and breaking forward references in Steps 1-4.
2. On failure, the skill suggests `/eforge:config` as the remediation path since that skill handles config editing.

## Scope

### In Scope
- Validation guard clause in Step 5 of `build.md`
- New Error Handling table row for config validation failure

### Out of Scope
- Changes to the `eforge_config` MCP tool itself
- Changes to Steps 1-4 or their forward references
- Any code changes outside the skill markdown file

## Files

### Modify
- `eforge-plugin/skills/build/build.md` - Insert validation guard at top of Step 5 before the enqueue call; add error table row for config validation failure

## Verification

- [ ] Step 5 begins with a call to `mcp__eforge__eforge_config` with `{ action: "validate" }` before the `mcp__eforge__eforge_build` call
- [ ] When validation returns `valid: false`, the skill displays errors and stops without calling `mcp__eforge__eforge_build`
- [ ] When validation returns `valid: true`, the skill proceeds to the `mcp__eforge__eforge_build` call with no user-visible output from validation
- [ ] Steps 1-4 text and forward references are unchanged
- [ ] The Error Handling table contains a row with `Config validation fails` and action `Show errors, suggest fixing config, do not enqueue`
