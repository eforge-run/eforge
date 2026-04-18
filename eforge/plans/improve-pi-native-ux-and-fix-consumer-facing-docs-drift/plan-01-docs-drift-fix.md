---
id: plan-01-docs-drift-fix
name: Fix consumer-facing docs and skills enum drift
depends_on: []
branch: improve-pi-native-ux-and-fix-consumer-facing-docs-drift/docs-drift-fix
---

# Fix consumer-facing docs and skills enum drift

## Architecture Context

The engine's source-of-truth schemas in `packages/engine/src/config.ts` define:
- `piThinkingLevelSchema`: `'off' | 'low' | 'medium' | 'high' | 'xhigh'`
- `effortLevelSchema`: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`

Multiple consumer-facing docs and skill files document stale subsets of these enums. The `test/config.test.ts` file correctly asserts all values, confirming the schema is intentional. This plan fixes the drift and adds wiring tests to prevent future regression.

## Implementation

### Overview

Mechanical text substitution across 5 docs/skill files to add the missing `low` and `xhigh` values for Pi thinking levels and the missing `xhigh` value for effort levels. Bump the Claude plugin version since plugin files change. Add test assertions that verify the corrected enum values appear in skill content.

### Key Decisions

1. **Pure enum value fixes only** - no wording changes, no restructuring, no fallback repositioning (that belongs in plan-02 when native commands exist).
2. **Plugin version bump from 0.5.29 to 0.5.30** because `eforge-plugin/skills/backend-new/backend-new.md` and `eforge-plugin/skills/config/config.md` are modified.
3. **Test assertions added to `test/skills-docs-wiring.test.ts`** rather than a new test file, since that file already validates skill content and plugin version.

## Scope

### In Scope
- Fix `piThinkingLevel` values from `off | medium | high` to `off | low | medium | high | xhigh` in all consumer-facing files
- Fix `effort` values from `low | medium | high | max` to `low | medium | high | xhigh | max` in all consumer-facing files
- Bump plugin version in `plugin.json`
- Add test assertions verifying corrected enum values
- Update plugin version assertion in test

### Out of Scope
- Skill restructuring or fallback repositioning (plan-02)
- Native Pi command UX (plan-02)
- Architecture docs rewording (plan-02)
- Any changes to engine schemas or runtime behavior

## Files

### Modify
- `docs/config.md` - Line 30: change effort comment from `'low', 'medium', 'high', 'max'` to `'low', 'medium', 'high', 'xhigh', 'max'`. Line 80: change thinkingLevel comment from `'off', 'medium', 'high'` to `'off', 'low', 'medium', 'high', 'xhigh'`.
- `packages/pi-eforge/skills/eforge-backend-new/SKILL.md` - Line 76: change `pi.thinkingLevel` values from `off | medium | high` to `off | low | medium | high | xhigh`. Line 77: change `agents.effort` values from `low | medium | high | max` to `low | medium | high | xhigh | max`.
- `packages/pi-eforge/skills/eforge-config/SKILL.md` - Update all occurrences of effort enum from `'low', 'medium', 'high', 'max'` (or pipe-separated equivalent) to include `xhigh`. Both in the body text description (around line 44) and the YAML comment example (line 145). Also update all occurrences of thinkingLevel enum from `'off', 'medium', 'high'` (or pipe/slash-separated) to `'off', 'low', 'medium', 'high', 'xhigh'`. Both on line 54 (body text) and line 207 (YAML comment).
- `eforge-plugin/skills/backend-new/backend-new.md` - Line 75: change `pi.thinkingLevel` values from `off | medium | high` to `off | low | medium | high | xhigh`. Line 76: change `agents.effort` values from `low | medium | high | max` to `low | medium | high | xhigh | max`.
- `eforge-plugin/skills/config/config.md` - Update all occurrences of effort enum from `'low', 'medium', 'high', 'max'` to include `xhigh`. Both in the body text and the YAML comment example (line 145). Also update all occurrences of thinkingLevel enum from `'off', 'medium', 'high'` (or pipe/slash-separated) to `'off', 'low', 'medium', 'high', 'xhigh'`. Both on line 54 (body text) and line 207 (YAML comment).
- `eforge-plugin/.claude-plugin/plugin.json` - Bump `version` from `"0.5.29"` to `"0.5.30"`.
- `test/skills-docs-wiring.test.ts` - Update the plugin version assertion from `0.5.29` to `0.5.30`. Add a new describe block with assertions that: (a) Pi `eforge-backend-new/SKILL.md` contains `xhigh` in both thinking-level and effort-level lines; (b) Plugin `backend-new/backend-new.md` contains `xhigh` in both thinking-level and effort-level lines; (c) Pi `eforge-config/SKILL.md` contains `xhigh` in both effort and thinkingLevel context; (d) Plugin `config/config.md` contains `xhigh` in both effort and thinkingLevel context; (e) `docs/config.md` contains `xhigh` for both thinkingLevel and effort; (f) Pi and plugin backend-new skills both contain `low` as a thinkingLevel option.

## Verification

- [ ] `grep -c 'xhigh' docs/config.md` returns at least 2 (one for effort, one for thinkingLevel)
- [ ] `grep -c 'xhigh' packages/pi-eforge/skills/eforge-backend-new/SKILL.md` returns at least 2
- [ ] `grep -c 'xhigh' packages/pi-eforge/skills/eforge-config/SKILL.md` returns at least 3 (effort on lines 44 and 145, thinkingLevel on lines 54 and 207)
- [ ] `grep -c 'xhigh' eforge-plugin/skills/backend-new/backend-new.md` returns at least 2
- [ ] `grep -c 'xhigh' eforge-plugin/skills/config/config.md` returns at least 3 (effort on lines 44 and 145, thinkingLevel on lines 54 and 207)
- [ ] `grep 'low' packages/pi-eforge/skills/eforge-backend-new/SKILL.md` includes `low` as a thinkingLevel value
- [ ] `jq -r .version eforge-plugin/.claude-plugin/plugin.json` outputs `0.5.30`
- [ ] `pnpm test` passes with updated assertions in `test/skills-docs-wiring.test.ts`