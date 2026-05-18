---
title: Harden Extension Trust Model
created: 2026-05-18
profile: gpt-claude-combo
---

# Harden Extension Trust Model

## Problem / Motivation

Native eforge extensions execute arbitrary TypeScript/JavaScript in the daemon/worker Node process with the user's filesystem, environment, and network permissions.

Today there is a coarse guard for committed project/team extensions: project-team scope is skipped unless `extensions.trustProjectExtensions` is set from user or project-local config, and committed project config/profile values are stripped. That protects against a repo silently enabling its own committed extensions, but it does not provide a per-extension trust record, does not detect changed committed extension code after trust, and does not surface trust state in the human-readable CLI list/show output.

Affected users: anyone opening or building a repository that contains `eforge/extensions/`. The risk matters more now because the extension API has grown from event hooks to agent context/tool injection, profile routing, and blocking policy gates. These capabilities are intended and powerful, but the UX must be explicit that loading extensions is arbitrary code execution.

### Context

Schaake OS epic `c531df7d-6c31-437c-9cb1-d23b665a0e88` is in progress and asks for:

- A clear trust model for arbitrary TypeScript extension execution.
- Trust prompts or trust metadata for committed project/team extensions.
- List/show provenance and trust state.
- Changed committed extension detection or documented hash/provenance strategy.
- Security docs that extensions run arbitrary code with user permissions.
- Loader/management integration.
- Explicit exclusion of package manifest conventions plus npm/git install support.

Roadmap alignment:

- `docs/roadmap.md` lists Native TypeScript extensions as a current Extensibility roadmap item and points at `docs/prd/typescript-extensibility.md`.
- That PRD defines EXTEND_13A as trust model hardening and EXTEND_13B as later packaging/install support.
- It explicitly calls out:
  - user/project-local enabled by default,
  - committed project/team requiring explicit trust,
  - possible `eforge extension trust` or repo-level trust metadata,
  - hash-based changed-extension prompts,
  - provenance in list/show,
  - timeout/failure policies.

### Current implementation evidence

- `packages/engine/src/extensions/discovery.ts` discovers user, project-team, and project-local scopes with precedence `project-local > project-team > user`. Project-team candidates are `untrusted` unless `extensions.trustProjectExtensions` resolves true; user, project-local, and external explicit paths are currently treated as trusted.
- `packages/engine/src/extensions/loader.ts` skips `candidate.trust === 'untrusted'` with `extension:untrusted` diagnostics and otherwise imports arbitrary JS/TS using `dynamic-import` or `jiti` in-process.
- `packages/engine/src/config.ts` has a guard that strips `extensions.trustProjectExtensions` from project-team config/profile layers, so committed project config cannot silently trust committed project extensions. User and project-local config/profile layers can trust them.
- `packages/client/src/types.ts`, `packages/monitor/src/server.ts`, `packages/engine/src/extensions/replay.ts`, and `packages/engine/src/extensions/projector.ts` already carry basic `trust`, `scope`, `source`, path, entrypoint, status, diagnostics, shadows, and registration counts across list/show/validate/test responses.
- CLI table/detail rendering in `packages/eforge/src/cli/index.ts` currently shows status/enabled/scope/source/registrations/path but not the `trust` field in human-readable output, despite JSON carrying it. Pi/MCP actions return JSON, so they expose trust if clients inspect it.
- Docs already warn in `docs/extensions.md`, `docs/config.md`, README, package README, and `/eforge:extend` skill text that extensions are unsandboxed and project/team scope requires explicit trust.
- `docs/extensions.md` currently says “Hash-based trust prompts/stores are not shipped behavior in this slice,” which will be stale if this epic implements hash-based detection.
- Existing tests cover basic project-team untrusted/trusted discovery and loader behavior:
  - `test/extension-discovery.test.ts`
  - `test/extension-loader.test.ts`
  - config merge preservation
  - extension tooling wiring
- No evidence yet of per-extension trust metadata, hash state, trust CLI action, or changed-extension detection.

