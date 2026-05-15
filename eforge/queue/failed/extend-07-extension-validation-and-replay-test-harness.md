---
title: EXTEND_07: Extension Validation and Replay Test Harness
created: 2026-05-15
profile: pi-codex-5-5
---

# EXTEND_07: Extension Validation and Replay Test Harness

## Problem / Motivation

Generated extensions can be listed and load-validated, and event hooks can run during real builds, but there is no first-class way to test an extension against known events before reloading it into a live daemon/worker flow.

This leaves `/eforge:extend`-style authoring without a concrete verification loop: agents can scaffold an extension, but cannot prove what handlers would match, whether fixture events are valid, whether recent monitor events exercise the extension, or what diagnostics/actions would be produced.

Affected users are extension authors and agents creating extensions from natural-language requests. The immediate gap matters now because the extension management MVP already exists (`new/list/show/validate/reload`) and docs explicitly mark event replay testing as deferred.

### Context

Evidence reviewed:

- PRD: `docs/prd/typescript-extensibility.md` defines EXTEND_07 as static validation plus event replay testing, after extension management MVP and typed event runtime.
- Roadmap: `docs/roadmap.md` lists Native TypeScript extensions under Extensibility and explicitly includes event-replay testing.
- Current implementation:
  - `packages/engine/src/extensions/loader.ts` discovers/loads TS/JS extensions with `jiti`/dynamic import, validates factory shape, captures recorder diagnostics, and produces a `NativeExtensionRegistry`.
  - `packages/engine/src/extensions/recorder.ts` validates registration shapes enough to reject invalid handlers/named registrations and duplicate named registrations.
  - `packages/engine/src/extensions/event-runtime.ts` executes only `onEvent` hooks today, timeout-bounds handlers, emits `extension:event-handler:failed` and `extension:event-handler:timeout`, and exposes `withNativeEventHooks` for replayable async-generator streams.
  - `packages/monitor/src/server.ts` exposes `extension list/show/validate/new/reload` routes and already hydrates monitor DB event rows through `safeParseEforgeEvent` for run-state responses.
  - `packages/client/src/api/extensions.ts`, `packages/client/src/routes.ts`, and `packages/client/src/types.ts` own the daemon/client route surface and wire types.
  - `packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/mcp-proxy.ts`, and `packages/pi-eforge/extensions/eforge/index.ts` expose matching extension management commands/tools.
- Current docs: `docs/extensions.md` still says event replay testing is deferred; `docs/extensions-api.md` documents onEvent runtime support and non-event capability execution as deferred.
- Tests to extend: `test/extension-event-runtime.test.ts`, `test/extension-tooling-routes.test.ts`, `test/extension-cli-commands.test.ts`, and `test/extension-tooling-wiring.test.ts` already cover the adjacent runtime, daemon, CLI, and Pi/MCP parity surfaces.

Classification: **feature / focused** with high confidence. This adds a user-facing validation/test capability across existing extension management surfaces, but it can be implemented as one cohesive slice without delegated module planning.

### Profile Signal

Recommended profile: **Excursion**.

Rationale: this is a multi-surface feature touching engine, client, daemon, CLI, Pi/MCP integrations, docs, and tests, but the work is cohesive and can be planned as one sequence around a single new replay/test API. It does not require delegated module planners or independently-designed subplans, so Expedition would be heavier than needed. It is not an Errand because it changes public CLI/API/tool surfaces and executes arbitrary extension code in a dry-run path.

## Goal

Add a first-class extension validation and replay test harness so configured, named, or ad-hoc extensions can be statically validated and tested against fixture or monitor/daemon run events before being reloaded into live daemon/worker flows.

The outcome should provide a structured summary of replay behavior, diagnostics, matching event hook invocations, and deferred non-event registrations across the engine, daemon/client API, CLI, Pi, Claude Code MCP tooling, docs, and tests.

## Approach

Implement a reusable engine-level validation/replay harness and expose it through shared client route contracts, daemon routes, CLI commands, and Pi/MCP tooling.

### Key implementation requirements

- Add a reusable engine-level extension validation/replay harness that:
  - loads configured, named, or ad-hoc path extensions using existing discovery/loader logic;
  - performs static validation for loadability, factory shape, registration validity, duplicate named registrations, and schema-like registered tool/provider data where currently possible;
  - accepts event fixtures from files;
  - replays selected monitor/daemon run events from the daemon DB;
  - filters replay input by event type when requested;
  - executes currently-supported `onEvent` hooks through the existing timeout-bounded event runtime;
  - returns a structured summary of events replayed, matching extension/pattern invocations, emitted extension diagnostics, and deferred/non-replayed registration families.
