---
title: EXTEND_04: Extension Management Surface MVP
created: 2026-05-14
depends_on: ["extend-03-typed-event-extension-runtime"]
profile: pi-codex-5-5
---

# EXTEND_04: Extension Management Surface MVP

## Problem / Motivation

Classification: **feature / focused** with high confidence. EXTEND_04 adds user-facing and integration-facing management capabilities around the extension foundation. It is a typical multi-package feature, not an architecture rewrite.

### Context and evidence

Evidence sources reviewed:

- Schaake OS epic `f379c482-ba12-4228-88d6-3dc12ee7f668` defines EXTEND_04 as the management MVP:
  - CLI `list`, `show`, `new`, `validate`, `reload`
  - daemon routes and `@eforge-build/client` helpers
  - Pi and Claude Code tools
  - provenance in list/show
  - event replay and broad enable/disable/promote/demote deferred
- The epic is blocked today only by EXTEND_03 plus EXTEND_02. EXTEND_02 is done; this plan assumes EXTEND_03 lands and unblocks EXTEND_04.
- `docs/prd/typescript-extensibility.md` confirms EXTEND_04 should deliver management MVP incrementally and defer replay testing to EXTEND_07.
- `docs/roadmap.md` aligns this with the Native TypeScript Extensions roadmap.
- Current implementation is partially ahead of the epic:
  - `packages/client/src/routes.ts` already declares `extensionList`, `extensionShow`, and `extensionValidate`.
  - `packages/client/src/api/extensions.ts` exports `apiListExtensions`, `apiShowExtension`, and `apiValidateExtensions`.
  - `packages/monitor/src/server.ts` implements list/show/validate daemon routes and path validation for ad-hoc validation.
  - `packages/eforge/src/cli/index.ts` exposes `eforge extension list/show/validate`.
  - `packages/eforge/src/cli/mcp-proxy.ts` and `packages/pi-eforge/extensions/eforge/index.ts` expose a shared `eforge_extension` tool for `list/show/validate`.
  - Tests exist in `test/extension-tooling-routes.test.ts` and `test/extension-tooling-wiring.test.ts` for the current partial surface.
- Missing relative to the epic:
  - no CLI/API/client/Pi/MCP support for `extension new` scaffolding
  - no CLI/API/client/Pi/MCP support for `extension reload`
  - list/show output includes provenance but not an explicit `enabled` state field
  - tooling descriptions only mention list/show/validate
  - static wiring tests currently assert only `['list', 'show', 'validate']`
- Relevant adjacent patterns:
  - Playbook management in `docs/config.md` and `eforge_playbook` surfaces already use scoped artifact creation/promote/demote conventions. EXTEND_04 should follow the same scope vocabulary but only implement the MVP.
  - Project instructions require keeping `eforge-plugin/` Claude Code/MCP proxy and `packages/pi-eforge/` in sync for user-facing capabilities and importing daemon HTTP helpers from `@eforge-build/client` rather than inlining routes.

### Problem statement

After EXTEND_03 lands, eforge will be able to execute typed event-extension handlers, but users and agent integrations still lack a complete first-class management surface for creating and refreshing extensions. The current code can inspect and validate extensions with `list`, `show`, and `validate`, but the EXTEND_04 MVP requires users, Pi, and Claude Code to also scaffold a new extension and reload extensions without guessing filesystem layout or manually restarting the daemon.

Affected users:

- Humans using `eforge extension ...` from the CLI.
- Pi and Claude Code agents that need stable tools for extension authoring and validation.
- Future `/eforge:extend` implementation, which needs shared scaffold/validate/reload primitives.

Why now:

- EXTEND_02 provides discovery/loader/provenance.
- EXTEND_03, assumed landed for this plan, makes event-hook extensions actually useful at runtime.
- EXTEND_04 is the natural bridge from runtime foundation to authoring UX: it creates the management API that later docs/examples, `/eforge:extend`, and replay testing build on.

### Assumptions / unknowns

