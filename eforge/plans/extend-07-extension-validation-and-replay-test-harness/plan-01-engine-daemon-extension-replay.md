---
id: plan-01-engine-daemon-extension-replay
name: Engine and Daemon Extension Replay Harness
branch: extend-07-extension-validation-and-replay-test-harness/plan-01-engine-daemon-extension-replay
agents:
  builder:
    effort: high
    rationale: Adds a new reusable execution harness plus public daemon/client route
      shapes and security-sensitive route handling for arbitrary extension code
      execution.
  reviewer:
    effort: high
    rationale: Review must cover API shape, security guard placement, and reuse of
      existing extension runtime semantics.
  tester:
    effort: high
    rationale: Route, fixture parsing, event filtering, timeout/failure diagnostics,
      and DB replay paths need focused verification.
---

# Engine and Daemon Extension Replay Harness

## Architecture Context

Native extensions already have discovery, trust gating, loader-time registration capture, projection for management responses, and timeout-bounded `onEvent` runtime execution via `withNativeEventHooks`. The missing foundation is a reusable dry-run harness that loads selected extensions, validates event inputs, replays canonical `EforgeEvent` objects through the existing runtime, and exposes the result through client-owned daemon wire contracts.

Project constraints to preserve:

- Event shapes are owned by `@eforge-build/client`; fixture and DB events must validate through `safeParseEforgeEvent`.
- Daemon route constants, request/response types, and helpers live in `packages/client`; monitor and CLI/Pi/MCP consumers must not inline `/api/...` paths.
- Extension replay executes arbitrary extension code, so the daemon route must use the same local-only/cross-origin guard style as scaffold and reload.
- Replay is dry-run output only. It must not write replay diagnostic events to the monitor DB.
- Only `onEvent` registrations execute in this slice; all other registration families are summarized as captured but not replayed.

## Implementation

### Overview

Create an engine-level replay module that can parse fixture files, load configured/named/ad-hoc extensions through `loadNativeExtensions`, compute event-hook match summaries with the same glob semantics as shell hooks, execute matching `onEvent` handlers through `withNativeEventHooks`, and return a structured result. Add client-owned request/response contracts and a new daemon `POST /api/extensions/test` route that supplies fixture or monitor run events to the engine helper.

### Key Decisions

1. **Replay uses the existing event runtime.** The new helper must wrap an async generator of selected events with `withNativeEventHooks` rather than invoking handlers directly. This preserves timeout, failure, logger, `ctx.exec.run`, and drain behavior.
2. **Fixture parsing is strict after format detection.** Support JSON single event, JSON array of events, and JSONL event objects. Each event must pass `safeParseEforgeEvent`; invalid fixture objects produce `valid: false` and diagnostics.
3. **The daemon route is `POST /api/extensions/test`.** Testing executes extension code and may run `ctx.exec.run`, so the route must be local-only and cross-origin guarded like scaffold/reload, even though it does not persist state.
4. **Run replay resolves to session history.** `run: "latest"` uses `db.getLatestSessionId()`. Any other `run` value first resolves a run ID to its session ID via the existing `resolveSessionId` pattern, then replays all events for that session.
5. **Static and replay outcomes share one pass/fail flag.** `valid` is false when load/static diagnostics include errors, fixture/run source resolution fails, fixture events fail canonical validation, or replay emits `extension:event-handler:failed`/`extension:event-handler:timeout`. Zero matching hooks is a valid replay with an empty `matches` array.
6. **Conservative schema-shape checks happen at registration capture.** `registerTool` should reject non-object input schemas and non-object-root schemas (for example `type: "string"`) because the public SDK advertises `TObject`; avoid a broad JSON Schema validator that could reject valid TypeBox constructs.

## Scope

### In Scope

- New `packages/engine/src/extensions/replay.ts` (or equivalent) with:
  - `parseExtensionEventFixtureFile(...)` for JSON, JSON array, and JSONL fixtures.
  - `testNativeExtensions(...)` / `replayNativeExtensionEvents(...)` helper that accepts loader options, optional selection, `EforgeEvent[]`, event-type filter, timeout, cwd, and source metadata.
  - Structured summaries for selected source, event counts, matches, diagnostic events, static diagnostics, and deferred registration families.
- Export the replay helper and types from `packages/engine/src/extensions/index.ts`.
- Enhance `packages/engine/src/extensions/recorder.ts` static validation for `registerTool({ inputSchema })` root object schema shape without changing the public SDK API.
- Client route and wire additions:
  - `API_ROUTES.extensionTest = '/api/extensions/test'` in `packages/client/src/routes.ts`.
  - `ExtensionTestRequest`, `ExtensionTestResponse`, replay source/count/match/diagnostic/deferred summary types in `packages/client/src/types.ts`.
  - `apiTestExtension` helper in `packages/client/src/api/extensions.ts`.
  - Re-export helper and types from `packages/client/src/index.ts`.