- Add daemon/client API support for extension testing, using shared `@eforge-build/client` route constants, helpers, and wire types.
- Add CLI support:

  ```bash
  eforge extension test [nameOrPath] [--run latest|<sessionId-or-runId>] [--event <type>] [--fixture <path>] [--json]
  ```

- Extend Pi and Claude Code MCP `eforge_extension` tools with a matching `test` action so `/eforge:extend` can call validation/replay tooling once the authoring skill exists.
- Update docs that currently say replay testing is deferred.
- Add focused unit/integration tests for engine replay, daemon routes/client helpers, CLI rendering/exit behavior, and Pi/MCP parity.

### Existing patterns to follow

- `loadNativeExtensions` already centralizes discovery/trust/load behavior; replay should not bypass it.
- `withNativeEventHooks` already provides timeout/failure semantics; replay should not create separate handler semantics.
- `safeParseEforgeEvent` is the canonical event validator and should be used for fixture/row hydration.
- Daemon route types/shapes belong in `@eforge-build/client`; monitor/CLI/Pi/MCP should consume those helpers/types.

### Design decisions

1. **Make replay an engine helper, not daemon-only logic.**
   - Decision: implement a reusable engine helper that takes extension selection options plus an `EforgeEvent[]` and returns a structured replay result.
   - Rationale: CLI/daemon tests and future authoring flows need one canonical behavior. This also keeps event execution semantics close to `withNativeEventHooks`.

2. **Use `@eforge-build/client` for daemon wire contracts.**
   - Decision: define `ExtensionTestRequest/Response` in `packages/client/src/types.ts`, add `API_ROUTES.extensionTest`, and add `apiTestExtension` in `packages/client/src/api/extensions.ts`.
   - Rationale: project convention forbids inline `/api/...` paths and parallel daemon wire shapes outside the client package.

3. **Treat replay as dry-run execution of supported event hooks only.**
   - Decision: replay executes only `onEvent` registrations. Other registrations are returned in summary as captured/deferred, not invoked.
   - Rationale: current docs and runtime state confirm only event hooks execute today. Executing policy gates/agent hooks/custom tools would silently pre-implement later epics and risk incompatible semantics.

4. **Report matches separately from emitted events.**
   - Decision: compute match summaries from loaded `registry.eventHooks` and event types before/while replaying, and separately collect output events/diagnostics from `withNativeEventHooks`.
   - Rationale: successful event handlers often produce no diagnostic event. Users still need to know which extension/pattern would run.

5. **Fixture format should be forgiving but canonical after parsing.**
   - Decision: support JSON single event, JSON array of events, and optionally JSONL event objects. Every parsed object must pass `safeParseEforgeEvent` after minimal back-compat patching only if explicitly supporting monitor-row-shaped fixtures.
   - Rationale: single/array JSON is agent-friendly; JSONL is convenient for event-log exports. Canonical validation prevents tests from exercising impossible wire events.

6. **Monitor run replay should use session-level event history.**
   - Decision: `--run latest` resolves from `apiGetRuns`/daemon DB latest run; `--run <id>` should accept either a run ID or session ID by reusing the existing `resolveSessionId` pattern in `server.ts`.
   - Rationale: existing run-state endpoints already expose session-level history and resolve run IDs to session IDs, which best represents a build session rather than one subprocess.

7. **Security posture: local-only daemon route.**
   - Decision: guard `/api/extensions/test` like scaffold/reload mutations because it loads and executes arbitrary extension TypeScript even though it does not persist state.
   - Rationale: replay can run extension code and `ctx.exec.run`, so remote/cross-origin callers must not be able to trigger it.

8. **CLI failure semantics.**
   - Decision: `eforge extension test` exits nonzero when static validation fails, fixture/run source is invalid, or replay produces extension handler failure/timeout diagnostics. No-match replays should be successful but clearly reported.
   - Rationale: authoring agents need a reliable pass/fail signal without treating an unexercised fixture as a process failure.

9. **Do not persist replay diagnostics to monitor DB.**
   - Decision: return replay diagnostics in the response only.
   - Rationale: replay is test output, not actual build lifecycle history; persisting it would confuse monitor status and downstream shell hooks.

### Code impact

Likely files/modules to change, based on repository search and current implementation reads:

