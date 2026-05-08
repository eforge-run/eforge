# Changelog

## [0.7.12] - 2026-05-07

### Features

- **core**: Add typed orchestrator-decision events to the eforge wire protocol, emit them at every build-phase orchestrator decision site, render them in the monitor UI, and keep the Pi extension passing them through cleanly. Build-phase only; plan-phase decisions deferred to a follow-up roadmap item.
- **core**: Auto-open session plan markdown on create and resume
- **core**: Decision-event wire protocol, engine helper, and reducer foundation
- **core**: Engine emission sites, monitor-UI rendering, and integration tests
- **core**: Per-build profile override via --profile flag (CLI + MCP) with PRD-frontmatter persistence
- **core**: Planning decision events: wire, engine, and UI
- **core**: PRD Gap Close
- **core**: Remove autoAcceptBelow severity filter from config, schema, engine, UI, and tests
- **core**: require assumption validation in session plans
- **core**: Scope per-reviewer hover to perspective-specific issues in monitor UI
- **core**: Two related review-cycle cleanups: (1) remove the unused autoAcceptBelow severity filter from config/schema/engine/UI/tests; (2) fix the monitor UI so each reviewer's hover shows only that reviewer's perspective-scoped issues while the fixer hover continues to show the merged-and-deduped set.

### Bug Fixes

- **core**: resolve validation failures

### Documentation

- **roadmap**: add Orchestrator Intelligence section
- **roadmap**: refine orchestrator decision events scope

### Maintenance

- **core**: remove failed-queue sidecars after manual recovery

### Other

- **core**: add scripts

## [0.7.11] - 2026-05-06

### Features

- **core**: Add a structured daemon:* event family (lifecycle, scheduler decisions, recovery, orphan reaping, auto-build, errors) plus a live-only heartbeat, and surface them in the monitor UI via a header status pill and activity drawer
- **core**: Auto-build slice in useEforgeEvents reducer
- **core**: Close spine AC shortfalls — lifecycle events, thinking format, regression gate
- **core**: Daemon event types + monitor emission + heartbeat transport
- **core**: Daemon run-state events for monitor live/snapshot parity
- **core**: Daemon SSE skip-history + UI re-seed on reconnect
- **core**: Daemon-events SSE endpoint and client primitive
- **core**: Delete invalidateOnEvent SSE-to-SWR bridge
- **core**: earlyOrchestration as the sole orchestration source
- **core**: Engine-owned structural fields in orchestration.yaml
- **core**: Event metadata registry
- **core**: Fix daemon liveness pill on first load and drop redundant connected indicator
- **core**: Fix Re-queue PRD no-op and post-restart sidecar regression
- **core**: Lifecycle events + Zod schemas
- **core**: Make events the single source of truth for eforge runtime state
- **core**: Migrate consumers to subscribeWithSnapshot and retire v18 mechanisms
- **core**: Monitor UI: daemon status pill and activity drawer
- **core**: Monitor UI: pipeline render-gate fix and validation-command timeline bars
- **core**: PRD Gap Close
- **core**: Pure-event reducer + acceptance gate
- **core**: Remove singleton state.json/event-log.jsonl persistence and make compile/build handoff deterministic
- **core**: Replace fs.watch with event-driven QueueScheduler
- **core**: Replace v18 daemon:resync-marker and on-connect heartbeat with a designed-in stream:hello SSE handshake primitive used uniformly by every SSE consumer (per-session and daemon-wide)
- **core**: Scheduler decision events with dedup
- **core**: Simplify the monitor UI's event-consumption architecture to two SSE subscribers (one per concern) backed by reducers, eliminating the SSE-to-SWR bridge that has been the source of recurring swimlane and orchestration bugs
- **core**: Single mutation entry point
- **core**: Single-source RunInfo / QueueItem / SessionMetadata / AutoBuildState
- **core**: Surface build-config validation failures and inject valid perspectives into planner prompts
- **core**: Synthesize earlyOrchestration on planning:complete and event-driven SWR revalidation
- **core**: Tighten review-perspective schema and surface parallel-reviewer failures
- **core**: useDaemonEvents hook + UI consumer migration
- **core**: W6 daemon mutation sweep and enqueue:complete typed-field cleanup
- **monitor-ui**: pack validation spans into shared lanes
- **status**: surface daemon vs CLI version mismatch in eforge_status

### Bug Fixes

- **core**: Remove auto-clear useEffect from monitor UI app.tsx
- **core**: resolve validation failures
- **core**: supply required schema fields in daemon-sse-handshake test
- **core**: update DAEMON_API_VERSION test expectation to v18
- **engine**: raise reviewer turn budget

