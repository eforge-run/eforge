---
id: plan-01-config-commands
name: Config CLI Commands and Plugin Skill
depends_on: []
branch: add-eforge-config-skill-eforge-config-cli-commands/config-commands
---

# Config CLI Commands and Plugin Skill

## Architecture Context

eforge config loading is handled by `src/engine/config.ts` which parses `eforge.yaml`, merges with global config, and resolves profiles. The zod schema (`eforgeConfigSchema`) validates structure but is not exported as a value — only used internally by `parseRawConfig()`. Stage name sets are already exported from `pipeline.ts` via `getCompileStageNames()` and `getBuildStageNames()`. The CLI lives in `src/cli/index.ts` using Commander command groups. The plugin skill pattern is established in `eforge-plugin/skills/` — see `roadmap-init.md` for the interview-and-write pattern.

## Implementation

### Overview

1. Export the zod schema and a dedicated `validateConfigFile()` function from `config.ts`
2. Add `eforge config validate` and `eforge config show` CLI subcommands
3. Create the `/eforge:config` plugin skill with init and edit modes
4. Register the skill in `plugin.json` and bump version to 1.5.0

### Key Decisions

1. **Export a `validateConfigFile()` function** rather than making the CLI assemble validation logic from raw primitives. The function loads raw YAML, runs `eforgeConfigSchema.safeParse()` for structural errors, then validates each resolved profile via `validateProfileConfig()` with stage registries. Returns structured errors. This keeps validation logic in the engine where it belongs.
2. **`eforge config show` serializes via `yaml.stringify()`** on the resolved `EforgeConfig` object. The `yaml` package is already a dependency. No source annotation in v1.
3. **The skill uses `eforge config validate`** as a post-write validation step — it runs the CLI command via Bash rather than reimplementing validation logic.

## Scope

### In Scope
- Export `eforgeConfigSchema` (value) and `AGENT_ROLES` from `config.ts`
- New `validateConfigFile(cwd?: string): Promise<{ valid: boolean; errors: string[] }>` in `config.ts`
- Re-export new symbols from `src/engine/index.ts`
- `eforge config validate` CLI command
- `eforge config show` CLI command
- `/eforge:config` skill with init and edit modes
- Plugin version bump to 1.5.0

### Out of Scope
- Source annotation in `eforge config show`
- Advanced config options in skill interview
- Tests for CLI commands (integration-level, per testing conventions)

## Files

### Create
- `eforge-plugin/skills/config/config.md` — Plugin skill prompt with init/edit modes, interactive interview, context-aware suggestions, present-before-writing, post-write validation

### Modify
- `src/engine/config.ts` — Export `eforgeConfigSchema` value and `AGENT_ROLES` array; add `validateConfigFile()` function that loads raw YAML, runs schema validation, then validates each resolved profile against stage registries
- `src/engine/index.ts` — Re-export `eforgeConfigSchema`, `AGENT_ROLES`, and `validateConfigFile` from config.ts
- `src/cli/index.ts` — Add `config` command group with `validate` and `show` subcommands. `validate` calls `validateConfigFile()` and prints results with chalk. `show` calls `loadConfig()` and prints YAML via `yaml.stringify()`.
- `eforge-plugin/.claude-plugin/plugin.json` — Add `"./skills/config/config.md"` to commands array, bump version to `"1.5.0"`

## Verification

- [ ] `pnpm build` exits with code 0
- [ ] `pnpm test` exits with code 0 (all existing tests pass)
- [ ] `pnpm dev -- config validate` prints a green checkmark and "Config valid" when run from the eforge project root (which has a valid `eforge.yaml`)
- [ ] `pnpm dev -- config validate` exits with code 1 and prints itemized errors when given an invalid config (e.g., unknown stage name in a profile)
- [ ] `pnpm dev -- config show` prints YAML that includes the `docs` profile (from `eforge.yaml`) merged with built-in profiles
- [ ] `eforge-plugin/.claude-plugin/plugin.json` is valid JSON, contains `"./skills/config/config.md"` in the commands array, and has `"version": "1.5.0"`
- [ ] `eforge-plugin/skills/config/config.md` exists with frontmatter containing `description`, `disable-model-invocation: true`, and `argument-hint: "[--init|--edit]"`
- [ ] The skill file contains distinct init mode and edit mode workflows with mode detection logic (check for `--init`, `--edit` flags and `eforge.yaml` existence)
- [ ] `eforgeConfigSchema` is exported as a value from `src/engine/config.ts` and re-exported from `src/engine/index.ts`
- [ ] `validateConfigFile` is exported from `src/engine/config.ts` and re-exported from `src/engine/index.ts`
