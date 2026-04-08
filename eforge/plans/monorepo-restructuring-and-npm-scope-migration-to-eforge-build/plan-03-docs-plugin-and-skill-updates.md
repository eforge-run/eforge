---
id: plan-03-docs-plugin-and-skill-updates
name: Documentation, Plugin, and Skill Updates
depends_on: [plan-02-import-rewrites-build-pipeline-and-publish-scripts]
branch: monorepo-restructuring-and-npm-scope-migration-to-eforge-build/docs-plugin-and-skill-updates
---

# Documentation, Plugin, and Skill Updates

## Architecture Context

With the monorepo restructured and building (plan-01 + plan-02), this plan updates all documentation, eforge-plugin files, and Pi extension skill files to reflect the new package names, directory paths, and npm scope. These are mechanical substitutions following the rules defined in the PRD's "Documentation updates" section. No code changes - only prose, config, and skill markdown files.

The PRD defines precise substitution rules (S1-S5, P1-P5) and an explicit "DO NOT substitute" list. This plan follows both strictly.

## Implementation

### Overview

Apply the PRD's substitution rules across ~13 files, ~58 edits:
- **S1**: `eforge` (npm package) -> `@eforge-build/eforge`
- **S2**: `eforge-pi` (npm package) -> `@eforge-build/eforge-pi`
- **S3**: `npx -y eforge` -> `npx -y @eforge-build/eforge`
- **S4**: `npm install -g eforge`, `npm view eforge version` -> same with `@eforge-build/eforge`
- **S5**: `pi install npm:eforge-pi` -> same with `@eforge-build/eforge-pi`
- **P1-P5**: Directory path updates (`src/engine/` -> `packages/engine/src/`, etc.)

**What stays unchanged**: bin name `eforge`, slash commands, MCP tool names, plugin marketplace identity, config paths, env vars, brand prose, `@eforge-build/client`, `eforge-plugin/` directory path, test fixtures.

### Key Decisions

1. **`eforge-plugin/.claude-plugin/plugin.json` name stays `"eforge"`** - marketplace identity, not npm identity. Version bumps to `0.5.21`.
2. **`eforge-plugin/.mcp.json` npx args change** - from `npx -y eforge mcp-proxy` to `npx -y @eforge-build/eforge mcp-proxy`.
3. **`docs/roadmap.md` removes completed items** - the Monorepo and npm scope migration items are removed per roadmap policy ("remove items once they ship").
4. **Bin command references (`eforge daemon start`, `eforge build`, etc.) are NOT changed** - they refer to the binary name, not the npm package name.

## Scope

### In Scope
- Root `README.md` - npm badges, install instructions, npx references, package name prose
- `AGENTS.md` - `src/engine/git.ts` -> `packages/engine/src/git.ts`; `pi-package/` -> `packages/eforge-pi/`
- `docs/architecture.md` - path references and package layout description
- `docs/hooks.md` - `src/engine/events.ts` path reference
- `docs/roadmap.md` - remove completed Monorepo and npm scope items
- `packages/client/README.md` - consumer package name references
- `packages/eforge-pi/README.md` - heading, install commands, package name references
- `eforge-plugin/.mcp.json` - npx args package name
- `eforge-plugin/.claude-plugin/plugin.json` - version bump to 0.5.21
- `eforge-plugin/skills/update/update.md` - ~8 npm/npx package name substitutions
- `packages/eforge-pi/skills/eforge-update/SKILL.md` - ~7 npm/npx package name substitutions
- `test/npm-install/README.md` - npx reference update

### Out of Scope
- Engine prompt file content (unchanged per preservation contract)
- Code comments in `.ts` files (covered by plan-02 code migration)
- Binary assets under `docs/images/`
- `.github/` CI workflows (separate concern)
- Other skill files that only reference bin commands / tool names (no changes needed)

## Files

### Modify

