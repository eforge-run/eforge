---
id: plan-01-update-skill
name: Add /eforge:update Skill
depends_on: []
branch: plan-add-eforge-update-skill-to-the-plugin/update-skill
---

# Add /eforge:update Skill

## Architecture Context

The eforge plugin (`eforge-plugin/`) exposes skills as markdown files registered in `plugin.json`'s `commands` array. Each skill uses YAML frontmatter (`description`, `disable-model-invocation: true`) and a markdown body with numbered workflow steps. The daemon-restart pattern (stop + start) already exists in `.claude/skills/eforge-daemon-restart/SKILL.md` and can be referenced for the restart portion. No MCP tools are needed — this skill uses bash commands and user instructions only.

## Implementation

### Overview

Create a new skill file at `eforge-plugin/skills/update/update.md` that walks the user through checking versions, updating the npm package, restarting the daemon, and guiding the plugin update. Register it in `plugin.json` and bump the plugin version from `0.5.1` to `0.5.2`.

### Key Decisions

1. **No MCP tools needed** — version checking and npm install are bash commands; plugin update requires the user to run a slash command manually.
2. **Global install detection via `which eforge`** — if the resolved path contains a global `node_modules`, run `npm install -g eforge@latest`. If using npx, skip (npx fetches latest automatically).
3. **Early exit on "up to date"** — compare `eforge --version` output with `npm view eforge version`; if equal, report up to date and stop.
4. **Plugin update is manual** — skills cannot invoke other slash commands, so step 5 instructs the user to run `/plugin update eforge@eforge`.

## Scope

### In Scope
- New skill file: `eforge-plugin/skills/update/update.md`
- Register skill in `eforge-plugin/.claude-plugin/plugin.json` (`commands` array)
- Bump plugin version `0.5.1` -> `0.5.2`

### Out of Scope
- New MCP tools
- Automated plugin update (skills cannot invoke slash commands)
- npx-specific update logic (npx always fetches latest)

## Files

### Create
- `eforge-plugin/skills/update/update.md` — The `/eforge:update` skill markdown file with the 6-step workflow (check current versions, check latest, update npm package, restart daemon, guide plugin update, report summary)

### Modify
- `eforge-plugin/.claude-plugin/plugin.json` — Add `"./skills/update/update.md"` to the `commands` array and bump `version` from `"0.5.1"` to `"0.5.2"`

## Verification

- [ ] File `eforge-plugin/skills/update/update.md` exists and contains YAML frontmatter with `description` and `disable-model-invocation: true`
- [ ] `plugin.json` `commands` array contains `"./skills/update/update.md"` as the 4th entry
- [ ] `plugin.json` `version` field is `"0.5.2"`
- [ ] The skill markdown includes a step that runs `eforge --version` to get the current CLI version
- [ ] The skill markdown includes a step that runs `npm view eforge version` to check the latest version
- [ ] The skill markdown includes an early-exit condition when current version matches latest
- [ ] The skill markdown includes `npm install -g eforge@latest` for global installs
- [ ] The skill markdown includes `eforge daemon stop` followed by `eforge daemon start`
- [ ] The skill markdown includes an instruction telling the user to run `/plugin update eforge@eforge`
- [ ] The skill markdown includes a final report showing old and new versions for both npm package and plugin
