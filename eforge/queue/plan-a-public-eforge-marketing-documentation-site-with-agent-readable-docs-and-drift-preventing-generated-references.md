---
title: Plan a public eforge marketing/documentation site with agent-readable docs and drift-preventing generated references
created: 2026-05-13
profile: claude-sdk-4-7
---

# Plan a public eforge marketing/documentation site with agent-readable docs and drift-preventing generated references

## Problem / Motivation

eforge needs a public site that explains the project to humans, but more importantly exposes canonical, agent-readable documentation so coding agents can reliably learn how to install, configure, use, and integrate with eforge. Current documentation is repository-oriented and hand-maintained, so reference docs for CLI commands, daemon APIs, events, config schemas, MCP tools, Pi commands, and Claude plugin capabilities can drift from implementation.

**Evidence:**

- `docs/roadmap.md` contains a broad Marketing Site roadmap item but does not explicitly require agent-readable docs or generated references.
- `README.md` currently serves as the main public overview and install guide.
- `AGENTS.md` identifies several code-owned contracts that must stay centralized (`@eforge-build/client` routes/wire shapes, `events.schemas.ts`, shared client helpers, plugin/Pi sync), which are exactly the areas likely to drift if documented manually.
- Code inspection found concrete sources of truth for generated docs: CLI command registration, daemon route constants/types, event schemas, config schemas, MCP tool declarations, and Pi/Claude integration skill directories.

**Who is affected:**

- Human users discovering eforge and trying to install/configure it.
- Coding agents that need concise, raw, stable, machine-readable instructions and references.
- Maintainers, because manual reference docs create ongoing drift risk as APIs/tools/config evolve.

**Why now:**

- The roadmap already calls for `eforge.build`; refining the requirement now avoids building a marketing-only site that later needs to be retrofitted for agents and generated references.

**Profile signal:** Recommended profile is **Excursion**.

Rationale:

- This is a multi-file feature spanning a new `web/` app, docs-generation scripts/package, root workspace scripts, CI, and existing docs links.
- The work is cohesive enough for one planner to produce a single plan without delegated module planning.
- It does not require an Expedition: there are multiple areas, but the architecture is straightforward and the dependency chain is sequential (`docs-gen` outputs feed `web`, root scripts/CI validate both).
- It is not an Errand because it introduces a new app plus deterministic generation/drift checks.

**Context evidence reviewed:**

- `docs/roadmap.md` already has a **Marketing Site (eforge.build)** roadmap item: Next.js app in `web/`, Vercel deployment, landing page, documentation, usage/config/examples.
- `README.md` is currently the primary public-facing overview: value proposition, install paths for Claude Code/Pi/standalone CLI, configuration summary, screenshots, and development commands.
- `AGENTS.md` establishes important doc/source-of-truth constraints: engine emits events; shared daemon HTTP client and routes live in `@eforge-build/client`; event schemas live in `packages/client/src/events.schemas.ts`; daemon wire shapes are client-owned; Pi and Claude Code integrations must stay in sync.
- Existing docs include `docs/config.md`, `docs/architecture.md`, `docs/hooks.md`, `docs/config-migration.md`, and PRDs under `docs/prd/`. There is no existing `web/` app.
- The monorepo already has a Vite React monitor UI in `packages/monitor-ui/`, using Tailwind/shadcn-style components. That is evidence for design-system reuse, but not a public docs-site framework.
- Potential code-owned reference sources exist:
  - CLI commands: `packages/eforge/src/cli/index.ts` and `packages/eforge/src/cli/playbook.ts`.
  - Daemon API routes and request/response wire types: `packages/client/src/routes.ts` and `packages/client/src/api/*`.
  - Event protocol: `packages/client/src/events.schemas.ts`.
  - Config/profile schemas: `packages/engine/src/config.ts`.
  - MCP tool declarations: `packages/eforge/src/cli/mcp-proxy.ts`, via `createDaemonTool(...)`.
  - Pi native extension tools/commands: `packages/pi-eforge/extensions/eforge/`.
  - Claude Code skill docs: `eforge-plugin/skills/`; Pi skill docs: `packages/pi-eforge/skills/`.

**Initial conclusions:**

- This aligns with the existing roadmap, but the roadmap wording underspecifies the user's priority: agent-readable docs and drift-preventing generated references are more important than a purely human-readable marketing site.
- The site should likely treat hand-written docs as explanatory guides and generated references as canonical facts derived from code-owned schemas/registries.
- A documentation generator package/script can enforce drift prevention with CI: generate reference artifacts, build the docs site, and fail if generated files differ from checked-in output.

