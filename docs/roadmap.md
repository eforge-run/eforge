# Eforge Roadmap

## Daemon & MCP Server

**Goal**: Extend the daemon as the single orchestration authority with richer controls and safety checks.

- **Queue reordering & priority** - MCP tool and web UI controls for changing priority on queued PRDs at runtime (priority field exists in frontmatter and affects execution order, but there's no way to modify it after enqueue)

---

## Extensibility

**Goal**: Make eforge a platform that agent runtime profiles and TypeScript modules can extend without forking the engine.

- **Native TypeScript extensions** - Typed event hooks, agent context/tool injection, policy gates, input transformers, and limited stage-like APIs (e.g. custom reviewer perspectives) authored as TypeScript modules and discoverable in user/project/project-local scopes. Includes an extension SDK package, a `/eforge:extend` skill in both Pi and Claude Code, CLI/daemon management commands, and event-replay testing. Multi-phase rollout starting with typed event hooks. Depends on TypeBox schema unification. Design in `docs/prd/typescript-extensibility.md`.

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Low-fidelity input handling** - When the user provides a high-level prompt with minimal detail, launch an exploration agent (or parallel exploratory agents) that performs thorough codebase exploration before compiling plans. Bypassed for detailed PRDs. Scope levels (expedition/errand/excursion) classify intended depth but don't perform exploration; this fills that gap.
- **Schema library unification on TypeBox** - TypeBox is canonical for eforge-owned domain schemas; Zod is isolated to third-party SDK compatibility adapters. The first migration slice (client wire schemas, engine structured output, and custom-tool contracts) is complete. Config, input artifact, and MCP proxy schemas remain Zod until a follow-up PRD lands.
- **TypeScript project references** - Adopt `tsconfig.json` `references` across workspace members for automatic topological ordering.