## Goal

Implement EXTEND_13A by adding a clear, explicit trust model for committed project/team TypeScript extensions, including persisted trust metadata or equivalent explicit trust, content hash/provenance detection for changed extensions, loader enforcement, management surfaces, docs, and tests.

The desired outcome is that committed project/team extensions cannot silently execute without explicit trust, changed trusted extensions are detected and handled, and users can inspect trust/provenance state through list/show and management tooling.

## Approach

### Classification

This is a **feature / focused** change with medium confidence. It adds user-facing management/loader behavior and docs without requiring delegated subsystem planning.

Required dimensions selected:

- problem-statement
- scope
- acceptance-criteria
- code-impact
- design-decisions
- assumptions-and-validation

### Recommended profile

**Excursion**

Rationale: this is cross-cutting but cohesive. A single planner can enumerate the engine trust-store/hash work, loader/discovery changes, daemon/client routes, CLI/MCP/Pi management surfaces, docs, and tests without needing independently delegated subsystem planning. It is too large and security-sensitive for Errand, but it does not require Expedition-style architecture planning plus module subplanners because the extension management boundaries and existing route/tool patterns are already established.

### High-level implementation approach

- Add a clear committed project/team extension trust model for `eforge/extensions/`.
- Add persisted trust metadata or an equivalent explicit trust mechanism for project/team extension candidates.
- Recommended default: per-project, project-local, gitignored trust records in `.eforge/` keyed by extension identity/provenance plus a content hash.
- Compute and expose content-hash/provenance information for committed project/team extensions so changed extensions can be detected and explained.
- Integrate trust evaluation into discovery/loader behavior so untrusted or changed project/team extensions do not silently load under the hardening model.
- Extend daemon/client/API wire types and management routes as needed so CLI, MCP proxy, Pi extension, and Claude Code plugin surfaces remain in sync.
- Update `eforge extension list/show/validate` human-readable output and JSON wire shape to include trust state, provenance, and hash/change signals.
- Add management commands/tool actions for trusting, and likely untrusting, project/team extensions, then reload instructions.
- Add tests for discovery/loader trust behavior, trust-store read/write, API route projection, CLI rendering, MCP/Pi action validation, and docs/wiring drift gates where existing patterns apply.

### Design decisions

1. **Trust model shape**

   Introduce explicit trust metadata for committed project/team extensions rather than relying only on the coarse `extensions.trustProjectExtensions` boolean.

   - Project/team extension candidates should have a derived trust state such as `not-required`, `untrusted`, `trusted`, or `changed` in addition to existing provenance fields.
   - Rationale: the current boolean answers “does this project scope have permission to load?” but cannot distinguish a reviewed extension from a changed one.

2. **Trust store location**

   Store per-project user trust records in `.eforge/extension-trust.json` or similarly named file rather than committed `eforge/` metadata.

   - Rationale: trust is a local user decision and must not be committed by the repository being trusted. `.eforge/` is already gitignored developer-facing runtime/local config state.
   - Trade-off: trust is per clone and can be lost if `.eforge/` is deleted. That is acceptable for a safety boundary and should be documented.

3. **Hashing strategy**

   Compute a deterministic content hash for the extension unit before execution.

   - File layout: hash the resolved file entrypoint.
   - Directory layout: hash relevant files under the extension directory in stable sorted order, including `package.json` and supported source files, while excluding heavy/generated directories such as `node_modules`, `dist`, and `.git`.
   - Rationale: this detects most committed extension changes without executing extension code. Directory layout is the recommended layout for multi-file extensions.
   - Limitation to document: imports outside the extension unit may not be fully captured unless the strategy deliberately expands to those paths. If that is not implemented, docs should tell authors to keep extension implementation inside its extension directory.

4. **Loader behavior strictness**

   Recommended strict mode is: changed project/team extension does not load until re-trusted.

   - Rationale: this best satisfies hardening and prevents silent code execution after a trusted extension changes.
   - Compatibility decision: there are no current external users, so choose the strict behavior now.
   - `extensions.trustProjectExtensions: true` should not remain a trust-all escape hatch for changed committed code. It can either be deprecated in favor of explicit per-extension trust records or treated only as a coarse prerequisite/migration compatibility signal.

