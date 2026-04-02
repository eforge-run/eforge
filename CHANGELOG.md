# Changelog

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
