---
id: plan-03-daemon-mcp-pi
name: Daemon Trigger + MCP Tool + Pi Parity
depends_on:
  - plan-02-cli-and-engine-api
branch: build-failure-recovery-agent/daemon-mcp-pi
agents:
  builder:
    effort: high
    rationale: Touches three consumer surfaces (daemon HTTP, MCP proxy, Pi
      extension) plus a route-version bump. Cross-package coordination per the
      AGENTS.md sync rule warrants high effort.
---

# Daemon Trigger + MCP Tool + Pi Parity

## Architecture Context

This plan wires the recovery CLI into the daemon (so failed builds auto-trigger advisory recovery) and exposes parity surfaces in MCP and the Pi extension per the AGENTS.md sync rule.

Key constraints:
- **Subprocess spawn, not in-process.** The daemon already runs builds as child processes via `workerTracker.spawnWorker()` (`packages/monitor/src/server.ts:7,89,804`). Recovery follows the same pattern: when `plan:build:failed` is observed, spawn `eforge recover <setName> <prdId>` as a fresh child. The eforge process that just failed is not reused.
- **No build permit consumption.** Recovery does not call into `concurrency.ts`; `workerTracker` does not gate it on build slots. Verified by Acceptance Criterion 6.
- **Shared client contract.** New route added to `API_ROUTES` in `packages/client/src/routes.ts`. `DAEMON_API_VERSION` bumps if breaking; this is purely additive (new route, no existing route changes), so the version bump is a minor increment to signal capability discovery, not a breaking change.
- **Plugin/Pi parity.** Per AGENTS.md, every consumer-facing capability must be in both `eforge-plugin/` and `packages/pi-eforge/`. Both get an MCP-tool surface to trigger recovery and read sidecars.

## Implementation

### Overview

