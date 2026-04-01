---
id: plan-01-add-roles
name: Add missing agent roles to config docs
dependsOn: []
branch: add-missing-agent-roles-to-config-docs/add-roles
---

# Add missing agent roles to config docs

## Architecture Context

The `docs/config.md` file contains a YAML example block with commented-out agent role configuration. The comment lists available roles, but is missing `prd-validator` and `dependency-detector` which are defined in `src/engine/events.ts` (AgentRole type) and `src/engine/config.ts` (AGENT_ROLES array).

## Implementation

### Overview

Add `prd-validator` and `dependency-detector` to the commented role list in the YAML config example block of `docs/config.md`.

### Key Decisions

1. Append the two missing roles to the end of the existing comment list, following the same comma-separated format on comment lines.

## Scope

### In Scope
- Adding `prd-validator` and `dependency-detector` to the commented role list in `docs/config.md` (lines 37-42)

### Out of Scope
- Any other sections of `docs/config.md`
- Any source code changes

## Files

### Modify
- `docs/config.md` - Add `prd-validator, dependency-detector` to the commented role list in the YAML example block (around line 42, extending the last comment line or adding a new one)

## Verification

- [ ] The commented role list in `docs/config.md` contains all 22 roles from `AgentRole` type in `src/engine/events.ts`: planner, builder, reviewer, review-fixer, evaluator, module-planner, plan-reviewer, plan-evaluator, architecture-reviewer, architecture-evaluator, cohesion-reviewer, cohesion-evaluator, validation-fixer, merge-conflict-resolver, staleness-assessor, formatter, doc-updater, test-writer, tester, prd-validator, dependency-detector
- [ ] No other content in `docs/config.md` is modified
- [ ] Comment formatting matches existing style (roles listed with commas across `#` comment lines)
