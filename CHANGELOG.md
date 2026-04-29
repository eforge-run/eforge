# Changelog

## [0.7.6] - 2026-04-29

### Maintenance

- **profile-wiring**: floor plugin version assertion at 0.16.0

## [0.7.5] - 2026-04-29

### Maintenance

- **release**: rewrite plugin MCP proxy pin in lockstep with version

## [0.7.4] - 2026-04-29

Maintenance release

## [0.7.3] - 2026-04-28

### Features

- **consumers**: Rewrite init skill and tool API around multi-runtime profile input
- **core**: PRD Gap Close
- **fix-daemon-profile-routes-to-honor-user-scope-when-no-project-config-exists**: Daemon profile routes fall back to user scope when no project config
- **fix-eforge-init-fresh-project-bootstrap-ordering-bug**: Fix eforge_init fresh-init ordering across both consumers
- **fix-recovery-split-successor-prd-spurious-blocked-by-dependency**: Fix spurious depends_on on split-recovery successor PRDs
- **foundation**: Generalize createAgentRuntimeProfile, daemon route, API version
- **improve-eforge-init-quick-path-smarter-tier-defaults-per-harness**: Tier-aware Quick path in both init skills
- **offer-existing-user-scope-profiles-in-eforge-init**: Offer existing user-scope profiles in /eforge:init
- **redesign-eforge-init-around-multi-runtime-profiles**: Redesign /eforge:init around multi-runtime profiles: skill drives all elicitation, eforge_init becomes a pure persister, users pick quick (single-harness) or mix-and-match (per-tier) setup, and the engine helper accepts richer multi-runtime input.
- **replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack**: Rename backend → harness across MCP, HTTP, client types, engine helpers, and skills
- **sharded-builds-always-go-through-review-cycle-with-a-new-verify-perspective**: Verify perspective + coordinator rewire to review-cycle

### Bug Fixes

- **core**: change agents.tiers schema key from AgentTier to ModelClass
- **core**: resolve validation failures
- **core**: update stale test expectations after backend→harness rename
- **engine**: prepend postMergeCommands to shard verification

### Maintenance

- **daemon-recovery**: drop brittle DAEMON_API_VERSION assertion
- **deps**: bump pi-* to 0.70.6 and claude-agent-sdk to 0.2.122
- **verify-perspective-and-coordinator-rewire**: fix test issues

## [0.7.2] - 2026-04-28

### Features

- **core**: Close the recovery UX loop: add engine `applyRecovery()` with verdict dispatch (retry/split/abandon/manual), wire it through the daemon, shared client, and MCP/Pi tools, then add a `/recover` skill in both the Claude Code plugin and Pi extension plus verdict-specific action buttons inside the monitor UI's existing recovery sheet.
- **core**: PRD Gap Close
- **engine**: Engine applyRecovery + Daemon Route + MCP/Pi Parity
- **engine**: Inline atomic recovery sidecar + resilient recover()
- **engine**: Move Pi `provider` from per-model refs (`agents.models.<class>.provider`) to the agentRuntime entry (`agentRuntimes.<name>.pi.provider`). Hard removal of `provider` from `modelRefSchema`; required for `harness: pi` runtimes via schema-time `superRefine`.
- **engine**: Schema, resolver, and inline test fixtures
- **engine**: Sharded implement stage with stash-based per-shard retry
- **monitor-ui**: session:profile event end-to-end + inspectable profile badge
- **monitor-ui**: Surface planner output and persist plan strategy
- **plugin**: /recover Skill (Plugin + Pi) and Monitor UI Verdict Action Buttons
- **plugin**: Adaptive /eforge:plan workflow and /eforge:build readiness updates
- **plugin**: Skill doc updates and plugin version bump

### Bug Fixes

- **core**: handle session:profile event in CLI display switch
- **engine**: restore node:sqlite prefix stripped by esbuild
- **test**: provide StubHarness to EforgeEngine.create in apply-recovery tests

### Maintenance

- **engine**: fix test issues

## [0.7.1] - 2026-04-25

### Maintenance

- **deps**: bump pi-* packages to 0.70.2 (clears uuid <14 advisory GHSA-w5hq-g745-h8pq)

## [0.7.0] - 2026-04-25

### Features

