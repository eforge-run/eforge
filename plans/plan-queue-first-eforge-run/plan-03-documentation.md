---
id: plan-03-documentation
name: Documentation Updates
depends_on: [plan-02-cli-mcp-plugin]
branch: plan-queue-first-eforge-run/documentation
---

# Documentation Updates

## Architecture Context

With all code changes complete (plans 01 and 02), this plan updates documentation to reflect the queue-first model: CLI command rename (`run` → `build`), daemon auto-build behavior, new config option, and plugin skill changes.

## Implementation

### Overview

Update `CLAUDE.md` and `README.md` to reflect:
- `eforge run` → `eforge build` (with `run` as backwards-compatible alias)
- New `--foreground` flag
- Default behavior: enqueue via daemon, daemon auto-builds
- `prdQueue.autoBuild` config option
- Plugin skill changes (`/eforge:build` replacing `/eforge:run` and `/eforge:enqueue`)
- MCP tool renames (`eforge_build`, `eforge_auto_build`)

### Key Decisions

1. **Document `build` as primary, mention `run` as alias** — don't list both everywhere, just note the alias exists for backwards compatibility.
2. **Add `prdQueue.autoBuild` to config documentation** — in the Configuration section of CLAUDE.md.
3. **Update CLI commands section** — replace `eforge run` with `eforge build` throughout, add `--foreground` flag.

## Scope

### In Scope
- `CLAUDE.md`: Update CLI commands section, plugin skill references, config docs, MCP tool references
- `README.md`: Update all CLI examples, architecture description for queue-first model, daemon auto-build

### Out of Scope
- Any code changes
- Roadmap updates (roadmap is future-only; this is now shipped)

## Files

### Modify
- `CLAUDE.md` — Update "CLI commands" section: rename `eforge run` → `eforge build` in all entries, add `eforge build --foreground` entry, note `run` alias. Update "Flags" line to include `--foreground`. Update plugin commands table if present. Add `prdQueue.autoBuild` (default: `true`) to the Configuration section description. Update any MCP tool references from `eforge_run` → `eforge_build`. Add `eforge_auto_build` MCP tool mention. Update eforge-plugin skill references.
- `README.md` — Update all `eforge run` examples to `eforge build`. Update architecture description to reflect queue-first model (default path enqueues via daemon, daemon auto-builds). Document `--foreground` flag. Mention `prdQueue.autoBuild` config option.

## Verification

- [ ] `CLAUDE.md` contains no references to `eforge run` as a primary command (only as an alias mention)
- [ ] `CLAUDE.md` documents `prdQueue.autoBuild` config option with default `true`
- [ ] `CLAUDE.md` CLI commands section lists `eforge build` (not `eforge run`)
- [ ] `CLAUDE.md` references `eforge_build` MCP tool (not `eforge_run`)
- [ ] `README.md` contains no references to `eforge run` as a primary command (only as an alias mention)
- [ ] `README.md` documents the queue-first default behavior
- [ ] `README.md` documents `--foreground` flag
- [ ] No broken markdown links or formatting issues in either file
