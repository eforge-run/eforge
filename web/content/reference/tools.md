<!-- Generated file. Do not edit. -->
<!-- eforge version: 0.7.12 -->
<!-- Commit: 92819a5c -->
<!-- Source: packages/eforge/src/cli/mcp-proxy.ts, packages/pi-eforge/extensions/eforge/index.ts, eforge-plugin/skills/, packages/pi-eforge/skills/ -->

# eforge MCP Tools and Skills Reference

eforge exposes its capabilities through two integration surfaces:
- **MCP tools** for the Claude Code plugin (`eforge-plugin/`)
- **Native Pi commands and tools** for the Pi extension (`packages/pi-eforge/`)

Both surfaces are kept in parity per `AGENTS.md`.

## MCP tools (Claude Code)

Total tools: 15

| Tool name | Description |
|-----------|-------------|
| `eforge_build` | Enqueue a PRD source for the eforge daemon to build. Returns a sessionId and autoBuild status. |
| `eforge_follow` | Follow a running eforge session: streams phase/files-changed/issue updates as progress notifications and returns the final session summary. Use after eforge_build to surface live build status in the conversation. |
| `eforge_auto_build` | Get or set the daemon auto-build state. When enabled, the daemon automatically builds PRDs as they are enqueued. |
| `eforge_status` | Get the current run status including plan progress, session state, event summary, and the daemon vs CLI version. |
| `eforge_queue_list` | List all PRDs currently in the eforge queue with their metadata. |
| `eforge_config` | Show resolved eforge configuration or validate eforge/config.yaml. Config merges three tiers: user (~/.config/eforge/config.yaml), project (eforge/config.yaml), and project-local (.eforge/config.yaml, gitignored). Pass verbose: true with action "show" to see per-tier file presence. |
| `eforge_profile` | Manage named profiles in eforge/profiles/ (project), .eforge/profiles/ (local, gitignored), or ~/.config/eforge/profiles/ (user). Actions: "list" enumerates profiles and reports which is active; "show" returns the resolved active profile; "use" writes the active-profile marker to switch profiles; "create" writes a new profile (pass `agents.tiers` with self-contained tier recipes); "delete" removes a profile (refuses when active unless force: true). |
| `eforge_models` | List providers or models available for a given harness. Actions: "providers" returns provider names (claude-sdk is implicit / returns []); "list" returns models, optionally filtered to a single provider, newest-first. |
| `eforge_daemon` | Manage the eforge daemon lifecycle: start, stop, or restart the daemon. |
| `eforge_init` | Initialize eforge in a project. The skill is responsible for picking harness/model/effort per tier interactively; the tool is a pure persister. Pass `profile.tiers` with one self-contained recipe per tier (planning/implementation/review/evaluation). Each tier carries its own harness + model + effort. |
| `eforge_recover` | Trigger failure recovery analysis for a failed build plan. Spawns the recovery agent as a background subprocess and returns its sessionId and pid. |
| `eforge_read_recovery_sidecar` | Read the recovery analysis sidecar files for a failed build plan. Returns both the markdown summary and the structured JSON verdict produced by the recovery agent. |
| `eforge_apply_recovery` | Apply the recovery verdict for a failed build plan: requeue (retry), enqueue successor (split), or archive (abandon). |
| `eforge_playbook` | Manage playbooks in eforge. Actions: "list" returns all playbooks with source and shadow chain; "show" returns a single playbook's frontmatter and body; "save" validates and writes a playbook to the target tier; "enqueue" loads a playbook and enqueues it as a PRD, optionally chained after another queue entry; "promote" moves a playbook from project-local (.eforge/playbooks/) to project-team (eforge/playbooks/); "demote" reverses a promote; "validate" checks a raw Markdown playbook string without writing. |
| `eforge_session_plan` | Manage session plans in eforge. Actions: "list-active" returns all active (planning/ready) session plans; "show" returns a single session plan's data and readiness detail; "create" creates a new session plan file; "set-section" writes a dimension section to the session file; "skip-dimension" records a skipped dimension with a reason; "set-status" updates the session plan status (e.g. to "ready" or "abandoned"); "select-dimensions" sets planning type and depth and populates the required/optional dimension lists from the work-type playbook; "readiness" checks whether all required dimensions are covered; "migrate-legacy" converts a legacy boolean-dimensions session file to the current shape. Pass open: true on "create" or "show" to best-effort open the session plan file in the default application. |

## Native tools (Pi extension)

Total tools: 16