### Documentation

- **core**: sync documentation with implementation
- **docs**: frame pipeline through harness engineering

### Maintenance

- **core**: drop stale plan-02 wiring tests that grep source-text rather than verify behavior
- **monitor-ui**: add gap-proof tests for orchestration data drop on planning:complete
- **queue**: revise stale PRDs for w6 mutation sweep, SSE replay, and re-queue regression

### Other

- **core**: improve pi extension status line
- **core**: make sidebar full vertical height
- **core**: update planning skills

## [0.7.10] - 2026-05-04

### Features

- **eforge-init**: accept local-scope existing profiles and discover via sentinel

### Documentation

- **core**: tighten README intro and refresh execution examples

## [0.7.9] - 2026-05-03

### Features

- **core**: Collapse eforge agent configuration to a single tier axis: each tier is a self-contained recipe of harness + model + effort; eliminates ModelClass, agentRuntimes, and engine-supplied defaults
- **core**: Correct doc drift in README and docs/
- **core**: Extract playbook and session-plan logic from engine into new @eforge-build/input package, and extract scope/path resolution into new @eforge-build/scopes package
- **core**: Per-model-class agent runtime wizard
- **core**: Session-plan tools and API: daemon HTTP routes, typed client helpers, MCP/Pi tools, and skill updates so /eforge:plan and /eforge:build use shared @eforge-build/input helpers
- **engine**: list Pi custom providers/models via ModelRegistry
- **engine**: Split doc-updater into doc-author and doc-syncer
- **monitor-ui**: Adopt SWR cache layer; delete useApi and refreshTrigger chain
- **monitor-ui**: Decompose reducer.ts into typed per-group handlers, split thread-pipeline god-file, apply React.memo, and add reducer tests with regression fixtures
- **monitor-ui**: Monitor UI debt cleanup: client-owned wire types, dead code removal, cast and frontmatter fixes
- **monitor-ui**: Surface tier and reviewer perspective on agent:start
- **pi-eforge**: Replace presets with session-aware Copy from <tier> options

### Bug Fixes

- **core**: rename Agent Runtime Profiles section to Backend Profiles in docs/config.md
- **core**: resolve validation failures
- **core**: resolve validation failures in skills-docs-wiring tests

### Documentation

- **core**: author documentation
- **core**: sync documentation with implementation
- **playbook**: add docs implementation sync playbook

### Maintenance

- **core**: fix stale skills-docs-wiring test assertions
- **deps**: bump yaml to 2.8.4 and zod to 4.4.2
- **deps**: update package dependencies
- **monitor-ui**: add perspective coverage

## [0.7.8] - 2026-04-30

### Features

- **core**: Add commitEnqueuedPrd helper and adopt at both enqueue paths
- **core**: Add project-local config tier (.eforge/) to eforge
- **core**: Add Welcome Section to Init Skills
- **core**: Cancel button confirmation + global pointer cursor
- **core**: CLI and MCP proxy exit handlers
- **core**: CLI: eforge playbook commands and eforge play shortcut
- **core**: Close plugin/Pi parity gaps and extend parity script
- **core**: Daemon HTTP routes, client helpers, and MCP tool registration
- **core**: Decouple failed-PRD discovery from session state
- **core**: Disable auto-build on first failed queue:prd:complete
- **core**: Engine: generalized set-artifact resolver and playbook API
- **core**: Isolate user-tier config in vitest via XDG_CONFIG_HOME
- **core**: Phase 2: piggyback scheduling and queue-list nesting
- **core**: PRD Gap Close
- **core**: Skills: /eforge:playbook handheld UX in Claude Code plugin and Pi extension
- **core**: Structured plan-review fix submissions
- **eforge-playbooks**: add plugin/pi parity audit playbook
- **eforge-playbooks**: Codify recurring change shapes as named, three-tier playbooks (user / project-team / project-local) invokable via a handheld /eforge:playbook skill, CLI, and daemon HTTP. Phase 1 ships authoring + direct invocation; Phase 2 ships piggyback scheduling so a playbook auto-fires after a chosen build completes.
- **engine**: raise planner maxTurns default to 80

### Bug Fixes

- **core**: disable FK enforcement in DatabaseSync to allow daemon-level events
- **core**: resolve validation failures

### Maintenance

- **core**: post-parallel-group auto-commit

## [0.7.7] - 2026-04-29

### Bug Fixes

- **config**: strict schema validation; reject modelClass-keyed agents.tiers

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

---
For older releases, see [GitHub Releases](https://github.com/eforge-build/eforge/releases).

