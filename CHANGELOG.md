# Changelog

## [0.5.12] - 2026-04-21

### Features

- **pi-follow-parity:** Pi extension parity: eforge_follow tool and command wiring
- **mcp-follow-tool:** Add eforge_follow MCP tool and deprecate logging forwarder
- **client-subscribe-helper:** Extract subscribeToSession helper into @eforge-build/client

### Maintenance

- remove merged PRD from queue/failed

## [0.5.11] - 2026-04-21

### Features

- **fix-planner-submission-tools-on-the-pi-backend:** Backend-aware submission tool naming and Pi 0.68 ToolDefinition conformance

### Bug Fixes

- **engine:** register custom tools in Pi session allowlist and retry-frame submission validation errors

### Maintenance

- **deps:** bump pi packages to 0.68.0 and adapt backend

## [0.5.10] - 2026-04-21

### Features

- prevent eforge recursion in agent contexts
- add debug-composer CLI and backend debug payload capture
- add claudeSdk.disableSubagents config option

### Maintenance

- bump pi packages, claude-agent-sdk, and marked

## [0.5.9] - 2026-04-17

### Features

- Opus 4.7 Per-Role Effort Defaults, Capability Split, and Thinking Coercion
- Fix consumer-facing docs drift around Pi thinking levels and effort levels, then implement native Pi command UX for backend, backend:new, and config flows with module extraction, ambient status, and architecture docs updates.
- PRD Gap Close
- Native Pi command UX, module extraction, and ambient status
- Fix consumer-facing docs and skills enum drift
- Effort and Thinking Provenance Tracking
- Backend profile overhaul: schema, resolver, init handlers, Pi footer, docs, and tests
- Widen effort schema to include xhigh for Opus 4.7, fix Pi backend mappings to cover full range, add data-driven model-capability map with clamping, enable planner to emit per-plan effort/thinking overrides in plan frontmatter, integrate overrides into resolveAgentConfig with precedence and clamping, enrich agent:start events with resolved effort/thinking/source, and surface all runtime decisions in the monitor UI tooltip.
- Monitor UI - Surface Effort/Thinking in Stage Hover
- Runtime Per-Plan Override + Clamping + Event Enrichment + Planner Prompt
- Schema Widening + Backend Mappings + Model Capability Map

### Bug Fixes

- guard against daemon auto-spawn inside agent worktrees
- isolate user-scope config in backend profile tests

### Maintenance

- add tests for native Pi UX, monitor UI, and schema capabilities
- include git sha and dirty flag in build version
- post-parallel-group auto-commit for schema handlers tests

### Other

- update readme
- migrate config
- re-enqueue failed build
- remove project backends in favor of user scoped

## [0.5.8] - 2026-04-17

### Features

- Add user-scope backend profiles alongside project scope, with 5-step resolution precedence, scope selector in MCP/Pi tools, and skill/doc updates.
- PRD Gap Close
- Skills, Documentation, and Plugin Version Bump
- MCP Tool, Pi Extension, and Wiring Tests
- Core Engine, Client Types, and Daemon HTTP

### Bug Fixes

- Detect build:failed in launchPlan and propagate failure

### Maintenance

- bump pi-ai to 0.67.6 and claude-agent-sdk to 0.2.112

### Other

- revert to Opus 4.6

## [0.5.7] - 2026-04-16

### Features

- Arbitrary-named backend profiles in `eforge/backends/*.yaml`, gitignored `.active-backend` marker, and an LLM-guided creator skill that uses pi-ai's model registry to walk users through defining new profiles
- Add `eforge_backend` (list/show/use/create/delete) and `eforge_models` (providers/list) MCP tools with matching daemon endpoints and parity across Claude Code plugin + Pi extension
- Pick model per class (max/balanced/fast) in interactive backend-new flow
- Engine backend profile loader, models adapter, daemon endpoints, and client types
- MCP tools, skills for both integrations, init updates, plugin version bump
- PRD Gap Close

### Maintenance

- Add claude-sdk backend profile

## [0.5.6] - 2026-04-16

### Documentation

- clarify excursion vs expedition scope guidance

## [0.5.5] - 2026-04-16

### Features

- Add configFound boolean to validate API, update build/status skills with missing-config guidance, and add Related Skills cross-reference tables to all 13 eforge skill files
- Add Related Skills tables to remaining skill files and bump plugin version
- Add configFound field to engine and client types

