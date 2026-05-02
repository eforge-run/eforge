# Documentation Boundary Hardening

## Architecture Reference

This module implements the [Documentation Impact](#) section of the source PRD and the corresponding "Quality Attributes > Doc accuracy" requirement of the architecture document. The architecture explicitly assigns the following files to this module in its Shared File Registry:

- `README.md` — reposition input vs engine
- `docs/architecture.md` — new package boundary section
- `docs/config.md` — scope semantics + layered singleton vs named set
- `docs/roadmap.md` — wrapper-app guardrail
- `packages/scopes/README.md` — scope semantics and lookup primitives
- `packages/input/README.md` — playbook + session-plan input protocols

This module runs **after** `daemon-cli-wiring`, so by the time it executes:

- `@eforge-build/scopes` exists with `getScopeDirectory`, `resolveLayeredSingletons`, `resolveNamedSet`, `listNamedSet`, and a canonical `Scope` / `SCOPES` export.
- `@eforge-build/input` exists and owns playbook code (moved from engine), session-plan deterministic logic, and `normalizeBuildSource`.
- `@eforge-build/engine` no longer owns `playbook.ts` or `set-resolver.ts`; it depends on `@eforge-build/scopes` for scoped file lookup.
- `@eforge-build/monitor` daemon routes call into `@eforge-build/input` for playbook routes and `normalizeBuildSource` for session-plan source paths.
- CLI/Pi/plugin user-facing behavior is unchanged on the wire.

Key constraints from the architecture:

- Engine MUST NOT depend on `@eforge-build/input`. The architecture document must state this dependency direction explicitly.
- Scopes is generic and low-level (no schema, no daemon, no queue); engine retains config domain semantics (`mergePartialConfigs`, profile schema validation, active-profile semantics, `resolveConfig`).
- Session-plan support is deterministic library + boundary normalization, NOT full CRUD; conversational `/eforge:plan` workflow remains in skill prompts.
- No backward-compatibility cruft — internal callers are updated cleanly; docs reflect the end state, not migration shims.
- Wrapper-app boundary stays explicit: scheduling, triggers, approvals, notifications, and richer workflow orchestration belong in wrapper apps built on stable eforge APIs, not in the engine. The roadmap must carry this guardrail.

## Scope

### In Scope

- Update `README.md` to describe playbooks and session plans as reusable input-layer artifacts that compile to ordinary build source, not engine workflow features.
- Update `docs/architecture.md` with a new package-boundary section that names every workspace package, lists allowed dependency edges, and states `engine ↛ input` explicitly. Update the `System Layers` mermaid diagram to include `@eforge-build/scopes` and `@eforge-build/input` as packages.
- Update `docs/config.md` `Config Layers` and related sections to describe canonical scope names (`user`, `project-team`, `project-local`), reference the `@eforge-build/scopes` package as the implementation source, and distinguish layered-singleton lookup (`config.yaml`) from named-set resolution (`profiles/`, `playbooks/`) and project-local-only state (`session-plans/`).
- Update `docs/roadmap.md` to add an explicit guardrail under "Integration & Maturity" stating that scheduling, triggers, approvals, notifications, and richer workflow orchestration belong to wrapper apps built on stable eForge APIs, not engine/core eForge.
- Author `packages/scopes/README.md` documenting canonical scope names, directories, precedence (`project-local > project-team > user`), the two lookup primitives (named-set resolution and layered-singleton lookup), and the explicit "out of scope" boundary (no schema, no daemon, no queue, no engine concepts).
- Author `packages/input/README.md` documenting playbook input protocol, session-plan deterministic helpers, `normalizeBuildSource` boundary helper, the dependency on `@eforge-build/scopes`, and the explicit "out of scope" boundary (no daemon HTTP client, no engine queue knowledge, no new CRUD/tool API surface, no conversational planning logic).

### Out of Scope

- Editing source code, tests, or wire types in `@eforge-build/scopes`, `@eforge-build/input`, `@eforge-build/engine`, `@eforge-build/monitor`, `@eforge-build/eforge`, `@eforge-build/pi-eforge`, or `eforge-plugin`. Any code change required for documentation accuracy is the responsibility of the upstream module that landed first.
- Authoring or updating skill markdown in `packages/pi-eforge/skills/` or `eforge-plugin/skills/` — that is `daemon-cli-wiring`'s territory and runs before this module.
- Adding new daemon HTTP routes or wire-protocol documentation; `DAEMON_API_VERSION` is unchanged in this expedition (per architecture).
- Writing migration guides for users of `@eforge-build/engine/playbook` or `@eforge-build/engine/set-resolver`. The project policy bans backward-compatibility cruft, and the architecture confirms no shims are introduced.
- Editing `docs/config-migration.md`, `docs/hooks.md`, `docs/prd/**`, or `docs/images/**` — none of them reference the affected APIs.

## Implementation Approach

### Overview

The doc edits in this module are boundary hardening, not import-path cleanup. Every change must reinforce one of these statements:

1. `@eforge-build/scopes` = where scoped eforge files live and how lookup/precedence works.
2. `@eforge-build/input` = reusable build-input protocols (playbooks, session plans).
3. `@eforge-build/engine` = the agentic build pipeline; it consumes normalized PRD/build source.
4. Wrapper apps own scheduling, triggers, approvals, notifications, and workflow orchestration.

For the four root-level / `docs/` files, edits are surgical: add new sections or rewrite specific paragraphs, not whole-file rewrites. The two package READMEs are authored from scratch — they did not exist before this expedition.

### Key Decisions

1. **Authoritative location for the package boundary table is `docs/architecture.md`.** The `README.md` references it; package READMEs link back to it; `docs/config.md` defers to it for dependency direction. This keeps a single source of truth and matches the project's existing convention that `README.md` points to `docs/architecture.md` for "a deeper look at the engine internals."

2. **`docs/config.md` "Config Layers" section is updated, not split.** The existing section already enumerates the three tiers correctly; the change is adding a sentence that names `@eforge-build/scopes` as the implementation source and clarifying that `config.yaml` uses layered-singleton lookup while `profiles/`, `playbooks/` use named-set resolution. Session plans are added as an explicit project-local-only category.

3. **Roadmap guardrail is added under the existing "Integration & Maturity" section, not as a new top-level section.** It is phrased as a constraint on what belongs in eforge core, with examples (scheduling, triggers, approvals, notifications), to mirror the architecture document's wording. The roadmap policy says "Future only — remove items once they ship", so the guardrail is framed as a guiding principle rather than a planned item.

4. **Package READMEs are concise and link to `docs/architecture.md` for the larger boundary discussion.** They mirror the structure of `packages/client/README.md` (consumers, what's included, rationale, stability) so newcomers find the same shape across packages. This avoids duplicating boundary discussion in three places.

5. **Mermaid diagram in `docs/architecture.md` is updated, not added.** The existing `System Layers` diagram shows `Consumers`, `Client`, `Engine`, `Harnesses`. Add new `Scopes` and `Input` package nodes with the dependency edges described in the architecture doc's Package Topology section. Keep the diagram readable — do not redraw the harness or consumer subgraphs.

6. **`README.md` "How It Works" wording is preserved where it already says "session plan" or "playbook" generically.** The targeted edits are: update the "Configuration" paragraph that says playbooks and profiles "follow the same pattern" to also mention scope-package precedence; clarify that `/eforge:plan` produces a session plan that the daemon normalizes via `@eforge-build/input` before enqueue; do not rewrite paragraphs that are already accurate.

7. **No em dashes anywhere in new or edited prose.** Per the user's `feedback_em_dashes.md` memory, all new copy uses single dashes (` - `) or full sentences. Existing em dashes in unedited prose are left alone (out of scope; this is a boundary update, not a copy edit pass).

## Files

### Create

- `packages/scopes/README.md` — package overview for `@eforge-build/scopes`. Sections:
  - Title and one-line description.
  - **Consumers** - lists `@eforge-build/engine` and `@eforge-build/input` (and notes future wrapper apps).
  - **Canonical scopes** - table copied from `docs/config.md` (user / project-team / project-local with directories) including precedence note.
  - **What's included** - bullet list referencing `Scope`, `SCOPES`, `getScopeDirectory`, `resolveLayeredSingletons`, `resolveNamedSet`, `listNamedSet`.
  - **Lookup modes** - 1-2 sentence explanation of layered-singleton vs named-set resolution, with `config.yaml` cited as the layered-singleton example and `profiles/`, `playbooks/` cited as named-set examples. Cross-link to `docs/config.md`.
  - **Out of scope** - explicit "no config schema, no playbook/profile schema, no daemon, no queue, no engine concepts" line.
  - **Stability** - mirror the wording from `packages/client/README.md`.

- `packages/input/README.md` — package overview for `@eforge-build/input`. Sections:
  - Title and one-line description.
  - **Consumers** - lists `@eforge-build/monitor` (daemon playbook routes + enqueue normalization), `@eforge-build/eforge` (in-process CLI normalization), and notes future wrapper apps.
  - **Dependencies** - depends on `@eforge-build/scopes`; explicitly NOT on `@eforge-build/engine`.
  - **What's included** - bullet list grouped by submodule:
    - Playbooks: `parsePlaybook`, `serializePlaybook`, `listPlaybooks`, `loadPlaybook`, `writePlaybook`, `movePlaybook`, `copyPlaybook`, `validatePlaybook`, `playbookToBuildSource` (note rename from `playbookToSessionPlan`).
    - Session plans: `parseSessionPlan`, `serializeSessionPlan`, `listActiveSessionPlans`, `selectDimensions`, `checkReadiness`, `migrateBooleanDimensions`, `sessionPlanToBuildSource`.
    - Boundary: `normalizeBuildSource` and matcher contract (only `**/.eforge/session-plans/*.md`).
  - **Boundary** - 1-2 sentence statement: input compiles input artifacts to ordinary build source; engine consumes that source; engine does not depend on input. Cross-link to `docs/architecture.md` for the full dependency-direction diagram.
  - **Out of scope** - "no daemon HTTP client (use `@eforge-build/client`), no engine queue knowledge, no new CRUD/tool API, no conversational planning logic (skills own that)".
  - **Stability** - mirror the wording from `packages/client/README.md`.

### Modify

- `README.md` — reposition input vs engine. Specific changes:
  - The introductory paragraph that ends with "...includes implementation, blind review, and validation in the background" stays as-is.
  - In the "How It Works" section, the "Formatting and enqueue" bullet is rewritten to clarify that `eforge` accepts input from multiple sources (prompt, session plan, playbook, PRD file), and that **playbooks and session plans are reusable input artifacts that the daemon compiles to ordinary build source via `@eforge-build/input` before reaching the engine queue**. Avoid wording that implies the engine itself owns workflow automation.
  - In the "Configuration" section, the paragraph that lists "Agent runtime profiles, custom workflow profiles, hooks, MCP servers, and plugins" is updated to add a sentence: "Scope precedence and lookup behavior live in `@eforge-build/scopes`; reusable input artifact protocols (playbooks, session plans) live in `@eforge-build/input`. The build engine consumes normalized build source and does not know whether the source originated from a playbook, session plan, wrapper app, CLI prompt, or PRD file."
  - No other sections are edited.

- `docs/architecture.md` — package-boundary section. Specific changes:
  - Update the existing **System Layers** Mermaid diagram to include two new subgraphs: a `Scopes` subgraph (`@eforge-build/scopes`) and an `Input` subgraph (`@eforge-build/input`). Add edges: `Engine --> Scopes`, `Input --> Scopes`, `Monitor --> Input`. Do not add an edge `Engine --> Input` (this is the explicit forbidden edge).
  - Add a new section titled **Package Topology** immediately after the **System Layers** section. Content:
    - 2-3 sentence intro restating the architecture's Package Topology.
    - Mermaid `flowchart TD` matching the architecture doc's Package Topology diagram (scopes, input, engine, client, monitor, cli, pi, plugin, wrappers).
    - "Allowed dependency edges" bullet list:
      - `engine` MAY depend on `scopes`. MUST NOT depend on `input`.
      - `input` MAY depend on `scopes`. MUST NOT depend on `engine`.
      - `monitor` MAY depend on `input`, `engine`, and `client`.
      - CLI, Pi, plugin SHOULD continue to use `client` for daemon-backed flows; direct `input` imports allowed only for in-process normalization paths.
    - One-line "Why" paragraph: keeps the build engine input-agnostic so future wrapper apps can reuse the input protocols without depending on engine internals.
  - Update the existing **Engine** subsection (under "System Layers") to remove any wording that implies playbooks are part of the engine API. The current text does not have such wording; verify and add a sentence: "The engine consumes normalized PRD/build source. Reusable input-artifact protocols (playbooks, session plans) live in `@eforge-build/input`; the engine has no dependency on input."
  - The **Monitor** subsection gets a single-sentence addition: "Playbook daemon routes import from `@eforge-build/input`; session-plan source paths are normalized via `normalizeBuildSource` from `@eforge-build/input` before reaching engine queue helpers."

- `docs/config.md` — scope semantics + layered singleton vs named set. Specific changes:
  - The section currently titled **Config Layers** is updated:
    - Add a sentence after the three-tier list: "Scope discovery and precedence are implemented in `@eforge-build/scopes`. Engine code calls `getScopeDirectory(scope)` for tier directory lookup, `resolveLayeredSingletons('config.yaml')` for the layered-singleton merge order, and `resolveNamedSet('profiles')` for active-profile resolution. Engine retains parsing, schema validation, `mergePartialConfigs()`, and active-profile semantics."
    - Add a sub-section heading **Lookup modes** with two bullets:
      - **Layered singleton** - all existing scope files are returned in canonical merge order `user -> project-team -> project-local`. Used for `config.yaml`. Caller owns parsing and merge semantics.
      - **Named set** - directory entries are unique by name across tiers; same-name entries shadow lower-precedence tiers. Used for `profiles/` and `playbooks/`. Highest-precedence copy wins.
    - Add a third bullet noting: "Project-local-only state (e.g. `.eforge/session-plans/*.md`) is not resolved through scope tiers; it is a project-local artifact and is read directly from the project-local scope by `@eforge-build/input`."
  - The **Backend Profiles > Active Profile Precedence** subsection is unchanged in content but gets a single-sentence prefix: "Profile resolution uses `@eforge-build/scopes` named-set resolution. The precedence chain below is the user-visible expression of that resolution."
  - The **Playbooks** paragraph (the long paragraph that begins "Playbooks follow the same three-tier pattern...") gets one preface sentence: "Playbooks are reusable input artifacts owned by `@eforge-build/input`, resolved across scopes by `@eforge-build/scopes`. The daemon compiles playbooks to ordinary build source via `playbookToBuildSource` before enqueue."
  - No other sections in `docs/config.md` are edited.

- `docs/roadmap.md` — wrapper-app guardrail. Specific changes:
  - Under the existing **Integration & Maturity** section, append a new subsection at the end titled **Boundary guardrail** with a 3-4 sentence note: "Scheduling, triggers, approvals, notifications, and richer workflow orchestration belong in wrapper apps built on stable eforge APIs, not in the engine. The build engine consumes normalized PRD/build source and emits typed events; reusable input-artifact protocols (playbooks, session plans) live in `@eforge-build/input`; scope/path lookup lives in `@eforge-build/scopes`. Wrapper apps may compose these packages directly or call the daemon HTTP client (`@eforge-build/client`). New scheduling/workflow features added to engine or daemon should be challenged against this guardrail."
  - No other roadmap items are added or removed (per the project's "Future only - remove items once they ship" policy).

## Testing Strategy

### Unit Tests

This module has no unit-testable behavior (it edits markdown documentation). Validation is performed through verification criteria below and through review-cycle.

### Integration Tests

- The repository's existing `pnpm test` includes `scripts/check-skill-parity.mjs`. This module does not edit skill files, so parity checks are expected to remain green. If parity fails on this module's branch, that indicates a wording change leaked into a skill file - which is out of scope for this module and should be removed.
- `pnpm build` and `pnpm type-check` must pass. Markdown edits do not affect these, but the merge order means this module's branch must inherit a green build state from `daemon-cli-wiring`.

### Documentation Validation

- All file paths and symbol names referenced in new prose must match what `scopes-package`, `input-package`, `engine-integration`, and `daemon-cli-wiring` actually shipped. The reviewer perspective `docs` is responsible for catching drift between prose and code.
- Mermaid diagrams must render. Both new diagrams use the existing `flowchart TD` syntax already in `docs/architecture.md`, so no new Mermaid features are introduced.

## Verification

- [ ] `README.md` describes playbooks and session plans as input-layer artifacts that compile to ordinary build source via `@eforge-build/input`, and the "Configuration" paragraph names `@eforge-build/scopes` as the source of scope precedence.
- [ ] `docs/architecture.md` contains a new **Package Topology** section that includes a Mermaid diagram with nodes for `scopes`, `input`, `engine`, `client`, `monitor`, `cli`, `pi`, `plugin`, and `wrappers`, with edges matching the architecture document's Package Topology section.
- [ ] `docs/architecture.md` contains the literal statement that `@eforge-build/engine` MUST NOT depend on `@eforge-build/input`, with the same constraint stated for the inverse direction (`input ↛ engine`).
- [ ] `docs/architecture.md` **System Layers** Mermaid diagram includes `Scopes` and `Input` package subgraphs/nodes; the diagram has no edge from `Engine` to `Input`.
- [ ] `docs/config.md` **Config Layers** section names `@eforge-build/scopes` and explicitly distinguishes layered-singleton lookup (used for `config.yaml`) from named-set resolution (used for `profiles/`, `playbooks/`). Session plans are noted as project-local-only state.
- [ ] `docs/config.md` **Backend Profiles > Active Profile Precedence** subsection references `@eforge-build/scopes` named-set resolution.
- [ ] `docs/roadmap.md` contains a **Boundary guardrail** subsection under "Integration & Maturity" that lists scheduling, triggers, approvals, notifications, and workflow orchestration as wrapper-app territory, not engine territory.
- [ ] `packages/scopes/README.md` exists, names the canonical scopes (`user`, `project-team`, `project-local`) with directories `~/.config/eforge/`, discovered `eforge/`, and `[project]/.eforge/`, names the precedence order `project-local > project-team > user`, lists `getScopeDirectory`, `resolveLayeredSingletons`, `resolveNamedSet`, `listNamedSet` exports, and contains an explicit "out of scope" line covering schema/daemon/queue/engine concepts.
- [ ] `packages/input/README.md` exists, names `@eforge-build/scopes` as a dependency and explicitly states no dependency on `@eforge-build/engine`, lists the playbook helpers (`parsePlaybook`, `playbookToBuildSource`, etc.), session-plan helpers (`parseSessionPlan`, `checkReadiness`, `sessionPlanToBuildSource`, etc.), and `normalizeBuildSource` with the matcher contract `**/.eforge/session-plans/*.md`.
- [ ] No prose in any edited or created file uses em dashes; single dashes (` - `) or full sentences are used instead.
- [ ] No edited file has changes outside the sections listed in the "Modify" entries above.
- [ ] No skill markdown files under `packages/pi-eforge/skills/` or `eforge-plugin/skills/` are edited by this module.
- [ ] `pnpm build`, `pnpm type-check`, and `pnpm test` pass on this module's branch.

<build-config>
{
  "build": [["implement", "doc-author"], "review-cycle"],
  "review": {
    "strategy": "single",
    "perspectives": ["docs"],
    "maxRounds": 2,
    "evaluatorStrictness": "standard"
  }
}
</build-config>
