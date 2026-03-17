---
title: Add `/eforge:config` Skill + `eforge config` CLI Commands
created: 2026-03-17
status: failed
---

## Problem / Motivation

eforge config lives in `eforge.yaml` at the project root. The schema has many options (profiles, hooks, post-merge commands, Langfuse, plugins, agent overrides) but there's no guided way to create or modify this file, and no way to validate it. Users have to manually author YAML against an undocumented schema, with no feedback on correctness until runtime failures. Standalone CLI users have no way to inspect the fully resolved config (after global + project merge, default application, and profile resolution).

## Goal

Add a `/eforge:config` skill that interviews the user and generates/updates `eforge.yaml`, plus CLI commands (`eforge config validate`, `eforge config show`) that let both the skill and standalone users validate and inspect their configuration.

## Approach

Two parts:

### Part 1: CLI — `eforge config` subcommand group

Add a `config` command group to the CLI with two commands.

**`eforge config validate`** — loads `eforge.yaml` (+ global config), runs zod schema validation, and reports errors. Validates:
- Schema structure (all sections via `eforgeConfigSchema`)
- Profile extensions (no cycles, valid base names)
- Stage names (compile + build stages against registered stage names)
- Agent role names

Output: green checkmark + "Config valid" on success, or itemized error list on failure with exit code 1.

Implementation in `src/cli/index.ts`:
1. Call `loadConfig()` — this already parses and warns on invalid fields
2. For deeper validation, also load the raw YAML and run `eforgeConfigSchema.safeParse()` to get structured errors (not the fallback path that silently drops bad sections)
3. Validate each resolved profile via existing `validateProfileConfig()` from `config.ts`, passing the stage registries from `pipeline.ts` (`getCompileStageNames()`, `getBuildStageNames()`)
4. Print results with chalk formatting

Expose stage name sets from `pipeline.ts`:
- Add `getCompileStageNames(): Set<string>` and `getBuildStageNames(): Set<string>` exports that return the registered stage names

**`eforge config show`** — prints the fully resolved config (all layers merged, defaults applied, profiles resolved). Implementation:
1. Call `loadConfig()` to get the resolved `EforgeConfig`
2. Serialize to YAML (using the `yaml` package already in deps) and print to stdout
3. Source annotation (e.g., `# from global config`, `# default`) is out of scope for v1

### Part 2: Plugin Skill — `/eforge:config`

Single skill at `eforge-plugin/skills/config/config.md` that handles both init and edit modes. Follows the `roadmap-init` pattern (interactive interview, context gathering, present-before-writing).

**Mode detection:**
- No flags, no config file → init mode (scaffold new `eforge.yaml`)
- No flags, config exists → edit mode (show current config, offer changes)
- `--init` → force init mode (error if file exists)
- `--edit` → force edit mode (error if no file)

**Init mode workflow:**
1. Check existence — if `eforge.yaml` exists and no `--init`, switch to edit mode
2. Gather context — read CLAUDE.md, project structure, `package.json` (for test/build commands), existing `.mcp.json`
3. Suggest starter config based on context:
   - `build.postMergeCommands` inferred from package.json scripts (install, type-check, test)
   - A `docs` profile if the project has documentation
   - Langfuse section if `.env` or env vars hint at it
   - Hooks if the user wants event tracking
4. Interview — ask what sections to include (essentials-only depth: description, extends, build stages for profiles; detected scripts for post-merge commands). Don't surface advanced options unless asked.
5. Generate and present — show the YAML draft
6. Write — save to `eforge.yaml`
7. Validate — run `eforge config validate` to confirm correctness. If errors, show them and offer to fix.

**Edit mode workflow:**
1. Show current config — run `eforge config show` to display resolved state
2. Suggest actions based on what's configured and what's missing:
   - "Add a workflow profile"
   - "Add post-merge validation commands"
   - "Configure Langfuse tracing"
   - "Add event hooks"
   - "Configure plugin loading"
   - "Adjust agent settings"
   - "Edit an existing profile"
3. Interview for chosen action — focused questions for just that section
4. Present diff — show what will change
5. Apply — edit the file
6. Validate — run `eforge config validate`

**Config section interview templates:**

*Profile creation* (essentials-only):
- What's this profile for? (description)
- Extend an existing profile? (errand/excursion/expedition/custom)
- Which build stages? (implement only, or full with review?)

*Post-merge commands*:
- Scan package.json for common scripts (install, build, type-check, test, lint)
- Present detected commands, let user pick/reorder

*Hooks*:
- What events to hook? (session, phase, plan, build)
- What command to run?

*Langfuse*:
- Already have keys? (check .env)
- Custom host or cloud?

**Skill file structure** follows the established pattern:
- Frontmatter: `description`, `disable-model-invocation: true`, `argument-hint: "[--init|--edit]"`
- Sections: Arguments, Workflow (numbered steps), Error Handling table
- Interactive steps use "ask the user" language
- Present before writing pattern (show draft → confirm → write)
- Validate after writing pattern (run CLI command → show results)

## Scope

**In scope:**
- `eforge config validate` CLI command with zod schema validation, profile extension cycle detection, stage name validation, and agent role name validation
- `eforge config show` CLI command printing fully resolved YAML config
- Exporting `getCompileStageNames()` and `getBuildStageNames()` from `src/engine/pipeline.ts`
- `/eforge:config` plugin skill with init and edit modes, interactive interview, context-aware suggestions, present-before-writing, and post-write validation
- Bumping plugin version to 1.5.0

**Out of scope:**
- Source annotation in `eforge config show` output (e.g., `# from global config`, `# default`) — deferred beyond v1
- Surfacing advanced config options in the skill interview unless the user asks

**Files to modify:**

| File | Change |
|------|--------|
| `src/cli/index.ts` | Add `config` command group with `validate` and `show` subcommands |
| `src/engine/pipeline.ts` | Export `getCompileStageNames()` and `getBuildStageNames()` |
| `eforge-plugin/skills/config/config.md` | **Create** — the skill prompt |
| `eforge-plugin/.claude-plugin/plugin.json` | **Edit** — add skill to commands array, bump version to 1.5.0 |

## Acceptance Criteria

1. `pnpm build` succeeds with no build errors
2. `pnpm test` — all existing tests pass
3. `eforge config validate` run against the eforge project's own `eforge.yaml` reports valid (green checkmark + "Config valid")
4. `eforge config validate` reports itemized errors and exits with code 1 when given an invalid config
5. `eforge config show` prints the fully resolved config including the `docs` profile as valid YAML
6. `eforge-plugin/.claude-plugin/plugin.json` is valid JSON with the correct skill path and version bumped to 1.5.0
7. `/eforge:config` invoked in a project without `eforge.yaml` enters init mode
8. `/eforge:config` invoked in the eforge project (has `eforge.yaml`) enters edit mode
9. `/eforge:config --init` errors if `eforge.yaml` already exists
10. `/eforge:config --edit` errors if `eforge.yaml` does not exist
