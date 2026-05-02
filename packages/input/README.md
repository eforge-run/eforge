# @eforge-build/input

Reusable build-input protocols for eforge - playbook and session-plan artifacts that compile to ordinary build source.

## Consumers

- `@eforge-build/monitor` - daemon playbook routes and `normalizeBuildSource` for session-plan source paths before enqueue
- `@eforge-build/eforge` - in-process normalization for CLI build commands that accept session plans or playbooks as input
- Future wrapper apps that need to compile playbooks or session plans to build source independently of the daemon

## Dependencies

- Depends on `@eforge-build/scopes` for scope directory lookup and named-set resolution
- Does **NOT** depend on `@eforge-build/engine`

The engine consumes normalized PRD/build source; it has no knowledge of where that source originated. This keeps the engine input-agnostic.

## What's included

### Playbooks

Playbooks are Markdown files with YAML frontmatter encoding a reusable build intent. They resolve across all three scope tiers via `@eforge-build/scopes` named-set resolution.

- `parsePlaybook(content)` - parse a playbook Markdown file
- `serializePlaybook(playbook)` - serialize a playbook to Markdown
- `validatePlaybook(playbook)` - validate playbook structure
- `listPlaybooks(opts)` - list all playbooks across scope tiers with shadow annotations
- `loadPlaybook(name, opts)` - load the highest-precedence playbook by name
- `writePlaybook(playbook, opts)` - write a playbook to a scope directory
- `movePlaybook(name, opts)` - move a playbook between scope tiers
- `copyPlaybookToScope(name, opts)` - copy a playbook to a target scope
- `playbookToBuildSource(playbook)` - compile a playbook to ordinary build source for the engine queue
- `playbookToSessionPlan(playbook)` - deprecated alias for `playbookToBuildSource`

### Session plans

Session plans are Markdown files in `.eforge/session-plans/` that accumulate decisions during a structured `/eforge:plan` conversation. They are project-local only and compile to ordinary build source.

- `parseSessionPlan(content)` - parse a session plan Markdown file
- `serializeSessionPlan(plan)` - serialize a session plan to Markdown
- `listActiveSessionPlans(opts)` - list all active (non-archived) session plans in the project-local scope
- `selectDimensions(plan, choices)` - record planning dimension selections on a session plan
- `checkReadiness(plan)` - check whether a session plan has enough information to compile
- `migrateBooleanDimensions(plan)` - migrate legacy boolean dimension format to the current schema
- `sessionPlanToBuildSource(plan)` - compile a session plan to ordinary build source for the engine queue

### Boundary normalization

- `normalizeBuildSource(input)` - single chokepoint for session-plan handling: if a source path matches `**/.eforge/session-plans/*.md`, parses the plan and converts it to ordinary build source; other paths pass through unchanged

The matcher contract is `**/.eforge/session-plans/*.md`. Paths that do not match this pattern are returned unchanged.

## Boundary

This package compiles input artifacts (playbooks, session plans) to ordinary build source. The engine consumes that source and has no dependency on `@eforge-build/input`. See [docs/architecture.md](../../docs/architecture.md) for the full package dependency diagram.

## Out of scope

- No daemon HTTP client - use `@eforge-build/client` for daemon-backed flows
- No engine queue knowledge - this package normalizes input before the engine sees it
- No new CRUD or tool API surface - wire-protocol additions belong in `@eforge-build/client`
- No conversational planning logic - the `/eforge:plan` skill owns structured planning conversations

## Stability

- Public exports are stability-promised within a major version.
- Breaking changes bump the major version and are noted in the release.