| Tool name | Description |
|-----------|-------------|
| `eforge_build` | Enqueue a PRD source for the eforge daemon to build. Returns a sessionId and autoBuild status. |
| `eforge_follow` | Follow a running eforge session: streams phase/files-changed/issue updates as tool progress messages and returns the final session summary. Use after eforge_build to surface live build status in the conversation. |
| `eforge_status` | Get the current run status including plan progress, session state, event summary, and the daemon vs Pi-extension version. |
| `eforge_queue_list` | List all PRDs currently in the eforge queue with their metadata. |
| `eforge_config` | Show resolved eforge configuration or validate eforge/config.yaml. |
| `eforge_profile` | Manage named profiles in eforge/profiles/. Actions: "list" enumerates profiles and reports which is active; "show" returns the resolved active profile with harness; "use" writes eforge/.active-profile to switch profiles; "create" writes a new eforge/profiles/<name>.yaml; "delete" removes a profile (refuses when active unless force: true). |
| `eforge_models` | List providers or models available for a given harness. Actions: "providers" returns provider names (claude-sdk is implicit / returns []); "list" returns models, optionally filtered to a single provider, newest-first. |
| `eforge_daemon` | Manage the eforge daemon lifecycle: start, stop, or restart the daemon. |
| `eforge_auto_build` | Get or set the daemon auto-build state. When enabled, the daemon automatically builds PRDs as they are enqueued. |
| `eforge_init` | Initialize eforge in a project. The skill is responsible for picking provider/model interactively; the tool is a pure persister. Pass `profile` with the assembled multi-runtime spec (every runtime must use harness: 'pi'). With migrate: true, extracts legacy harness config from a pre-overhaul config.yaml. |
| `eforge_confirm_build` | Present an interactive TUI overlay for the user to confirm, edit, or cancel a build source before enqueuing. Returns the user's choice. |
| `eforge_recover` | Trigger failure recovery analysis for a failed build plan. Spawns the recovery agent as a background subprocess and returns its sessionId and pid. |
| `eforge_read_recovery_sidecar` | Read the recovery analysis sidecar files for a failed build plan. Returns both the markdown summary and the structured JSON verdict produced by the recovery agent. |
| `eforge_apply_recovery` |  |
| `eforge_playbook` | Manage playbooks in eforge. Actions: "list" returns all playbooks with source and shadow chain; "show" returns a single playbook's frontmatter and body; "save" validates and writes a playbook to the target tier; "enqueue" loads a playbook and enqueues it as a PRD, optionally chained after another queue entry; "promote" moves a playbook from project-local (.eforge/playbooks/) to project-team (eforge/playbooks/); "demote" reverses a promote; "validate" checks a raw Markdown playbook string without writing. |
| `eforge_session_plan` | Manage session plans in eforge. Actions: "list-active" returns all active (planning/ready) session plans; "show" returns a single session plan's data and readiness detail; "create" creates a new session plan file; "set-section" writes a dimension section to the session file; "skip-dimension" records a skipped dimension with a reason; "set-status" updates the session plan status (e.g. to "ready" or "abandoned"); "select-dimensions" sets planning type and depth and populates the required/optional dimension lists from the work-type playbook; "readiness" checks whether all required dimensions are covered; "migrate-legacy" converts a legacy boolean-dimensions session file to the current shape. Pass open: true on "create" or "show" to best-effort open the session plan file in the default application. |

## Skill surfaces

Slash-command skills for Claude Code (plugin) and Pi are kept in parity.
Source of truth: `scripts/check-skill-parity.mjs`.

| Skill (Claude Code `/eforge:<name>`) | Skill (Pi `eforge:<name>`) | Description |
|--------------------------------------|---------------------------|-------------|
| `profile` | `eforge-profile` | List, inspect, and switch agent runtime profiles |
| `profile-new` | `eforge-profile-new` | Create a new agent runtime profile in eforge/profiles/ |
| `build` | `eforge-build` | Enqueue a source for the eforge daemon to build via MCP tool |
| `config` | `eforge-config` | Initialize or edit eforge/config.yaml team-wide settings, with validation via MCP tool |
| `init` | `eforge-init` | Initialize eforge in the current project with an interactive setup form |
| `plan` | `eforge-plan` | Start or resume a structured planning conversation for changes to be built by eforge. Classifies work type and depth, selects relevant dimensions from a per-type playbook, captures acceptance criteria, and produces a session plan that /eforge:build enqueues. |
| `restart` | `eforge-restart` | Safely restart the eforge daemon, checking for active builds first |
| `status` | `eforge-status` | Check eforge run status and queue state via MCP tools |
| `update` | `eforge-update` | Check for eforge updates and guide through updating the CLI package, daemon, and plugin |
| `playbook` | `eforge-playbook` | Create, edit, run, list, and promote eforge playbooks — reusable recurring-workflow templates |
| `recover` | `eforge-recover` | Inspect the recovery verdict for a failed PRD and apply the recommended action (retry, split, or abandon) |