- Monitor daemon route in `packages/monitor/src/server.ts`:
  - Parse and validate `ExtensionTestRequest` body.
  - Accept optional `name` or `path`, but not both.
  - Accept zero replay sources for static-only testing, or exactly one replay source: `fixture` or `run`.
  - Validate ad-hoc extension paths and fixture paths under the project cwd using the existing realpath containment pattern.
  - For fixtures, call the engine fixture parser.
  - For runs, hydrate DB rows with `parseEventRow`/`safeParseEforgeEvent`, skip invalid rows, and do not insert replay output into the DB.
  - Use `extensions.eventHookTimeoutMs` from resolved config.
  - Return typed `ExtensionTestResponse` through the shared route constant.
- Tests for engine replay and daemon/client route behavior.

### Out of Scope

- CLI rendering and `eforge extension test` command registration; plan-02 owns those consumer surfaces.
- Pi and Claude Code MCP `eforge_extension` `test` action; plan-02 owns those tools.
- Runtime execution for `onAgentRun`, `beforePlanMerge`, profile routers, input sources, reviewer perspectives, validation providers, or custom tools.
- Extension sandboxing, trust prompts, enable/disable/promote/demote workflows, and persistence of replay output.
- Breaking daemon API version bump; this plan adds an additive route and must not change existing route shapes.

## Files

### Create

- `packages/engine/src/extensions/replay.ts` — fixture parsing, extension selection, match computation, dry-run event replay, deferred registration summaries, and replay result types.
- `test/extension-replay.test.ts` — engine-level replay coverage for fixture parsing, static validation, event filtering, matches, failures/timeouts, no-match success, and deferred family summaries.

### Modify

- `packages/engine/src/extensions/index.ts` — export replay helpers and result/source/match/deferred types.
- `packages/engine/src/extensions/recorder.ts` — add conservative `registerTool` input-schema root validation and diagnostics.
- `packages/client/src/routes.ts` — add `extensionTest` route constant.
- `packages/client/src/types.ts` — add `ExtensionTestRequest`, `ExtensionTestResponse`, and nested replay summary types.
- `packages/client/src/api/extensions.ts` — add `apiTestExtension({ cwd, body })` using `API_ROUTES.extensionTest`.
- `packages/client/src/index.ts` — re-export `apiTestExtension` and the new request/response/summary types.
- `packages/monitor/src/server.ts` — add guarded `POST /api/extensions/test` route, request validation, fixture/run event loading, engine helper invocation, and response mapping.
- `test/extension-loader.test.ts` — add static validation coverage for invalid root `inputSchema` shapes.
- `test/extension-tooling-routes.test.ts` — add route/client helper coverage for fixture replay, `run: "latest"`, run ID/session ID resolution, event filtering, invalid fixture, invalid path, and local/cross-origin guard behavior.
- `test/extension-tooling-wiring.test.ts` — update route/helper constant assertions for `extensionTest` if keeping route wiring assertions in the shared wiring suite.

## Response Shape Guidance

Use client-owned types with a structure equivalent to:

```ts
interface ExtensionTestResponse {
  valid: boolean;
  source: {
    kind: 'none' | 'fixture' | 'run';
    fixture?: string;
    run?: string;
    sessionId?: string;
    event?: string;
  };
  extensions: ExtensionEntry[];
  diagnostics: ExtensionDiagnostic[];
  replay: {
    inputEventCount: number;
    filteredEventCount: number;
    emittedEventCount: number;
    diagnosticEventCount: number;
  };
  matches: Array<{
    eventIndex: number;
    eventType: string;
    extensionName: string;
    extensionPath: string;
    pattern: string;
  }>;
  emittedDiagnostics: Array<Extract<EforgeEvent, { type: 'extension:event-handler:failed' | 'extension:event-handler:timeout' }>>;
  deferredRegistrations: Array<{
    family: 'agentRunHooks' | 'policyGates' | 'profileRouters' | 'inputSources' | 'reviewerPerspectives' | 'validationProviders' | 'tools';
    count: number;
    extensions: Array<{ name: string; path: string; count: number }>;
  }>;
}
```

Exact property names can differ if tests and docs use the final names consistently, but the response must include source, counts, matches, emitted diagnostics, static diagnostics, and deferred families.

## Verification

- [ ] `test/extension-replay.test.ts` proves JSON single-event, JSON array, and JSONL fixtures parse into canonical `EforgeEvent[]`, while malformed JSON and schema-invalid event objects produce `valid: false` diagnostics.
- [ ] Engine replay tests prove `matches` includes extension name, path, pattern, event type, and event index for exact and glob subscriptions.
- [ ] Engine replay tests prove `--event`-equivalent filtering reduces replayed events and does not invoke hooks for filtered-out event types.
- [ ] Engine replay tests prove handler throws and timeouts appear in `emittedDiagnostics` and set `valid: false`.
- [ ] Engine replay tests prove non-event registration families are counted in `deferredRegistrations` and their handlers are not invoked.
- [ ] Daemon route tests prove `apiTestExtension` uses `API_ROUTES.extensionTest` and returns fixture replay summaries through the lockfile client path.
- [ ] Daemon route tests prove `run: "latest"`, a run ID, and a session ID all replay the expected session events from `MonitorDB`.
- [ ] Daemon route tests prove `POST /api/extensions/test` rejects cross-origin or non-loopback callers with 403.
- [ ] Daemon route tests prove replay output is not inserted into `events` after a handler failure or timeout.
- [ ] `pnpm type-check` passes after plan-01.