---
id: plan-02-related-skills-tables
name: Add Related Skills tables to remaining skill files and bump plugin version
depends_on:
  - plan-01-config-found-field
branch: cross-skill-awareness-for-eforge-skills/related-skills-tables
---

# Add Related Skills tables to remaining skill files and bump plugin version

## Architecture Context

Plan-01 added Related Skills tables to the 4 build/status skill files. This plan completes the cross-skill awareness by adding the same tables to the remaining 9 skill files and bumps the plugin version.

## Implementation

### Overview

Add a Related Skills reference table to each of the remaining 9 skill files (4 Claude Code plugin + 5 Pi extension). The table lists all eforge skills with a one-line description and when to suggest each one. Bump plugin version from 0.5.23 to 0.5.24.

### Key Decisions

1. Each Related Skills table lists ALL other eforge skills (not just the ones in the same package) so the agent has full awareness regardless of which skill it's currently executing.
2. The table format uses markdown with columns: Skill, Command, When to suggest - keeping it scannable for the agent.
3. Claude Code plugin skills reference `/eforge:skillname` commands; Pi extension skills reference `eforge_skillname` tool names since Pi uses tool-based invocation.

## Scope

### In Scope
- Adding Related Skills tables to all 9 remaining skill files
- Bumping `eforge-plugin/.claude-plugin/plugin.json` version to 0.5.24

### Out of Scope
- Engine/client type changes (plan-01)
- Build/status skill configFound logic (plan-01)

## Files

### Modify
- `eforge-plugin/skills/config/config.md` - Add Related Skills table
- `eforge-plugin/skills/init/init.md` - Add Related Skills table
- `eforge-plugin/skills/restart/restart.md` - Add Related Skills table
- `eforge-plugin/skills/update/update.md` - Add Related Skills table
- `packages/pi-eforge/skills/eforge-config/SKILL.md` - Add Related Skills table
- `packages/pi-eforge/skills/eforge-init/SKILL.md` - Add Related Skills table
- `packages/pi-eforge/skills/eforge-plan/SKILL.md` - Add Related Skills table
- `packages/pi-eforge/skills/eforge-restart/SKILL.md` - Add Related Skills table
- `packages/pi-eforge/skills/eforge-update/SKILL.md` - Add Related Skills table
- `eforge-plugin/.claude-plugin/plugin.json` - Bump version from 0.5.23 to 0.5.24

## Verification

- [ ] `eforge-plugin/skills/config/config.md` contains a Related Skills table with entries for init, build, status, restart, and update
- [ ] `eforge-plugin/skills/init/init.md` contains a Related Skills table with entries for build, config, status, restart, and update
- [ ] `eforge-plugin/skills/restart/restart.md` contains a Related Skills table with entries for init, build, config, status, and update
- [ ] `eforge-plugin/skills/update/update.md` contains a Related Skills table with entries for init, build, config, status, and restart
- [ ] `packages/pi-eforge/skills/eforge-config/SKILL.md` contains a Related Skills table
- [ ] `packages/pi-eforge/skills/eforge-init/SKILL.md` contains a Related Skills table
- [ ] `packages/pi-eforge/skills/eforge-plan/SKILL.md` contains a Related Skills table
- [ ] `packages/pi-eforge/skills/eforge-restart/SKILL.md` contains a Related Skills table
- [ ] `packages/pi-eforge/skills/eforge-update/SKILL.md` contains a Related Skills table
- [ ] All 9 Related Skills tables use consistent column format (Skill, Command, When to suggest)
- [ ] Pi extension skills reference `eforge_*` tool names; Claude Code plugin skills reference `/eforge:*` commands
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version field is exactly `0.5.24`
- [ ] `pnpm type-check` passes