1. **Client route registry**: add `recover: '/api/recover'` and `readRecoverySidecar: '/api/recovery/sidecar'` to `API_ROUTES` in `packages/client/src/routes.ts`. Add typed request/response interfaces (`RecoverRequest { setName: string; prdId: string }`, `RecoverResponse { sessionId: string; pid: number }`, `ReadSidecarRequest { setName: string; prdId: string }`, `ReadSidecarResponse { markdown: string; json: RecoveryVerdictSidecar }`). Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts`. Add typed helpers `apiRecover` and `apiReadRecoverySidecar` in `packages/client/src/api/`.
2. **Daemon route + trigger**: in `packages/monitor/src/server.ts`:
   - Register `POST /api/recover` handler that validates `{ setName, prdId }`, spawns `eforge recover <setName> <prdId>` via `workerTracker.spawnWorker(...)` (or the equivalent existing helper used by `/api/enqueue`), and returns `{ sessionId, pid }`. Recovery subprocesses are tagged so they do not consume a build permit (the existing `workerTracker` is concurrency-agnostic; verify no permit acquisition path is hit, add a recovery-specific spawn helper if needed).
   - Register `GET /api/recovery/sidecar?setName=...&prdId=...` handler that reads the two sidecar files and returns the markdown + parsed JSON.
   - Add a listener on persisted events: when a `plan:build:failed` event is recorded for a session, look up the session's `setName`/`prdId` and spawn `eforge recover` as a clean subprocess (mirror the dispatch path the engine uses for queue-driven builds). Emit `recovery:start` via the daemon's broadcast channel so monitor UI sees the trigger immediately.
3. **MCP tool**: add `eforge_recover` tool in `packages/eforge/src/cli/mcp-proxy.ts` and `packages/eforge/src/cli/mcp-tool-factory.ts` using the existing `createDaemonTool` factory. Tool calls `apiRecover(daemonRequest, { setName, prdId })`. Add a companion `eforge_read_recovery_sidecar` tool that calls `apiReadRecoverySidecar`.
4. **Pi extension parity**: in `packages/pi-eforge/extensions/eforge/index.ts`, register two tools mirroring the MCP ones: `recover` and `readRecoverySidecar`. Both call `daemonRequest()` with the new `API_ROUTES` entries.
5. **Plugin version bump**: `eforge-plugin/.claude-plugin/plugin.json` from `0.8.1` to `0.9.0`.

### Key Decisions

1. **Daemon spawns CLI, no in-process recovery.** Cleanest isolation per the PRD; reuses existing `workerTracker` infrastructure; avoids re-using a process that just crashed.
2. **Trigger lives next to event persistence in `server.ts`.** The daemon already observes `plan:build:failed` when persisting events at `server.ts:1224`; trigger logic hooks the same path. Idempotency: skip if a `<prdId>.recovery.json` already exists for that prdId (recovery has already run; manual re-trigger via CLI/MCP is the recourse).
3. **Two routes, not one.** Read-sidecar gets its own route so the monitor UI can lazily fetch JSON for the failed-build view (plan-04). Keeping read concerns separate from trigger concerns is cleaner.
4. **`API_ROUTES` + typed helpers, no inlined paths.** Per AGENTS.md, daemon HTTP client lives in `@eforge-build/client`; MCP proxy and Pi extension both import the helpers.
5. **Plugin version bump to 0.9.0** signals the new capability; per AGENTS.md the plugin and npm package versions are independent.

## Scope

### In Scope
- New routes `recover` and `readRecoverySidecar` in `API_ROUTES` with typed request/response and helper functions.
- `DAEMON_API_VERSION` bump.
- Daemon `POST /api/recover` handler + `GET /api/recovery/sidecar` handler.
- Daemon auto-trigger of `eforge recover` subprocess on persisted `plan:build:failed` events (with idempotency check on existing sidecar).
- MCP tools `eforge_recover` and `eforge_read_recovery_sidecar`.
- Pi extension parity tools.
- Plugin version bump.
- Daemon-level integration tests asserting the trigger path (using a stubbed engine that emits `plan:build:failed`).

### Out of Scope
- Monitor UI (plan-04).
- Any change to `concurrency.ts` or the build semaphore.
- Auto-execution of any verdict.
- Changes to the existing `failed/` lifecycle in `prd-queue.ts`.

## Files

### Modify
- `packages/client/src/routes.ts` — add `recover` and `readRecoverySidecar` to `API_ROUTES`; add request/response types.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION`.
- `packages/client/src/api/recover.ts` — **CREATE** typed helper `apiRecover(transport, body)`.
- `packages/client/src/api/recovery-sidecar.ts` — **CREATE** typed helper `apiReadRecoverySidecar(transport, query)`.
- `packages/client/src/index.ts` — re-export new helpers.
- `packages/monitor/src/server.ts` — register two new route handlers; add listener path that, on persisted `plan:build:failed`, spawns `eforge recover` as a child process via existing `workerTracker` helpers (idempotent against existing sidecar). Broadcast `recovery:start` over the SSE channel.
- `packages/eforge/src/cli/mcp-proxy.ts` — register `eforge_recover` and `eforge_read_recovery_sidecar` tools using `createDaemonTool`.
- `packages/eforge/src/cli/mcp-tool-factory.ts` — extend tool spec list / shared schemas if needed by the two new tools.
- `packages/pi-eforge/extensions/eforge/index.ts` — register `recover` and `readRecoverySidecar` tools using `daemonRequest` with the new routes.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` from `0.8.1` to `0.9.0`.
- `test/daemon-recovery.test.ts` — **CREATE** integration test: spin up the daemon HTTP server in-process, persist a `plan:build:failed` event for a fixture session, assert `eforge recover` is invoked (mock the spawn) with the correct args. Also test the idempotency check (second `plan:build:failed` for the same prdId with an existing sidecar does not re-spawn).

### Files to reuse
- `packages/monitor/src/server.ts` `workerTracker.spawnWorker` for subprocess spawn.
- `packages/client/src/transport.ts` (or equivalent) `daemonRequest` helper.
- `packages/eforge/src/cli/mcp-tool-factory.ts` `createDaemonTool` factory.

## Verification

- [ ] `pnpm type-check` passes across all touched packages.
- [ ] `pnpm test` passes; `test/daemon-recovery.test.ts` asserts trigger behavior and idempotency.
- [ ] `API_ROUTES.recover` and `API_ROUTES.readRecoverySidecar` are accessible via `import { API_ROUTES } from '@eforge-build/client'`.
- [ ] `DAEMON_API_VERSION` is incremented (test reads the file and asserts the new value matches).
- [ ] `eforge_recover` MCP tool appears in the MCP tool list when the proxy is started (existing MCP discovery test or a new one extends the assertion).
- [ ] Pi extension exposes `recover` and `readRecoverySidecar` tools (existing Pi tool-list test extended).
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field is `0.9.0` (file content assertion in test or explicit grep).
- [ ] Daemon does not invoke any function from `concurrency.ts` along the recovery spawn path (asserted by inspecting the new code path; reviewer verifies).
- [ ] When two consecutive `plan:build:failed` events are persisted for the same `prdId` and a `<prdId>.recovery.json` already exists, the daemon does not spawn a second `eforge recover` subprocess (asserted by spawn-mock call count).
- [ ] Triggering recovery while another build is enqueued does not block that build's worker spawn (asserted by spawning both and checking neither blocks the other).
- [ ] No `'/api/...'` path literals introduced in this plan outside `routes.ts`; all callers use `API_ROUTES` + typed helpers.