5. **Management UX**

   Add explicit management actions rather than hidden daemon prompts.

   - CLI: `eforge extension trust <nameOrPath>` and likely `eforge extension untrust <nameOrPath>`.
   - MCP/Pi: extend `eforge_extension` actions with `trust`/`untrust` so agents can inspect then ask user confirmation before activating arbitrary code.
   - Rationale: daemon/API/tool contexts are often non-interactive; explicit commands are auditable and easier to test than prompts.

6. **List/show output**

   Expose trust state in both JSON and human-readable output.

   Include:

   - scope
   - source
   - path
   - entrypoint
   - trust state
   - current hash, possibly short hash in table and full hash in JSON/detail
   - trusted hash
   - trusted timestamp/source when present
   - diagnostics for untrusted/changed candidates

   Rationale: acceptance criteria require provenance and trust state; current CLI human output omits `trust`.

7. **Security docs and skill flow**

   Require user confirmation before validation/reload/trust of project/team code and clearly state that extension validation/test/reload can execute code.

   Rationale: `/eforge:extend` already warns before validation/reload, but docs must be updated for explicit trust records and changed-hash behavior.

8. **Package/install boundary**

   Do not add manifest conventions, npm install, git install, or package trust policy here. Mention EXTEND_13B as the future boundary.

### Code impact

Likely code impact, with evidence:

- `packages/engine/src/extensions/types.ts`
  - Extend `NativeExtensionCandidate` and related types with richer trust/provenance state, e.g. content hash, trusted hash, trust source, trusted/changed/untrusted status detail.
  - Evidence: current candidate only has `trust: 'trusted' | 'untrusted'` and status.

- `packages/engine/src/extensions/discovery.ts`
  - Compute project-team extension identity and content hash during discovery.
  - Read trust metadata.
  - Classify candidates as trusted/untrusted/changed.
  - Preserve scope/source/shadow behavior.
  - Evidence: current trust is `trustForScope(scope, trustProjectExtensions)`.

- New or extended engine module, likely under `packages/engine/src/extensions/`
  - Trust-store helpers for reading/writing `.eforge` trust metadata.
  - Hash files/directories deterministically.
  - Update records by extension name/path.
  - Keep this separate from the loader so management routes can trust candidates without executing extension code.

- `packages/engine/src/extensions/loader.ts`
  - Honor the richer trust result before `importExtension`.
  - Emit stable diagnostics for untrusted or hash-changed committed extensions.

- `packages/engine/src/extensions/projector.ts` and `packages/engine/src/extensions/replay.ts`
  - Include trust-state/hash/provenance in projections used by daemon APIs and replay/test output.

- `packages/client/src/types.ts`, `packages/client/src/api/extensions.ts`, `packages/client/src/routes.ts`, and possibly `packages/client/src/api-version.ts`
  - Add wire types/routes/helpers for trust/untrust.
  - Expose trust-state fields.
  - Bump `DAEMON_API_VERSION` if the HTTP API response shape change is considered breaking.

- `packages/monitor/src/server.ts`
  - Add daemon routes for trust/untrust.
  - Use shared projection helpers for list/show/validate/test/reload.
  - Existing extension management mutation routes already enforce cross-origin protection, so new trust mutation route should follow that pattern.

- `packages/eforge/src/cli/index.ts`
  - Add `eforge extension trust <nameOrPath>` and likely `untrust`.
  - Render trust state in list/show.
  - `renderExtensionTable` currently omits trust in human-readable output.

- `packages/eforge/src/cli/mcp-proxy.ts`
  - Expose matching `eforge_extension` actions.
  - Project convention requires keeping Pi and Claude Code integration surfaces in sync.