### Bug Fixes

- propagate validator errors and carry prior output on composer retry

### Maintenance

- bump max model class default to claude-opus-4-7
- bump pi SDK and agent dependencies

## [0.5.4] - 2026-04-15

### Features

- Fail-fast on unreachable model backend
- Replace N-Write-calls planner pattern with structured submission tools that validate and persist plan payloads engine-side
- PRD Gap Close
- Planner Agent Submission Tool Integration
- Submission Tool Foundation
- add pnpm release script for lockstep version bumps

### Bug Fixes

- register planner submission tools via SDK MCP server
- reduce SQLITE_BUSY errors under concurrent writes

### Refactoring

- introduce typed AgentTerminalError for SDK failures

### Documentation

- sharpen tagline and add "Why eforge" section

### Maintenance

- fix stale planner wiring tests
- post-parallel-group auto-commit

## [0.5.3] - 2026-04-13

### Features

- Rename eforge-pi package to pi-eforge

## [0.5.2] - 2026-04-13

### Features

- Global cap + validator read affordance
- Per-file budgeted PRD validator diff

## [0.5.1] - 2026-04-13

### Features

- engine: add prompt customization via promptDir and per-role promptAppend
- fix build phase crash when planner generates 0 plans

### Bug Fixes

- remove prd-passthrough compile stage so planner always runs for codebase-aware skip detection

### Maintenance

- fix test assertions for plan:skip on 0 plans

## [0.5.0] - 2026-04-11

### Features

- usage-normalization: shared usage normalization helper for Pi backend (fixes cached % > 100%)

### Bug Fixes

- cli: resolve monitor server-main via import.meta.resolve

### Maintenance

- publish: publish workspace packages in lockstep via pnpm -r

## [0.4.3] - 2026-04-11

### Bug Fixes

- engine: avoid re-running compile stage after composer shrinks list

## [0.4.2] - 2026-04-11

### Bug Fixes

- engine: use ModelRegistry.create factory in PiBackend

### Maintenance

- deps: bump pi-ai, monitor-ui, and dev tooling

## [0.4.1] - 2026-04-10

### Features

- Restructure into workspace packages and migrate to @eforge-build/* scope
- Create @eforge-build/client package and migrate callers
- Add pi-package to workspace and migrate Pi extension
- Extract @eforge-build/client package to eliminate duplication
- Remove dead endpoints and update documentation
- Documentation, plugin, and skill updates
- Publish pi-package as eforge-pi to npm

### Bug Fixes

- Align CI workflow with publish-all script
- Resolve server-main entry via relative URL
- Tolerate first-time publish in verify and deprecate steps
- Complete monorepo gaps and fix validation pipeline
- Resolve validation failures

### Documentation

- Rescope plugin-engine version compatibility to minimal observability
- Prune shipped and decided items from roadmap

### Maintenance

- Add unified publish-all script
- Bundle @eforge-build/client into eforge-pi tarball
- Bundle @eforge-build/* workspace packages into executables
- Remove one-time deprecate step from publish-all

## [0.3.8] - 2026-04-04

### Bug Fixes

- Use value equality for compile loop restart detection

### Documentation

- Refine README project description and review rationale

## [0.3.7] - 2026-04-04

### Bug Fixes

- Planner guard and compile loop reset
- Dirty working tree detection, recovery, and merge hardening

### Features

- Buffer verbose agent streaming output

### Other

- Upgrade deps

## [0.3.6] - 2026-04-03

### Features

- Emit and consume gap_close:plan_ready event

### Bug Fixes

- Resolve model config for eforge-level agents

### Refactoring

- Move Changes/Graph into lower panel with DevTools-style tabs

### Documentation

- Remove stale "default backend" and "experimental" labels

## [0.3.5] - 2026-04-03

### Features

- Redesign eforge model configuration so model references are backend-aware objects instead of plain strings
- Right-size default model classes per agent role with ascending-then-descending fallback chain

### Bug Fixes

- Guard plan artifact commits against empty staging area
- Fix crash when orchestration.yaml is missing in plannerStage
- Fix pi eforge build skill to do the right thing

### Maintenance

- Ignore tmp directory

---
For older releases, see [GitHub Releases](https://github.com/eforge-build/eforge/releases).