**Assumptions / unknowns to resolve:**

- Assumption: using Next.js under `web/` remains desired because the roadmap says so. Confidence high; validation cost low; user can override.
- Assumption: Fumadocs or a similar MDX docs framework is acceptable if it does not become the source of truth for references. Confidence medium; validation cost low; needs a choice.
- Unknown: whether generated docs should be checked in (`*.generated.md`) or generated only during site build. This affects reviewability and CI strategy.
- Unknown: whether to introduce a new package such as `packages/docs-gen/` or keep generation scripts under `scripts/` initially.

## Goal

Deliver a public eforge site at `eforge.build` that pairs a minimal human-readable marketing/documentation surface with first-class, drift-proof agent-readable canonical documentation generated deterministically from code-owned sources of truth.

## Approach

**Design decisions:**

1. **Use Next.js in `web/`.**
   - Rationale: matches the existing roadmap item and the intended Vercel deployment target.

2. **Roll a small custom docs shell instead of adopting Fumadocs for the MVP.**
   - User preference: avoid a large new docs-framework dependency and reduce npm supply-chain/hijack risk.
   - Rationale: eforge's highest-value docs outputs are agent-readable artifacts and generated references, not a feature-rich human docs framework.
   - Constraint: keep the shell intentionally boring so maintenance burden stays low.

3. **Use plain Markdown for authored and generated docs initially; avoid MDX unless a specific need emerges.**
   - Rationale: Markdown is easier for agents to consume, easier to concatenate into `llms-full.txt`, and simpler to generate deterministically.
   - Trade-off: fewer rich docs components, acceptable for MVP.

4. **Keep generated docs in a dedicated generation layer.**
   - Prefer a new workspace package such as `packages/docs-gen/` once there are multiple generators.
   - Rationale: separates extraction/serialization from the web app and makes drift checks runnable without depending on the rendered site.

5. **Check generated reference outputs into git.**
   - User confirmed this decision.
   - Rationale: generated docs become reviewable in PRs, and CI can detect stale output with `pnpm docs:generate && git diff --exit-code`.
   - Trade-off: generated files add churn, but that churn is useful when public contracts change.

6. **Treat raw agent docs as the primary long-term documentation product.**
   - User stated that `llms.txt` and related artifacts are more important long-term than human-readable docs because agents increasingly consume documentation on users' behalf.
   - Required outputs include `/llms.txt`, `/llms-full.txt`, `/reference/*.md`, and `/schemas/*.json` where practical.
   - Rationale: coding agents should not need to scrape rendered HTML to understand eforge.

7. **Human docs should be useful but minimal.**
   - Landing page and basic docs help discovery, trust, installation, and search engine/social context.
   - Avoid building a complex docs product for humans at the expense of agent-readable correctness.

8. **Add provenance to every generated reference page.**
   - Include a "Generated file. Do not edit." warning, source files used, and package version/commit or generation metadata.
   - Rationale: helps humans and agents distinguish canonical generated facts from explanatory prose.

9. **Start with pragmatic extraction, then harden sources over time.**
   - Some references are straightforward to generate from existing code (`API_ROUTES`, Zod schemas).
   - Some are harder because CLI/MCP/tool declarations are embedded in imperative registration code.
   - MVP may introduce small typed adapters or metadata extractors where needed, but should avoid creating a parallel source of truth.

10. **Future-facing: if extraction from imperative command/tool declarations is brittle, migrate those declarations toward shared registries.**
    - Rationale: a shared registry can drive CLI/tool registration and docs generation from the same metadata.
    - Constraint: do not block the MVP on a large CLI/MCP refactor unless extraction proves unworkable.

11. **Explicitly defer high-maintenance docs-platform features.**
    - No full-text search requirement for MVP.
    - No versioned docs requirement for MVP.
    - No docs plugin architecture.
    - Sidebar/navigation can come from a simple checked-in manifest.

12. **Make local development simple and daemon-free.**
    - Add `pnpm docs:dev` as the primary developer command.
    - It should run `pnpm docs:generate` once, then start the Next.js dev server for `web/`.
    - It must not require the eforge daemon, LLM credentials, or Vercel.
    - Do not require generator watch mode for MVP; developers can rerun `pnpm docs:generate` after changing source-of-truth files.

**Expected code impact:**

New primary areas:

- `web/`
  - New public marketing/documentation app.
  - Should be part of the pnpm workspace.
  - Likely Next.js with Markdown/MDX docs content and static/public generated artifacts.
  - Publishes human pages plus stable agent-readable routes/artifacts.
