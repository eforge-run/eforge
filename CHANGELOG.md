# Changelog

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

## [0.3.4] - 2026-04-03

### Features

- Filter eforge MCP servers and Pi extensions from build agents
- Add renderCall/renderResult to eforge_status tool
- Add eforge-plan skill for structured planning conversations
- Add eforge_confirm_build TUI tool to Pi extension
- Add Pi Package as architecture consumer

### Bug Fixes

- Use separate DynamicBorder instances for top and bottom borders in Pi package

### Documentation

- Note Pi-specific plan skill in README
- Add eforge-plugin / pi-package parity convention to AGENTS.md

## [0.3.3] - 2026-04-03

### Features

- Add Pi extension package with full eforge integration

### Bug Fixes

- Wire MCP tools through Pi backend and update Pi config guidance
- Style fallback swimlane labels as pills

### Maintenance

- Add name frontmatter to skills and configure Pi skill sharing

## [0.3.2] - 2026-04-02

### Features

- Evaluator Agent Continuation Support

### Bug Fixes

- Fix Evaluator Reset Target

## [0.3.1] - 2026-04-01

### Maintenance

- Update hero screenshot and remove slow flaky tests

## [0.3.0] - 2026-04-01

### Features

- Replace the simple one-shot gap closer with a multi-stage pipeline that assesses completion, gates on viability, and executes gap fixes through the existing build infrastructure
- Plan-Based Gap Closer Execution
- Enhanced PRD Validation Output and Viability Gate
- Automatic PRD Validation Gap Closing
- Structured Output and Pipeline Composer Agent
- Remove outputFormat from backend interface and switch pipeline composer to text-based JSON extraction
- Stage Registry with Rich Metadata
- Fix daemon stopping queue watch after build completion due to directory deletion, stale prdState cache, and missing watcher respawn logic
- Daemon Watcher Respawn and PRD Re-queue Support
- Queue Directory Preservation and fs.watch Recovery
- Apply transitive reduction at orchestration parse time and replace binary swimlane indentation with thread-line depth indicators
- Transitive Reduction in Orchestration Config Parsing
- Thread-Line Swimlane UI for Dependency Depth
- Integration and Profile System Removal
- Add dependency indicator to queue sidebar items
- Fix pipeline swimlane indentation

### Bug Fixes

- Fix PlanRow Swimlane Indentation
- Fix pipeline swimlane alignment and graph indentation
- Strip unsupported JSON Schema keys from pipeline composition schema
- Increase maxTurns for structured output cycle
- Enable tool preset when outputFormat requires structured output

---
For older releases, see [GitHub Releases](https://github.com/eforge-build/eforge/releases).

