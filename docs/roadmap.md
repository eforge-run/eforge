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

- **Profile toolbelts** - MCP-backed capability bundles selected per agent tier in runtime profiles. A profile can say "the implementation tier uses the browser-ui toolbelt" so each tier only sees MCP servers relevant to its role. MVP is intentionally conservative: one toolbelt per tier, MCP-only, no Pi extension or Claude plugin backing, no composition. Design in `docs/prd/profile-toolbelts.md`.
- **Native TypeScript extensions** - Typed event hooks, agent context/tool injection, policy gates, input transformers, and limited stage-like APIs (e.g. custom reviewer perspectives) authored as TypeScript modules and discoverable in user/project/project-local scopes. Includes an extension SDK package, a `/eforge:extend` skill in both Pi and Claude Code, CLI/daemon management commands, and event-replay testing. Multi-phase rollout starting with typed event hooks. Depends on TypeBox schema unification. Design in `docs/prd/typescript-extensibility.md`.

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Low-fidelity input handling** - When the user provides a high-level prompt with minimal detail, launch an exploration agent (or parallel exploratory agents) that performs thorough codebase exploration before compiling plans. Bypassed for detailed PRDs. Scope levels (expedition/errand/excursion) classify intended depth but don't perform exploration; this fills that gap.
- **Schema library unification on TypeBox** - Standardize on TypeBox across the codebase. TypeBox schemas are JSON Schema natively (no `z.toJSONSchema()` conversion), already in the dep tree for Pi, and align with Pi's tool API. *Needs a dedicated scoping session - previously punted on, tradeoffs need to be re-examined before committing.*
- **TypeScript project references** - Adopt `tsconfig.json` `references` across workspace members for automatic topological ordering.

---

## Marketing Site (eforge.build)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** - `web/` directory, deployed to Vercel at eforge.build
- **Landing page** - Value prop, feature overview, getting-started guide
- **Documentation** - Usage docs, configuration reference, examples