- `packages/docs-gen/` or equivalent generator package/script
  - Deterministic documentation-generation layer.
  - Emits generated Markdown and JSON/schema artifacts consumed by `web/`.
  - Candidate generators: CLI, daemon API, events, config/profile schema, MCP/Pi/Claude tools, `llms.txt`, `llms-full.txt`.

Existing files likely changed:

- `pnpm-workspace.yaml`
  - Add `web` to workspace packages. User confirmed this should be in scope.
- Root `package.json`
  - Add scripts such as `docs:generate`, `docs:check`, and `docs:build`.
- `.github/workflows/ci.yml`
  - Add docs generation/build checks so stale generated docs fail CI.
- `README.md`
  - Link to public site and clarify relationship between repo docs and public docs.
- Possibly existing docs under `docs/`
  - Add cross-links or move/copy selected content into the public docs source.

Code-owned source-of-truth inputs for docs generation:

- CLI command surface:
  - `packages/eforge/src/cli/index.ts`.
  - `packages/eforge/src/cli/playbook.ts`.
- Daemon API routes and wire types:
  - `packages/client/src/routes.ts`.
  - `packages/client/src/api/*`.
- Event protocol:
  - `packages/client/src/events.schemas.ts`.
- Config/profile schemas:
  - `packages/engine/src/config.ts`.
- MCP tool declarations:
  - `packages/eforge/src/cli/mcp-proxy.ts`, via `createDaemonTool(...)`.
- Pi extension commands/tools:
  - `packages/pi-eforge/extensions/eforge/`.
- Claude Code and Pi skill surfaces:
  - `eforge-plugin/skills/`.
  - `packages/pi-eforge/skills/`.

Expected validation commands:

```bash
pnpm docs:generate
pnpm docs:check
pnpm docs:build
pnpm build
pnpm type-check
pnpm test
```

**Evidence:**

- `pnpm-workspace.yaml` currently includes only `packages/*`, so `web` must be explicitly added to make it workspace-managed.
- Existing CI runs `pnpm build`, `pnpm type-check`, and `pnpm test`; docs checks can be inserted after install/build depending on generator dependencies.
- Existing monitor UI already uses React/Tailwind/shadcn-style components, but it is a Vite app and not a public docs site.

**Material assumptions and validation ledger:**

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| `web/` should use Next.js and target Vercel. | `docs/roadmap.md` explicitly names a Next.js app in `web/` deployed to Vercel at `eforge.build`. | high | low | User can override before build; implementation can confirm Vercel-compatible build scripts. | Medium - would affect app scaffold and deployment scripts. |
| `web/` should be included in the pnpm workspace. | `pnpm-workspace.yaml` currently includes only `packages/*`; user explicitly agreed to add `web` to the workspace. | high | low | Verify `pnpm -r build/type-check` includes or intentionally excludes `web` as configured. | Medium - root scripts/CI would be less consistent. |
| A custom minimal docs shell is preferred over Fumadocs for MVP. | Discussed Fumadocs vs alternatives. User prefers rolling our own if maintenance burden is low, partly to avoid a large new npm docs-framework dependency / supply-chain risk. | high | low | Implementation should keep scope small: plain Markdown, simple manifest/sidebar, no full-text search/versioning/plugin system for MVP. | Medium - if the shell grows complex, maintenance burden could exceed using a framework. |
| Agent-readable artifacts are more important long-term than human docs pages. | User stated `llms.txt` and related artifacts are the more important long-term docs product because agents increasingly consume docs on users' behalf. | high | low | Acceptance criteria prioritize raw Markdown/schema outputs and drift prevention. | High - optimizing primarily for human docs would miss the core product requirement. |
| Generated docs can be derived from current source files without a major prerequisite refactor. | Code inspection found plausible sources: `API_ROUTES`, `events.schemas.ts`, config Zod schemas, CLI command registration, MCP/Pi/Claude tool/skill declarations. Some imperative sources may be harder. | medium | medium | Implement generator spike. If imperative extraction is brittle, introduce small shared metadata registries/adapters for those surfaces. | High - could require extra refactoring before complete generated references are possible. |
| Zod schemas can produce useful machine-readable JSON schema exports for events/config. | Events/config are currently Zod-based (`packages/client/src/events.schemas.ts`, `packages/engine/src/config.ts`). No export path was validated during planning. | medium | medium | Spike `zod` JSON schema export compatibility or use a small converter if needed. If impractical, generate Markdown first and mark schema JSON best-effort for MVP. | Medium - raw schema endpoints may be delayed or partial. |
| Checking generated docs into git is preferred. | User explicitly confirmed generated references should be checked in. | high | low | CI can validate with `pnpm docs:generate && git diff --exit-code`. | Low - main downside is generated file churn, which is accepted. |
| Public docs should not duplicate API/event/config/tool source-of-truth by hand. | `AGENTS.md` stresses centralized ownership for route contracts, event schemas, and integration surfaces; user priority is drift prevention. | high | low | Add docs generation/check scripts and keep generated references marked as generated/provenance-bearing. | High - duplicated hand-written reference docs would drift and undermine the feature. |