- Assumption, high confidence: this epic should build on the existing list/show/validate implementation rather than replace it. Evidence: current code and tests already satisfy much of the acceptance criteria.
- Assumption, medium confidence: `reload` should mean "force the daemon to reload extension discovery/registry without restarting the whole daemon" if feasible; if not feasible in current daemon architecture, it may be an alias to re-run load/validate for management responses plus an actionable message that active build workers need restart. This must be resolved during implementation design.
- Assumption, medium confidence: `new` should scaffold project-local TypeScript event-extension templates by default, because project-local is recommended for experiments and EXTEND_03 makes event hooks the first supported runtime. The MVP should still allow project/team/user scopes.

## Goal

Deliver the EXTEND_04 management MVP by extending the existing extension tooling from inspect/validate only to a complete first-class management surface for listing, showing, validating, scaffolding, and reloading extensions. The result should provide shared daemon/client primitives used consistently by the CLI, Pi extension, and Claude Code MCP proxy while deferring replay testing and broader enable/disable/promote/demote workflows.

## Approach

### High-level implementation

Build on the current `list`/`show`/`validate` implementation and add missing `new` and `reload` support across the daemon API, `@eforge-build/client`, CLI, Pi extension, Claude Code MCP proxy, tests, and docs. Use shared route constants and typed client helpers rather than generic request code or inlined `/api/...` paths.

### Client wire contract

- `packages/client/src/routes.ts`
  - Add route constants for scaffold/new and reload, e.g. `extensionNew` / `extensionReload`.
  - Continue using `API_ROUTES` everywhere; do not inline `/api/...` paths.
- `packages/client/src/types.ts`
  - Add request/response types for extension scaffold/new and reload.
  - Add any explicit enabled/loadable field to `ExtensionEntry` if chosen.
- `packages/client/src/api/extensions.ts`
  - Add helpers such as `apiNewExtension()` / `apiReloadExtensions()`.
- `packages/client/src/index.ts`
  - Re-export new helpers and types.

### Daemon/server routes

- `packages/monitor/src/server.ts`
  - Existing list/show/validate implementation lives around the extension tooling region. Add POST routes for new/scaffold and reload.
  - Reuse existing `EXTENSION_NAME_RE`, path validation patterns, `loadExtensionResponse()`, and normalization helpers where possible.
  - Add scaffold implementation either directly in an engine/scopes helper or in a shared extension management module. Prefer a reusable helper over embedding filesystem logic in the route.
- `packages/monitor/src/server-main.ts`
  - If reload needs to reinitialize active event-hook runtime after EXTEND_03, add a daemon-state callback or route behavior that stops/starts the in-process watcher without killing child build workers.
  - Current comments state stopping the watcher does not kill in-flight PRD subprocesses.

### Engine/scopes/scaffold helper

Add a helper under `packages/engine/src/extensions/` or a small shared module to:

- map CLI scope `local|project|user` to scope resolver names `project-local|project-team|user`
- resolve the target `extensions/` directory using `getScopeDirectory()` from `@eforge-build/scopes`
- validate names and template names
- render template content
- create parent directories
- write `<name>.ts` or directory layout
- refuse overwrite unless force is explicitly supported

### CLI

- `packages/eforge/src/cli/index.ts`
  - Existing `extension` subcommands are `list`, `show`, `validate`; add `new` and `reload`.
  - Update table/detail rendering if `enabled`/loadable state is added.
  - Update static tests that currently expect exactly `['list', 'show', 'validate']`.
- `packages/eforge/src/cli/run-or-delegate.ts`
  - If delegated CLI has separate extension command behavior, keep parity.
  - At minimum ensure it imports/uses new client helpers only where needed.

### MCP / Claude Code proxy and Pi extension

- `packages/eforge/src/cli/mcp-proxy.ts`
  - Update `eforge_extension` schema action enum from `list|show|validate` to include `new` and `reload`.
  - Use new `@eforge-build/client` helpers.
- `packages/pi-eforge/extensions/eforge/index.ts`
  - Same action enum and parameter updates as MCP proxy.
  - Because user-facing behavior changes in Pi extension, do **not** bump `packages/pi-eforge/package.json`, per project instruction.
- `eforge-plugin/`
  - Check for the Claude Code plugin-facing MCP/tool/skill surface.
  - If changes touch plugin files, bump `eforge-plugin/.claude-plugin/plugin.json` version as required by project instructions.
  - If the plugin relies solely on the MCP proxy, document why no plugin file change is needed.

### Docs and tests

Tests to update/add:

