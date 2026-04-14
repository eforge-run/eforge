# Changelog

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

## [0.2.7] - 2026-04-01

### Features

- eforge_init MCP Tool with Elicitation
- Remove build.parallelism, autoRevise, prdQueue.parallelism config fields; add top-level maxConcurrentBuilds with default 2
- Remove config fields, add maxConcurrentBuilds, update all consumers and tests
- Fix parallel PRD event isolation
- Add missing agent roles to config docs
- Update architecture.md with missing agents, events, and plugin communication

### Bug Fixes

- Don't auto-start daemon from resource handlers
- Preserve existing config, smart postMergeCommands, gitignore fix

### Documentation

- Split CLAUDE.md into cross-tool AGENTS.md
- Trim redundancy from README and rewrite CLAUDE.md for lean agent guidance
- Add plugin candidate skill strategy and first candidate skill
- Update Integration & Maturity section

### Maintenance

- Remove duplicate init PRDs and stale locks

## [0.2.6] - 2026-03-31

### Features

- Pipeline Label Redesign
- Replace poll-sleep queue watcher with fs.watch-based event-driven queue manager for immediate PRD discovery and slot filling
- fs.watch Watcher and Daemon Integration
- Event Types and Mid-Cycle Discovery
- Real-time Agent Usage Events and Monitor Integration
- Switch Pi Backend to File-Backed AuthStorage
- Remove PRD status field and add file-location state helpers
- Build Failure Banner Component
- Add Build Metrics to Summary Cards
- Fix PRD cleanup path resolution
- Replace fragile git-query-time diff resolution with capture-at-source pattern
- Monitor Diff Storage and Simplified Endpoint
- Engine Diff Capture and Config
- Trim CLAUDE.md bloat and add documentation hierarchy guidance
- Fix merge commit scope and move cleanup to feature branch
- Document parallelism configuration
- Fix tester commit prefix and switch to --no-ff merge strategy
- Periodic File Heatmap Updates During Build Stages
- Greedy Queue Scheduler and CLI Flag
- Config, Pipeline Registration, and Dependency Detector Agent
- Add Artifacts Strip Component
- Restore Review Fixer with Corrected Reviewer Prompt
- Add PRD Validation Gate
- Fix Review Cycle - Give Reviewer Tools and Remove Review-Fixer
- Rewrite eforge-release skill with release notes and release type

### Bug Fixes

- Resolve validation failures
- Reactive Plan Artifacts with Pill Chips
- Add test coverage for greedy queue scheduler
- Add dependency detector agent wiring tests

### Maintenance

- Post-parallel-group auto-commit
- Set PRD queue parallelism to 2
- Add recorder diff extraction coverage
- Add coverage for captureFileDiffs and monitor config
- Bump @modelcontextprotocol/sdk to ^1.29.0
- Add changelog to release process