No low-confidence / high-impact assumptions remain unresolved. The highest-impact assumption is whether current imperative CLI/MCP/Pi declarations are easy enough to extract; confidence is medium, validation path is clear, and the plan includes a fallback of introducing small shared registries/adapters if needed.

## Scope

**MVP scope — In scope:**

- Add a `web/` public site, likely a Next.js app, deployable to Vercel at `eforge.build`.
- Human-facing landing page with:
  - eforge value proposition.
  - "What is eforge?" overview.
  - install paths for Claude Code, Pi, and standalone CLI.
  - links to docs, GitHub, and npm packages.
- Docs section sourced from Markdown/MDX.
- Agent-readable outputs:
  - `/llms.txt` - concise index of canonical docs and reference artifacts.
  - `/llms-full.txt` - concatenated agent-readable canonical docs bundle.
  - raw Markdown/reference routes where practical.
- Drift-preventing generated reference docs for:
  - CLI commands.
  - Daemon HTTP API routes/types.
  - Event protocol.
  - Config/profile schema.
  - MCP tools.
  - Pi/Claude integration command/skill surface.
- Add docs generation/check/build scripts, e.g.:
  - `pnpm docs:generate`
  - `pnpm docs:check`
  - `pnpm docs:build`
- Add CI-style validation so generated reference docs cannot silently drift from source code.

**Out of scope for MVP:**

- Full visual brand system.
- Blog/content publishing workflow.
- Auth/user accounts.
- Interactive hosted demos.
- Search beyond what the chosen docs framework provides cheaply.
- Automatically rewriting hand-written conceptual docs.
- Replacing all existing repo docs immediately.

**Boundary / principle:**

- The docs generator consumes existing code-owned contracts and emits reference artifacts. It must not introduce a parallel source of truth for CLI/API/event/config/tool contracts.

**Roadmap relation:**

- This refines the existing `docs/roadmap.md` Marketing Site item by making agent-readable docs and drift prevention first-class acceptance requirements rather than follow-up work.

## Acceptance Criteria

1. `web/` app exists and builds successfully.
2. Landing page explains eforge's value proposition and links to install/docs/source.
3. Docs section includes at least:
   - getting started.
   - concepts.
   - configuration.
   - generated reference index.
4. Agent-readable artifacts are published:
   - `/llms.txt`.
   - `/llms-full.txt`.
   - Reference Markdown outputs for CLI/API/events/config/tools.
5. Generated references are produced from implementation-owned sources, not hand-copied.
6. `pnpm docs:generate` updates/generated docs deterministically.
7. `pnpm docs:check` fails when generated docs are stale.
8. `pnpm docs:build` validates the public site build.
9. Root `package.json` exposes docs scripts.
10. Existing repository docs/README link to the new site or explain the relationship.
11. No daemon/API/event/config source of truth is duplicated in `web/` by hand.
12. CI/test coverage includes at least one drift-prevention check for generated docs.
13. Stable raw reference URLs exist for agents, at minimum:
    - `/reference/cli.md`.
    - `/reference/api.md`.
    - `/reference/events.md`.
    - `/reference/config.md`.
    - `/reference/tools.md`.
14. Machine-readable schema exports exist where source supports it, at minimum best-effort exports for:
    - `/schemas/events.schema.json`.
    - `/schemas/config.schema.json`.
    - Optional if straightforward: `/schemas/daemon-api.json`.
15. Every generated reference page includes provenance:
    - "Generated file. Do not edit."
    - source files used.
    - package version, commit, or generation metadata sufficient to diagnose drift.
16. `/llms.txt` is intentionally curated, not just a sitemap. It should summarize what eforge is, identify canonical docs, and link to raw references/schemas.
17. Local development is first-class:
    - `pnpm docs:dev` starts a local dev server for the site, after generating docs once.
    - It prints or uses a normal local URL such as `http://localhost:3000`.
    - It requires no daemon, no LLM credentials, and no Vercel setup.
    - A fresh checkout works because generated docs are checked in.
    - Generator watch mode is not required for MVP; rerunning `pnpm docs:generate` is acceptable after changing code-owned doc sources.