**Root docs:**
- `README.md` - Update npm badge URLs to `@eforge-build/eforge` and `@eforge-build/eforge-pi`; update `npm install -g eforge` to `npm install -g @eforge-build/eforge`; update `npx eforge` references; update `pi install npm:eforge-pi` to `pi install npm:@eforge-build/eforge-pi`; update prose mentioning "published separately as `eforge-pi`" to use new scoped name
- `AGENTS.md` - Update `src/engine/git.ts` -> `packages/engine/src/git.ts`; update `pi-package/` -> `packages/eforge-pi/`; update `packages/client/` reference if needed; add workspace layout convention bullet
- `docs/architecture.md` - Update all `src/engine/`, `src/monitor/`, `src/cli/` path references to `packages/` layout; update package names in any Mermaid diagrams
- `docs/hooks.md` - Update `src/engine/events.ts` path reference to `packages/engine/src/events.ts`
- `docs/roadmap.md` - Remove the "Monorepo" item and "npm scope migration to `@eforge-build`" item from Integration & Maturity section

**Package READMEs:**
- `packages/client/README.md` - Update references to `eforge` (npm package) to `@eforge-build/eforge`; update `eforge-pi` to `@eforge-build/eforge-pi`; update `pi-package/` to `packages/eforge-pi/`
- `packages/eforge-pi/README.md` - Update heading to reference `@eforge-build/eforge-pi`; update `pi install npm:eforge-pi` commands; update relationship to main `@eforge-build/eforge` package

**eforge-plugin (Claude Code plugin):**
- `eforge-plugin/.mcp.json` - Change `"eforge"` to `"@eforge-build/eforge"` in npx args array
- `eforge-plugin/.claude-plugin/plugin.json` - Bump version from `"0.5.20"` to `"0.5.21"`; name stays `"eforge"`
- `eforge-plugin/skills/update/update.md` - Replace `npx -y eforge` with `npx -y @eforge-build/eforge`; replace `npm view eforge version` with `npm view @eforge-build/eforge version`; replace `npm install -g eforge` with `npm install -g @eforge-build/eforge`; replace error message npm references

**Pi extension skills:**
- `packages/eforge-pi/skills/eforge-update/SKILL.md` - Same substitutions as the eforge-plugin update skill: `npx -y eforge` -> `npx -y @eforge-build/eforge`, `npm view eforge` -> `npm view @eforge-build/eforge`, `npm install -g eforge` -> `npm install -g @eforge-build/eforge`

**Test docs:**
- `test/npm-install/README.md` - Update `npx -y eforge` reference to `npx -y @eforge-build/eforge`

## Verification

- [ ] `grep -c "@eforge-build/eforge" eforge-plugin/.mcp.json` returns 1+ (npx args updated)
- [ ] `grep '"name": "eforge"' eforge-plugin/.claude-plugin/plugin.json` returns a match (marketplace name preserved)
- [ ] `grep '"version": "0.5.21"' eforge-plugin/.claude-plugin/plugin.json` returns a match (version bumped)
- [ ] `grep "npm install -g @eforge-build/eforge" README.md` returns a match (install instruction updated)
- [ ] `grep -c "npm install -g eforge[^-]" README.md` returns 0 (old unscoped install gone); note: `eforge-build` matches will be present so the pattern excludes the dash
- [ ] `grep "packages/engine/src/git.ts" AGENTS.md` returns a match (path updated)
- [ ] `grep "packages/eforge-pi/" AGENTS.md` returns a match (pi-package path updated)
- [ ] `grep -c "pi-package/" AGENTS.md` returns 0 (old path gone)
- [ ] `grep "@eforge-build/eforge" eforge-plugin/skills/update/update.md` returns 1+ matches
- [ ] `grep "@eforge-build/eforge" packages/eforge-pi/skills/eforge-update/SKILL.md` returns 1+ matches
- [ ] `grep -c "npx -y eforge[^-]" eforge-plugin/skills/update/update.md` returns 0 (all old npx refs gone); note: `eforge-build` will match so pattern excludes
- [ ] The strings `eforge daemon start`, `eforge build`, `eforge status`, `/eforge:build`, `/eforge:status`, `mcp__eforge__eforge_` are unchanged wherever they appear (preservation contracts)
- [ ] `docs/roadmap.md` does not contain "npm scope migration" or the specific Monorepo item text
- [ ] `pnpm build` still passes (no accidental breakage from doc edits)
- [ ] `pnpm test` still passes