- `packages/pi-eforge/extensions/eforge/index.ts`
  - Add matching TypeBox action enum/params/execution branches for trust/untrust.
  - Do not bump `packages/pi-eforge/package.json`.

- `eforge-plugin/.claude-plugin/plugin.json`
  - Bump plugin version if plugin-facing docs/tools change.
  - `eforge-plugin` uses MCP proxy, so action support primarily comes from CLI/MCP code, but skill docs may need trust workflow updates.

- Docs likely needing updates:
  - `docs/extensions.md`
  - `docs/config.md`
  - README
  - `packages/extension-sdk/README.md`
  - `packages/pi-eforge/skills/eforge-extend/SKILL.md`
  - `eforge-plugin/skills/extend/extend.md`

- Tests to extend or add:
  - `test/extension-discovery.test.ts`
  - `test/extension-loader.test.ts`
  - `test/extension-tooling-routes.test.ts`
  - `test/extension-tooling-wiring.test.ts`
  - `test/config.test.ts` if config semantics change
  - focused tests for hashing/trust-store behavior

Existing coverage evidence:

- Current tests already cover coarse trust gating using `extension:untrusted`.
- Current tests cover config stripping of project-team `trustProjectExtensions`.
- Current tests cover route/list/show validation plumbing.
- Current tests cover Pi/MCP action ordering.
- These are good extension points for the hardening tests.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| The best fit for “trust prompts or trust metadata” is a persisted trust store keyed by project identity plus extension path/name and content hash, managed by explicit commands/tools rather than interactive prompts inside daemon/worker execution. | Daemon/tool surfaces are non-interactive APIs, and current eforge tooling already exposes management actions via CLI/MCP/Pi. | medium | low | Inspect command parser patterns and decide whether to add `trust` as a management action or config metadata. | UX or persistence model may need to change if interactive prompts or config metadata are preferred. |
| Human-readable CLI list/show should include trust/hash state because acceptance criteria say list/show includes provenance and trust state, and JSON-only trust state may not be enough. | Current CLI output tests can be inspected and assertions added. | medium/high | low | Inspect CLI output tests and add assertions. | JSON-only may technically satisfy API users but weakens CLI UX. |
| Project/team extension trust should be local/user-specific rather than committed. | Existing `config.ts` strips `extensions.trustProjectExtensions` from project-team config/profile layers; docs say trusted layer is user or project-local. | high | low | Add/inspect tests for project-team config/profile stripping and extend them for trust metadata. | If wrong, a repo could commit its own trust records and defeat the safety model. |
| `.eforge/` is the right place for per-project trust records. | AGENTS.md says `.eforge/` is gitignored developer-facing runtime/local config; docs already treat `.eforge/config.yaml` as trusted project-local config. | medium | low | Confirm `@eforge-build/scopes` project-local path helpers and choose filename with maintainers. | If wrong, trust records may be too ephemeral or not portable enough; user-level store may be preferable. |
| Explicit trust/untrust commands are preferable to interactive prompts. | Daemon/client/Pi/MCP surfaces are typed request/response APIs and often non-interactive; current extension commands are explicit management actions. | high | low | Inspect CLI command patterns and add a route/action similar to `extension reload/new`. | If wrong, UX may be less friendly than prompts; prompts are harder in daemon/agent contexts. |
| Strict changed-hash blocking is acceptable despite compatibility risk. | EXTEND_13A is a security hardening epic; PRD calls out hash-based trust prompts/stores for changed committed extensions. User confirmed there are no current external users, only the maintainer. | high | low | Implement strict tests and document the changed semantics. | If wrong, the maintainer may need to re-trust extensions more often than expected, but there is no external compatibility burden. |
| Hashing the extension unit is sufficient for changed-extension detection. | Discovery supports file/directory layouts; directory layout naturally contains package entrypoint and helpers. | medium | medium | Implement tests for file and directory hash changes; decide whether out-of-unit imports are documented limitation or included in hash closure. | If wrong, code imported outside the hashed unit could change without trust invalidation. |
| Package install support remains out of scope. | Schaake OS epic and PRD explicitly assign package/npm/git support to EXTEND_13B. | high | none | Keep docs and implementation boundaries explicit. | Scope creep would expand security model and likely require a separate package trust policy. |