- `test/extension-tooling-wiring.test.ts` for route constants/helpers and Pi/MCP parity including `new`/`reload`.
- `test/extension-tooling-routes.test.ts` for route behavior, scaffold file placement/content, overwrite protection, and reload response.
- CLI tests for `extension new` and `reload` JSON/non-JSON behavior.
- Potential focused unit tests for scaffold helper path safety.

Docs to update:

- `docs/extensions.md` management commands and runtime support section.
- `docs/extensions-api.md` if needed.
- `packages/extension-sdk/README.md` if Quick Start should mention `eforge extension new`.
- Generated/reference docs if command/config docs are generated; run docs drift checks if relevant.
- Package README/help text and user-facing command descriptions.

### Existing implementation to preserve

Current list/show/validate routes, CLI commands, client helpers, Pi/MCP tool actions, and tests already cover a large part of EXTEND_04. The implementation should extend these rather than rewrite them.

### Design decisions

1. **Treat current list/show/validate work as baseline, not throwaway**

   Decision: preserve and extend the existing list/show/validate implementation.

   Rationale:

   - Current code already uses shared client helpers and route constants.
   - Tests cover list/show/validate route behavior and Pi/MCP parity.
   - Rewriting would add risk without advancing the missing epic acceptance criteria.

2. **Add separate scaffold/new and reload helpers in `@eforge-build/client`**

   Decision: add typed client helpers for the missing actions rather than expanding callers to use generic `daemonRequest()`.

   Rationale:

   - Project instructions require daemon HTTP client helpers and route contracts to live in `@eforge-build/client`.
   - Pi extension, MCP proxy, and CLI should call shared helpers to prevent route drift.

3. **Use `extension new` as the CLI command, but name API concepts "scaffold" if clearer**

   Decision: user-facing CLI uses `eforge extension new <name>` matching the PRD. Internal API/helper names may use `scaffold` or `new` consistently; prefer one naming convention and expose it clearly.

   Rationale:

   - `new` is the documented command.
   - `scaffold` is semantically clearer for agents and may align with the PRD tool examples, such as `eforge_extension_scaffold`.

   Implementation note:

   - Avoid having both public `new` and `scaffold` actions unless one aliases the other, because duplicate action names increase integration parity work.

4. **Default scaffold target is project-local TypeScript event hook**

   Decision: default `--scope local` maps to `.eforge/extensions/<name>.ts`; default `--template event-logger` or `blank-event` should generate an EXTEND_03-supported `onEvent` extension.

   Rationale:

   - PRD recommends project-local for experimental generated extensions.
   - Assuming EXTEND_03 lands, event hooks are the first actual runtime capability.
   - Generating unsupported policy/tool/profile templates would mislead users.

5. **Scope names should match CLI UX, but implementation should use scope resolver primitives**

   Decision: expose CLI/tool scope values `local|project|user`, mapped internally to `project-local|project-team|user`.

   Rationale:

   - The PRD CLI syntax uses `local|project|user`.
   - Existing scopes package uses canonical scope names; using it avoids hand-rolled path drift.

6. **Overwrite protection by default**

   Decision: scaffolding refuses to overwrite an existing extension unless an explicit `force` option is added and set.

   Rationale:

   - Generated code can otherwise destroy user-authored extension logic.
   - This mirrors safe management behavior expected for agent-authored files.

7. **Reload is best-effort and explicit about what it reloads**

   Decision: implement `extension reload` as a daemon API operation that re-runs extension discovery/loading and returns the same provenance/diagnostics shape plus reload metadata. If the persistent daemon watcher has an in-memory EXTEND_03 event runtime, reload should restart/reinitialize the watcher for future events without killing in-flight build children.

   Rationale:

   - Existing list/show/validate already load fresh registry data per request, so a no-op reload would be misleading unless it also updates runtime users.
   - After EXTEND_03, the active watcher may have captured event hooks in memory; users expect reload to apply a newly scaffolded/edited extension.

   Constraints:

   - Do not kill active PRD child workers merely to reload extensions.
   - Running workers may keep their current extension registry; document that reload affects future daemon watcher/queue dispatch and future CLI invocations.

