---
id: plan-01-trim-claude-md
name: Trim CLAUDE.md bloat and add documentation hierarchy guidance
depends_on: []
branch: trim-claude-md-bloat-and-add-documentation-hierarchy-guidance/trim-claude-md
---

# Trim CLAUDE.md bloat and add documentation hierarchy guidance

## Architecture Context

CLAUDE.md is the agent guidance file consumed by AI agents working in this codebase. At 217 lines, it contains substantial implementation detail that agents can derive from reading source code. This plan trims it to ~120-140 lines and adds a `## Documentation` section so agents know where human-facing docs live and how to avoid polluting searches with `node_modules/` results.

## Implementation

### Overview

Edit CLAUDE.md to: (1) add a `## Documentation` section after "What is this?", (2) trim Architecture section by removing implementation details and replacing verbose agent descriptions with a compact list, (3) trim Configuration section by removing model class system, merge strategy, hook env vars, and profile internals, (4) replace CLI commands section with a `--help` pointer, (5) trim Tech decisions to keep only the "why", (6) add search exclusion bullet to Conventions.

### Key Decisions

1. Keep all structural guidance (conventions, testing philosophy, roadmap governance, project structure) intact - these are not derivable from code
2. Replace full agent paragraphs with a compact `name - one-phrase role` bullet list since the detailed descriptions restate what reading the agent source files would tell you
3. Keep source file pointers (e.g., `pipeline.ts`, `backend.ts`, `orchestrator.ts`) so agents know where to look, but remove the implementation details about those files
4. The `## Commands` section (pnpm build/test/type-check) stays - it's a quick-reference that saves agents from parsing package.json

## Scope

### In Scope
- Add `## Documentation` section (after "What is this?") with README.md guidance and node_modules/dist search exclusion
- Trim Architecture section: remove SdkPassthroughConfig/pickSdkOptions details, MCP server propagation implementation, plugin propagation implementation, monitor internals, orchestration merge strategy, state file details, pipeline stage enumeration, built-in profile compile stage lists; condense agent list to compact bullets
- Trim Configuration section: remove model class system, merge strategy details, prdQueue/daemon field docs, hook env var table, profiles merge/extends details
- Replace CLI commands section with `--help` pointer and key command list
- Trim Tech decisions: remove tsup external config detail, env var names (EFORGE_MONITOR_PORT/DB), settingSources default, PiMcpBridge implementation detail
- Add search exclusion bullet to Conventions

### Out of Scope
- Changes to README.md, docs/, or any source code
- Adding new documentation content beyond what the PRD specifies
- Restructuring sections beyond trimming and the new Documentation section

## Files

### Modify
- `CLAUDE.md` - All edits described above: add Documentation section, trim Architecture/Configuration/CLI commands/Tech decisions, add Conventions bullet

## Verification

- [ ] CLAUDE.md contains a `## Documentation` section between "What is this?" and "Commands" with README.md guidance and node_modules/dist exclusion advice
- [ ] Architecture section no longer contains: SdkPassthroughConfig, pickSdkOptions, resolveAgentConfig, PiMcpBridge, JSON Schema to TypeBox, installed_plugins.json discovery, countdown state machine, hasSeenActivity, signalMonitorShutdown, squash-merge, force-delete, two-level merge, maxValidationRetries, state.json, compile stage list, build stage list, composite stage expansions, built-in profile compile stage lists
- [ ] Architecture section retains: "engine emits, consumers render" principle, pipeline is stage-driven pointer to pipeline.ts, workflow profiles concept pointer to config.ts, backend abstraction rule pointer to backend.ts, compact agent bullet list, one-sentence MCP/plugin propagation, one-sentence orchestration pointer to orchestrator.ts
- [ ] Configuration section no longer contains: model class resolution order, AGENT_MODEL_CLASSES, MODEL_CLASS_DEFAULTS, shallow merge per-field rules, hook env var table, prdQueue field-level docs, daemon field-level docs, profiles extends/merge details
- [ ] Configuration section retains: two-level config with pointers, priority chain one-liner, profile concept one-sentence
- [ ] CLI commands section is a single `--help` pointer with key command list (no code block listing all commands and flags)
- [ ] Tech decisions retains the "why" for ESM-only, claude-agent-sdk, Pi backend, AsyncGenerator pattern; does not contain EFORGE_MONITOR_PORT, EFORGE_MONITOR_DB, settingSources default, tsup external config
- [ ] Conventions section includes a bullet about excluding node_modules/ and dist/ from file searches
- [ ] Project structure, Testing, Roadmap, and Key references sections are unchanged
- [ ] Final line count is between 120 and 145 lines
