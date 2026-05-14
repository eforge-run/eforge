# Eforge Roadmap

## Daemon & MCP Server

**Goal**: Extend the daemon as the single orchestration authority with richer controls and safety checks.

- **Queue reordering & priority** - MCP tool and web UI controls for changing priority on queued PRDs at runtime (priority field exists in frontmatter and affects execution order, but there's no way to modify it after enqueue)

---

## Orchestrator Intelligence

**Goal**: Make the orchestrator's review-cycle decisions adaptive and observable.

- **Adaptive reviewer subset selection** - Wire protocol (`perspectives-respawned` event with `dropped: []`) and UI rendering are in place, but the selection logic in `packages/engine/src/pipeline/stages/build-stages.ts` still respawns the full perspective set every round. Implement subset selection: drop perspectives whose concerns are stale given the prior round's results and the nature of the fixes, and account for overlap between perspectives so concerns aren't double-counted.

---

## Extensibility

**Goal**: Make eforge a platform that agent runtime profiles and TypeScript modules can extend without forking the engine.

- **Profile toolbelts - runtime filtering** - The `tools.toolbelts` registry and per-tier `toolbelt` field are schema-valid, statically validated, and runtime-enforced. Agents in each tier receive only the MCP servers declared in their toolbelt; `toolbelt: none` passes an empty list; omitting `toolbelt` preserves the all-servers default. Runtime filtering and observability have shipped: toolbelt selection and resolved server names are visible in the monitor UI agent detail surface and in profile list/show output. Design in `docs/prd/profile-toolbelts.md`.
- **Native TypeScript extensions** - Typed event hooks, agent context/tool injection, policy gates, input transformers, and limited stage-like APIs (e.g. custom reviewer perspectives) authored as TypeScript modules and discoverable in user/project/project-local scopes. Includes an extension SDK package, a `/eforge:extend` skill in both Pi and Claude Code, CLI/daemon management commands, and event-replay testing. Multi-phase rollout starting with typed event hooks. Depends on TypeBox schema unification. Design in `docs/prd/typescript-extensibility.md`.

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Low-fidelity input handling** - When the user provides a high-level prompt with minimal detail, launch an exploration agent (or parallel exploratory agents) that performs thorough codebase exploration before compiling plans. Bypassed for detailed PRDs. Scope levels (expedition/errand/excursion) classify intended depth but don't perform exploration; this fills that gap.
- **Schema library unification on TypeBox** - TypeBox is canonical for eforge-owned domain schemas; Zod is isolated to third-party SDK compatibility adapters. The first migration slice (client wire schemas, engine structured output, and custom-tool contracts) is complete. Config, input artifact, and MCP proxy schemas remain Zod until a follow-up PRD lands.
- **TypeScript project references** - Adopt `tsconfig.json` `references` across workspace members for automatic topological ordering.

---

## Marketing Site (eforge.build)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** - `web/` directory, deployed to Vercel at eforge.build
- **Landing page** - Value prop, feature overview, getting-started guide
- **Documentation** - Usage docs, configuration reference, examples