8. **Enablement state should be explicit and derived**

   Decision: list/show entries should include a derived field such as `enabled` or `loadable` rather than introducing per-extension enable/disable state in this epic.

   Rationale:

   - Full enable/disable semantics are out of scope.
   - Existing config has global `extensions.enabled`, include/exclude filters, trust, and status. A derived field can satisfy acceptance without adding new state.

   Possible derivation:

   - `enabled: true` when global extensions are enabled and the entry is not excluded/skipped due solely to config filters; status/trust still explain why it may not be loaded.
   - Alternatively `loadable: boolean` may be clearer than `enabled`; choose one and document it.

9. **Keep event replay/test explicitly deferred**

   Decision: if adding a placeholder `eforge extension test` is cheap, it should return an actionable "not yet supported; tracked by EXTEND_07" message. Otherwise do not add it in this epic.

   Rationale:

   - The epic explicitly defers replay testing.
   - A placeholder is useful only if it prevents user confusion without implying implementation.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| EXTEND_04 should build on existing list/show/validate code. | Grep and file reads showed route constants, client helpers, daemon routes, CLI commands, Pi/MCP tool actions, and tests for list/show/validate. | high | low | Run `pnpm test -- extension-tooling` before/after implementation. | Rewriting could waste work and introduce regressions. |
| EXTEND_03 landing means event hook scaffolds are now appropriate as default templates. | User explicitly said "assuming extend 03 lands"; PRD says typed event extensions are first runtime capability. | high | low | Verify EXTEND_03 docs/tests mark `onEvent` runtime-supported before scaffolding templates claim runtime behavior. | Generated extensions could be misleading if EXTEND_03 did not actually land. |
| Reload should refresh the active daemon watcher/event runtime, not merely re-run validation. | PRD says reload/restart daemon if needed; after EXTEND_03 event hooks may be held in watcher/engine memory. This is inferred from planned runtime wiring. | medium | medium | Inspect final EXTEND_03 implementation for where registry is stored; add reload route tests against that actual wiring. | If reload semantics are wrong, users may edit/scaffold an extension and see no runtime effect until manual daemon restart. |
| Restarting the in-process watcher is acceptable reload behavior when auto-build is active. | `server-main.ts` comments say stopping watcher does not kill in-flight PRD subprocesses; watcher creates a fresh `EforgeEngine` on start. | medium | medium | Add an integration/unit test for reload while watcher state is running, or document limitation if hard to test. | Could accidentally pause auto-build, duplicate scheduler loops, or surprise users if not handled carefully. |
| A derived `enabled`/`loadable` field satisfies acceptance without implementing full enable/disable state. | Epic acceptance asks list/show include enabled state but also says richer enable/disable semantics are follow-ups. | medium | low | Choose precise field semantics and test excluded/untrusted/loaded cases. | Ambiguous UI if users interpret derived enabled as mutable per-extension state. |
| Scope mapping should expose `local|project|user` but use canonical resolver scopes internally. | PRD command syntax uses local/project/user; existing scopes package uses `project-local`, `project-team`, `user`. | high | low | Unit-test scaffold paths under temporary XDG config and project dirs. | Files could be written to wrong scopes, breaking trust/provenance expectations. |
| Claude Code plugin file changes may or may not be required. | Project instruction says keep `eforge-plugin/` and `packages/pi-eforge/` in sync; current grep showed MCP proxy extension tooling but not a plugin-specific extension tool file. | medium | low | Search `eforge-plugin/` during implementation; if plugin files change, bump `eforge-plugin/.claude-plugin/plugin.json`. | User-facing parity/versioning could drift. |

No low-confidence/high-impact assumption remains unresolved for planning. The main implementation risk is reload semantics, which is medium-confidence and should be validated against the final EXTEND_03 runtime wiring before coding.

### Profile signal

Recommended profile: **Excursion**.

Rationale: This is a cohesive management-surface feature across client route types, daemon routes, CLI commands, MCP/Pi tools, tests, and docs. It is multi-package and user-facing but does not need delegated subsystem planning. Much of the list/show/validate surface already exists, so the core work is extending the existing pattern with scaffold and reload plus tightening provenance output. Expedition would be unnecessary unless EXTEND_03 lands with a much more complex runtime cache/reload architecture than expected.

## Scope

### In scope

1. Complete the MVP management command set:
   - keep and harden `eforge extension list`, `show`, and `validate`
   - add `eforge extension new <name> [--scope local|project|user] [--template <template>]`
   - add `eforge extension reload`