- Engine extension runtime:
  - Add `packages/engine/src/extensions/replay.ts` or `validation.ts` for reusable validation/replay orchestration.
  - Update `packages/engine/src/extensions/index.ts` exports for new result types/helpers.
  - Possibly extend `packages/engine/src/extensions/types.ts` with replay/static-validation result types if they are engine-internal; public daemon wire types should live in `@eforge-build/client`.
  - Possibly enhance `packages/engine/src/extensions/recorder.ts` static checks for registered schema objects, especially `registerTool({ inputSchema })`, without changing current public SDK semantics.
  - Reuse `packages/engine/src/extensions/event-runtime.ts` and `packages/engine/src/hooks.ts` pattern matching rather than creating a parallel hook executor.
- Client wire/API surface:
  - Update `packages/client/src/routes.ts` with an `extensionTest` route constant.
  - Update `packages/client/src/types.ts` with `ExtensionTestRequest`, source/result/diagnostic summary types, and `ExtensionTestResponse`.
  - Update `packages/client/src/api/extensions.ts` and `packages/client/src/index.ts` exports.
- Monitor daemon:
  - Update `packages/monitor/src/server.ts` with `/api/extensions/test` route handling.
  - Reuse existing config loading, `loadExtensionResponse`/loader paths where practical.
  - Reuse/factor event-row hydration currently done by local `parseEventRow` and `db.getEventsBySession`; `resolveSessionId` already maps run IDs to session IDs.
  - Add local-origin mutation-style guard only if the route executes arbitrary extension code. Although test is a dry run, it loads and runs extension handlers, so treating it like a local-only unsafe extension operation is prudent.
- CLI:
  - Update `packages/eforge/src/cli/index.ts` extension subcommands with `test` plus non-JSON rendering and nonzero exit behavior.
  - Keep path/name detection consistent with `validate` via `isExtensionPathArg`.
- MCP/Pi surfaces:
  - Update `packages/eforge/src/cli/mcp-proxy.ts` `eforge_extension` schema/handler to include `test`.
  - Update `packages/pi-eforge/extensions/eforge/index.ts` `eforge_extension` schema/handler to include `test`.
  - Use shared client helper; do not inline daemon paths.
- Docs:
  - `docs/extensions.md`, `docs/extensions-api.md`, possibly `packages/extension-sdk/README.md` for the management/replay status table.
- Tests:
  - Add `test/extension-replay.test.ts` for fixture parsing, match summaries, event filtering, invalid fixtures, failed/timeout diagnostics, and deferred registration summaries.
  - Extend `test/extension-tooling-routes.test.ts` for daemon/client route behavior against fixtures and monitor DB run events.
  - Extend `test/extension-cli-commands.test.ts` for command registration, JSON/non-JSON rendering, and exit code on invalid/replay diagnostic failures.
  - Extend `test/extension-tooling-wiring.test.ts` for route constants, helper usage, command parity, and docs drift assertions.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| Replay should execute only `onEvent` hooks in this epic. | Read `docs/extensions.md`, `docs/extensions-api.md`, `packages/engine/src/extensions/event-runtime.ts`; docs/runtime say `onEvent` is supported and non-event execution is deferred. | high | low | Re-check docs/tests after implementation; add tests that non-event registrations are reported but not invoked. | Medium: accidentally executing future hook families could create unsafe or incompatible semantics. |
| `/eforge:extend` itself is not implemented yet, so EXTEND_07 should expose callable tooling for future use rather than build the full authoring skill. | Filename search under `packages/pi-eforge` and `eforge-plugin` found no extend skill/command. | high | low | Re-run `find`/`rg` for `eforge:extend` before implementation. | Low/medium: if an unsearched command exists, docs/tool integration scope may need minor adjustment. |
| Event fixtures can use canonical `EforgeEvent` validation without inventing a separate fixture schema. | `packages/client/src/events.schemas.ts` exports `safeParseEforgeEvent`; `server.ts` already uses it to hydrate monitor rows. | high | low | Implement fixture parser tests around valid/invalid event objects. | Medium: a separate fixture schema could drift from daemon wire events. |
| Existing monitor DB APIs can supply selected run/session events for replay. | Read `packages/monitor/src/db.ts` (`getEventsBySession`, `getLatestSessionId`, `getSessionRuns`) and `server.ts` `resolveSessionId`/run-state behavior. | high | low | Add route tests with inserted runs/events for latest, run ID, and session ID. | Medium: if route code uses the wrong identifier, replay from real history would appear empty. |
| Static schema validation can improve registered tool schema checks without a large SDK redesign. | `recorder.ts` currently checks `inputSchema` is an object only; `extension-sdk` exposes TypeBox. | medium | medium | During implementation, verify TypeBox has a suitable guard or use conservative JSON-schema-shape diagnostics; keep diagnostics warnings if strict validation is uncertain. | Low/medium: over-strict checks could reject valid JSON schemas; under-strict checks may not fully satisfy “schemas” validation. |
| Local-only guard is appropriate for extension test route. | `server.ts` already guards scaffold/reload mutations because they affect local filesystem/runtime; replay executes arbitrary extension code via handlers/exec. | high | low | Reuse/extend existing guard test patterns. | High: if wrong and route is remotely callable, extension code execution becomes a security issue. |