### Unknowns

- Whether trust metadata should live in `.eforge/` project-local state, user config, or a new user-level trust DB/file. This affects portability and whether trusting a repo on one machine is global or project-local.

## Scope

### In scope

- Add a clear committed project/team extension trust model for `eforge/extensions/`.
- Add persisted trust metadata or an equivalent explicit trust mechanism for project/team extension candidates.
- Recommended default: per-project, project-local, gitignored trust records in `.eforge/` keyed by extension identity/provenance plus a content hash.
- Compute and expose content-hash/provenance information for committed project/team extensions so changed extensions can be detected and explained.
- Integrate trust evaluation into discovery/loader behavior so untrusted or changed project/team extensions do not silently load under the hardening model.
- Extend daemon/client/API wire types and management routes as needed so CLI, MCP proxy, Pi extension, and Claude Code plugin surfaces remain in sync.
- Update `eforge extension list/show/validate` human-readable output and JSON wire shape to include trust state, provenance, and hash/change signals.
- Add management commands/tool actions for trusting, and likely untrusting, project/team extensions, then reload instructions.
- Update docs:
  - `docs/extensions.md`
  - `docs/config.md`
  - README
  - `packages/extension-sdk/README.md`
  - `/eforge:extend` skill docs in both `packages/pi-eforge/` and `eforge-plugin/` if behavior changes
- Add tests for:
  - discovery/loader trust behavior
  - trust-store read/write
  - API route projection
  - CLI rendering
  - MCP/Pi action validation
  - docs/wiring drift gates where existing patterns apply

### Out of scope

- Package manifest conventions for shareable extensions.
- npm/git install support for installable extension packages.
- EXTEND_13B packaging/install support.
- Sandboxing extension execution; docs should state extensions remain unsandboxed trusted code.
- Rich approval UI/state for policy gates.
- New extension runtime capabilities beyond trust/provenance management.

### Boundary notes

- This should stay focused on committed `project-team` extensions.
- User and project-local extensions are already user-controlled locations and can remain trusted by location, with docs warning that explicit external paths are trusted code execution.
- Package manifest conventions, npm install, git install, and package trust policy should not be added here. EXTEND_13B remains the future boundary.

## Acceptance Criteria

- Project/team extensions under `eforge/extensions/` cannot silently execute merely because their repository commits config that enables trust; trust must come from user/project-local metadata or another explicitly trusted layer.
- A project/team extension can be explicitly trusted through the extension management surface, without executing the extension while making the trust decision.
- A changed trusted project/team extension is detected by content hash/provenance comparison and is surfaced as changed; under the recommended strict behavior it is skipped until re-trusted.
- `eforge extension list` and `eforge extension show` human-readable output include trust state/provenance; JSON responses include machine-readable trust-state fields and hashes/provenance.
- `eforge extension validate/test/reload` continue to work and report trust diagnostics consistently for untrusted or changed project/team extensions.
- CLI, daemon API, shared client helpers/types, MCP proxy, and Pi `eforge_extension` tool expose matching trust/untrust behavior where technically applicable.
- Existing protections remain: committed project `eforge/config.yaml` and project-team profile files cannot set trust for committed project/team extensions.
- Docs clearly state that native extensions are unsandboxed arbitrary code execution with the user's permissions and that validation/test/reload may execute extension code.
- Docs explain:
  - trust storage location,
  - content hash strategy,
  - changed-extension behavior,
  - limitations for imported files/out-of-unit code,
  - how to re-trust or untrust.
- Package manifest conventions and npm/git install support are not implemented and are documented as out of scope / EXTEND_13B.
- Tests cover:
  - trust metadata read/write,
  - hash change detection,
  - loader skip/load behavior,
  - route/client projection,
  - CLI rendering,
  - MCP/Pi action validation,
  - relevant docs/wiring expectations.