2. Add matching daemon API routes, request/response types, and `@eforge-build/client` helpers for scaffold/new and reload. Existing list/show/validate helpers should remain the single source used by CLI/MCP/Pi.
3. Extend the Pi tool and Claude Code MCP proxy `eforge_extension` surface to include `new` and `reload` actions with parity.
4. Scaffold a safe, minimal extension template:
   - default scope: project-local `.eforge/extensions/`
   - default format: TypeScript `.ts`
   - default template: event hook compatible with EXTEND_03
   - generated module imports from `@eforge-build/extension-sdk` and uses `defineEforgeExtension` or typed `EforgeExtensionAPI`
5. Support at least a small template set appropriate for the MVP, e.g. `event-logger` and `blank`. Additional templates can be included if trivial, but avoid promising unsupported runtime capabilities.
6. Ensure scaffold path safety:
   - validate extension names
   - prevent overwriting unless an explicit `--force` / request flag is included, if force is implemented
   - resolve scope directories via `@eforge-build/scopes`, not hand-built paths
7. Make list/show output include an explicit enabled/loadable state in addition to existing status, scope, source, trust, path, entrypoint, diagnostics, shadows, registrations, format/layout/strategy.
8. Implement reload semantics suitable for the post-EXTEND_03 runtime:
   - reload discovered extensions for management responses
   - if persistent daemon auto-build watcher is active and event hooks are in memory, restart/reinitialize the watcher so future events use the new registry without killing in-flight child builds
9. Update tests for daemon routes, client helpers, CLI commands, Pi/MCP parity, and docs.
10. Update `docs/extensions.md`, `docs/extensions-api.md` if needed, package README/help text, and user-facing command descriptions.

### Out of scope

- Event replay testing and `eforge extension test` implementation, tracked by EXTEND_07.
- Full enable/disable semantics or persistent per-extension state beyond existing include/exclude config.
- Promote/demote workflows.
- Trust prompt/hash hardening for committed project extensions.
- `/eforge:extend` natural-language authoring UX.
- Scaffolding templates for unsupported runtime capability families such as policy gates, profile routers, agent tools, input sources, reviewer perspectives, or validation providers, unless clearly marked as capture-only examples.

## Acceptance Criteria

1. `eforge extension list`, `show`, and `validate` continue to work and retain existing JSON/non-JSON behavior.
2. `eforge extension new <name>` creates a new extension file in the requested scope:
   - default `--scope local` writes under `.eforge/extensions/`
   - `--scope project` writes under `eforge/extensions/`
   - `--scope user` writes under `~/.config/eforge/extensions/`, respecting XDG config behavior through `@eforge-build/scopes`
3. `extension new` validates names, creates parent directories, refuses unsafe paths, and does not overwrite an existing extension unless an explicit force option is implemented and used.
4. Scaffolded default template is TypeScript, imports from `@eforge-build/extension-sdk`, and registers an EXTEND_03-supported event hook.
5. At least one additional minimal template, `blank` or equivalent, is available, or unsupported template names produce a clear error listing supported templates.
6. Daemon API routes and `@eforge-build/client` helpers exist for list/show/validate/new/reload, with no inlined route literals in consumers.
7. `eforge extension reload` calls the daemon reload route and reports what was reloaded, whether the watcher/runtime was refreshed, and any diagnostics.
8. Reload does not kill in-flight PRD child workers. It applies to future extension discovery/runtime use and documents any limitations in the response/help text.
9. Pi extension and Claude Code MCP proxy `eforge_extension` tool include matching `new` and `reload` actions and use shared client helpers.
10. List/show output includes explicit enablement/loadability information plus existing scope, path, status, trust, source, diagnostics, shadows, registrations, format/layout, and strategy/provenance.
11. Validation of an ad-hoc path remains path-safe and rejects traversal/out-of-project paths as current tests require.
12. Event replay/test implementation remains deferred to EXTEND_07; if a placeholder command/action is added, it returns an actionable not-yet-supported message.
13. Tests cover route constants/client helpers, daemon routes, scaffold success/failure, reload response, CLI command registration/behavior, Pi/MCP parity, and docs/help text drift where practical.
14. Documentation updates explain the MVP commands, scope mapping, scaffold templates, reload semantics, trust caveat for project-team extensions, and deferred commands.