- **add-a-tier-layer-above-agent-roles**: Add tier layer above agent roles
- **build-failure-recovery-agent**: Add advisory build-failure recovery analyst with sidecar verdicts and Pi/CLI/MCP parity
- **cli-and-engine-api**: CLI Subcommand + EforgeEngine.recover
- **config**: reject unrecognized top-level keys in config.yaml
- **core**: PRD Gap Close
- **daemon-mcp-pi**: Daemon Trigger + MCP Tool + Pi Parity
- **docs-sweep**: Documentation Terminology Sweep
- **engine-core**: Engine Core: Schema, Agent, Summary, Sidecar
- **event-id-renames**: Rename Event IDs Across Engine, Consumers, and Tests
- **finish-plan-04**: Finish Plan-04: Source Fix, Test Fixture Migration, New Tests, Plan-Load Validation
- **fix-planner-per-plan-build-review-stage-selection**: Pass per-plan build/review through planner submission
- **harness-rename**: Mechanical Rename: Backend -> Harness
- **http-route-client**: HTTP Route Rename + Client Helpers + DAEMON_API_VERSION Bump
- **make-orchestration-yaml-the-single-canonical-source-for-plan-dependencies**: Canonicalize plan deps in orchestration.yaml
- **monitor-ui**: Monitor UI: Verdict Chip + Sidecar Link
- **monitor-ui-session-rename**: Monitor-UI Session Backend to Harness Rename
- **pipeline-plan-dependency-depth-replace-indentation-with-vertical-guide-bars**: Replace depth indentation with vertical guide bars in thread-pipeline.tsx
- **profile-loader-mcp**: Profile Directory and Loader Rename + MCP Tool Rename
- **registry-pipeline**: Agent Runtime Registry + Engine + Pipeline Wiring
- **schema-resolver**: Config Schema + Resolver (Non-Breaking Additions)
- **slash-skills-plugin**: Slash Command Rename + Init Skill Update + Plugin Version Bump
- **surface-tiers-within-eforge-config**: Tier-aware /eforge:config skill bodies
- **wire-withhooks-into-daemon-s-in-process-auto-build-watcher**: Wire withHooks into daemon watcher

### Bug Fixes

- **complete-per-agent-runtime-configuration**: finish missed Pi extension renames
- **config**: merge agentRuntimes and defaultAgentRuntime in partial configs
- **core**: add thinkingLevel YAML comment to config skills
- **core**: resolve validation failures
- **prompts**: treat {{...}} in substituted values as literal text

### Maintenance

- **core**: remove mock-heavy Pi backend tests
- **core**: upgrade pi
- **core**: Upgrade deps
- **harness-rename**: add rename acceptance-criteria tests
- **monitor-ui**: add API route path hygiene grep assertion
- **registry-pipeline**: add dual-stub dispatch tests and fix Pi lazy-load test
- **schema-resolver**: fix two failing tests in agent-config.mixed-harness

## [0.6.4] - 2026-04-23

### Refactoring

- **compile**: split pipeline injection from expedition compiler

## [0.6.3] - 2026-04-23

### Bug Fixes

- **compile**: capture planner expedition modules from structured event

### Documentation

- **config**: scope config.yaml skill to team-wide settings

## [0.6.2] - 2026-04-23

### Features

- **add-session-scoped-model-registry-to-append-models-used-trailer-to-eforge-commits**: ModelTracker and Models-Used commit trailer
- **core**: PRD Gap Close
- **per-command-timeout-for-post-merge-validate-phase**: Per-command timeout for post-merge validate phase
- **sunset-legacy-eforge-yaml-and-monitor-lock-paths**: Sunset legacy eforge.yaml and monitor.lock paths

### Bug Fixes

- **engine**: emit terminal event when PRD validator crashes

### Documentation

- **eforge-release**: include package scope in changelog entries

### Maintenance

- **validate-command-timeout**: fix validate-phase timeout test

## [0.6.1] - 2026-04-23

### Features

- add searchable overlays for provider and model selection

## [0.6.0] - 2026-04-23

### Features

- Consolidate SSE subscription on @eforge-build/client
- Daemon API version negotiation
- Decompose pipeline.ts into a pipeline/ directory with named helpers, and declare @eforge-build/client public with a stability policy
- Decompose pipeline.ts into pipeline/ directory
- MCP tool factory + runOrDelegate helper + shared error formatting
- PRD Gap Close
- Declare @eforge-build/client public with stability policy
- Eliminate engine emission violations: remove console.* from packages/engine/src, route warnings through EforgeEvents, route commits through forgeCommit(), and make loadPrompt() throw on unresolved vars
- Replace engine console.* with warning events and warnings return shape
- loadPrompt() throws on unresolved template variables
- Route every engine commit through forgeCommit()
- Parent scheduler owns sessionId and emits session:start at spawn
- Central API_ROUTES contract and typed helper migration
- Add typed api helper files and missing request types
- Subprocess-per-build with crash-safe reconciler
- Raise builder turn budget to 80 and tighten batching guidance
- Unified retry policy for pipeline agents
- Revert Claude Code build skill to fire-and-forget
- Consolidate shared types and constants into @eforge-build/client
- Backend Common Helpers and Unified Usage Cadence
- Bring Claude Code plugin to parity with Pi extension: port eforge-plan skill, align paired-skill narrative, and add a parity-check script
- Align paired-skill narrative across plugin and Pi
- Migrate raw button/input to shadcn components
- Port plan skill to plugin and add parity-check script
- Lower default model class to balanced for builder/fixers/test agents
- Retry planner on dropped submission tool call

### Bug Fixes

- Resolve validation failures
- Add 'skipped' to EforgeResult status union type
- Hydrate event type from DB column and fix emission sites
- Locate CLI in daemon via EFORGE_CLI_PATH
- Rely on server status to detect session completion
- Kill watcher when auto-build toggled off

### Refactoring

- Use CircleStop icon for session cancel button
- Let build subprocesses drain on scheduler abort
- Run auto-build watcher in-process

### Other

- Upgrade deps

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

---
For older releases, see [GitHub Releases](https://github.com/eforge-build/eforge/releases).