No low-confidence/high-impact assumptions remain. The only medium-confidence assumption is schema-validation strictness; it has a bounded implementation path and can be handled conservatively with clear diagnostics/tests.

## Scope

### In scope

- Add a reusable engine-level extension validation/replay harness that:
  - loads configured, named, or ad-hoc path extensions using existing discovery/loader logic;
  - performs static validation for loadability, factory shape, registration validity, duplicate named registrations, and schema-like registered tool/provider data where currently possible;
  - accepts event fixtures from files;
  - replays selected monitor/daemon run events from the daemon DB;
  - filters replay input by event type when requested;
  - executes currently-supported `onEvent` hooks through the existing timeout-bounded event runtime;
  - returns a structured summary of events replayed, matching extension/pattern invocations, emitted extension diagnostics, and deferred/non-replayed registration families.
- Add daemon/client API support for extension testing, using shared `@eforge-build/client` route constants, helpers, and wire types.
- Add CLI support: `eforge extension test [nameOrPath] [--run latest|<sessionId-or-runId>] [--event <type>] [--fixture <path>] [--json]`.
- Extend Pi and Claude Code MCP `eforge_extension` tools with a matching `test` action so `/eforge:extend` can call validation/replay tooling once the authoring skill exists.
- Update docs that currently say replay testing is deferred.
- Add focused unit/integration tests for engine replay, daemon routes/client helpers, CLI rendering/exit behavior, and Pi/MCP parity.

### Out of scope

- Implementing the full `/eforge:extend` natural-language authoring skill. No existing skill files were found; this epic should unblock it by exposing callable tooling.
- Replay/execution for non-event capability families:
  - `beforePlanMerge`
  - `onAgentRun`
  - profile routers
  - input sources
  - reviewer perspectives
  - validation providers
  - custom tools

  Static registration reporting is in scope; behavioral execution remains deferred to those runtime epics.

- Trust prompts, enable/disable/promote/demote workflows, extension packaging/install, or sandboxing.
- Persisting replay diagnostics/events to monitor history; replay is a dry-run/test operation.

### Early assumptions / unknowns

- Fact: no `/eforge:extend` skill files are present under `packages/pi-eforge` or `eforge-plugin` from a filename search, so this epic should expose tooling that a future `/eforge:extend` skill can call rather than implement the full authoring skill here.
- Assumption: EXTEND_07 should replay currently-supported event hooks only; non-event registrations should remain statically reported as captured/deferred until their runtimes land. Confidence high because docs and event runtime state only `onEvent` execution is supported today.

## Acceptance Criteria

- `eforge extension validate` continues to work, and static validation covers loadability, default-export factory shape, registered hook/spec shape, duplicate named registrations, and registered schema-like objects with clear diagnostics.
- A new `eforge extension test` command exists and supports:
  - configured extensions, a single extension name, or an ad-hoc extension file/directory path;
  - `--fixture <path>` for event fixture files;
  - `--run latest` and `--run <sessionId-or-runId>` for recent monitor/daemon events;
  - `--event <event-type>` filtering;
  - `--json` machine-readable output.
- Event fixture inputs are validated with the canonical `safeParseEforgeEvent`/`EforgeEventSchema` path; invalid fixtures return `valid:false`/nonzero CLI exit with actionable diagnostics.
- Replay executes matching `onEvent` hooks via `withNativeEventHooks` under the configured/default event hook timeout and reports any `extension:event-handler:failed` or `extension:event-handler:timeout` diagnostics.
- Replay output explains what happened: source used, event count, filtered event count, matching extension/pattern invocations, emitted diagnostics, and non-event registration families that were captured but not replayed.
- Daemon API/client helpers expose the same structured response without inlining `/api/...` paths outside `@eforge-build/client` route constants/helpers.
- Pi and Claude Code MCP `eforge_extension` tools accept `action: "test"` with matching parameters and validation rules.
- Docs in `docs/extensions.md` / `docs/extensions-api.md` reflect the supported replay scope and no longer claim event replay is deferred.
- Tests cover engine replay, route/client behavior, CLI behavior, and Pi/MCP parity.
- `pnpm type-check` and relevant vitest suites pass.
