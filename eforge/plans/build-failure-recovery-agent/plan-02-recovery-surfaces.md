---
id: plan-02-recovery-surfaces
name: "Recovery surfaces: CLI, MCP, daemon trigger, monitor UI, Pi parity"
depends_on:
  - plan-01-recovery-engine-core
branch: build-failure-recovery-agent/surfaces
agents:
  builder:
    effort: high
    rationale: Five distinct surface integrations (CLI, MCP, daemon subprocess
      spawn, monitor UI, Pi extension) plus a plugin version bump. Each has its
      own conventions to follow.
---

# Recovery surfaces: CLI, MCP, daemon trigger, monitor UI, Pi parity

## Architecture Context

Plan-01 added the engine core (schema, summary, agent, prompt, sidecar, events). This plan wires it into every consumer-facing surface per the AGENTS.md sync rule: every capability exposed in `eforge-plugin/` (Claude Code) must also be exposed in `packages/pi-eforge/`. The daemon spawns recovery as a *clean subprocess* via the new `eforge recover` CLI subcommand — the failed engine process is not reused. Recovery is read-only and does not claim a build permit, so a queued build still claims its slot on schedule.

## Implementation

### Overview

1. Add the `eforge recover <setName> <prdId>` CLI subcommand in `packages/eforge/src/cli/index.ts`. The command resolves the failed PRD path under `eforge/queue/failed/`, builds the `BuildFailureSummary` (from plan-01), runs the `recovery-analyst` agent, and writes both sidecars. Streams `recovery:*` events through the existing display pipeline. Exits 0 on `manual` verdict; non-zero only on infrastructural error (missing PRD, git failure, harness failure).
2. Expose `eforge_recover` MCP tool via `packages/eforge/src/cli/mcp-tool-factory.ts` + `mcp-proxy.ts`. Use the existing `createDaemonTool` factory and add `recover` to `ALLOWED_FLAGS` whitelist for the relevant args.
3. Daemon trigger in `packages/monitor/src/server.ts`: subscribe to `plan:build:failed` events. On fire, spawn `eforge recover <setName> <prdId>` as a child process (`execFile` from `node:child_process`), forwarding stdout/stderr to the daemon's event channel so `recovery:*` events from the subprocess stream into the existing per-session SSE feed via `subscribeToSession`. Recovery does not call `concurrency.ts`'s semaphore.
4. Monitor UI: extend `packages/monitor-ui/src/components/timeline/event-card.tsx` to render `recovery:*` events. Add a verdict + confidence chip plus a sidecar link on the failed-build row (locate via the existing `'failed'` classification path at `event-card.tsx:23,65`). The chip and typed display fields read from the JSON twin (`<prdId>.recovery.json`); the link points to the markdown sidecar.
5. Pi extension parity in `packages/pi-eforge/extensions/eforge/index.ts`: add at minimum two MCP tools — one to trigger recovery (mirrors `eforge_recover`) and one to read the sidecar (returns the JSON twin parsed). Follow existing CLI-mirroring tools for shape.
6. Bump `eforge-plugin/.claude-plugin/plugin.json` version (currently 0.8.1 → 0.9.0; surface-parity change).

### Key Decisions

1. **Subprocess, not in-process.** The daemon launches `eforge recover ...` via `execFile` — the failed engine process is dead by the time `plan:build:failed` fires anyway, and a clean subprocess matches the architecture's engine-emits / consumers-render boundary.
2. **No build permit consumption.** The daemon's recovery spawner sits outside `concurrency.ts`'s semaphore. The integration test asserts a queued build claims its slot on schedule while recovery runs.
3. **`manual` exits 0.** Per AC #8, infrastructural failure is the only non-zero exit. A `manual` verdict means the agent succeeded — it just deferred to a human.
4. **Pi extension parity is non-negotiable.** AGENTS.md requires both consumer surfaces stay in sync; both an enqueue-style and a read-style tool ship together.
5. **Monitor UI reads the JSON twin** for typed display (verdict, confidence) and links to the markdown sidecar for human reading. No bespoke storage — both files live next to the failed PRD where the UI already enumerates the directory.

## Scope

### In Scope
- `eforge recover <setName> <prdId>` CLI subcommand wired through the existing `withMonitor()` / display pipeline.
- `eforge_recover` MCP tool registered via `mcp-tool-factory.ts` and surfaced through `mcp-proxy.ts` with proper `ALLOWED_FLAGS`.
- Daemon listens for `plan:build:failed` and spawns `eforge recover ...` as a clean child subprocess; subprocess stdout/stderr / events flow back through the existing event channel.
- `recovery:*` events render in `event-card.tsx`; failed-build row shows verdict chip, confidence chip, and sidecar markdown link.
- Pi extension exposes a recovery-trigger tool and a sidecar-read tool.
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json`.
- Doc updates for the new CLI subcommand, MCP tool, and config-level recovery role tuning.

### Out of Scope
- Any code that *reads* a verdict and acts on it (deferred follow-up PRD).
- Auto-execution of any verdict, including `retry`. Sidecar recommends `mv <prd> queue/`; user runs it.
- Feature-branch cleanup automation for `abandon`. Sidecar recommends `git branch -D <featureBranch>`; user runs it.
- Auto-build behavior changes (the `dont_retry_builds` rule stands).
- Engine-internal additions (covered by plan-01).

## Files

### Create
- `packages/pi-eforge/extensions/eforge/recovery-commands.ts` — Pi MCP tool registrations (trigger + read-sidecar), following the shape of existing `config-command.ts` / `profile-commands.ts`.

### Modify
- `packages/eforge/src/cli/index.ts` — add `recover <setName> <prdId>` Commander subcommand. Builds summary via `failure-summary.ts`, runs `recovery-analyst`, writes sidecars via `sidecar.ts`. Streams events through the existing `wrapEvents()` / `renderEvent()` pipeline. Exit 0 on `manual` verdict; non-zero only on infrastructural error.
- `packages/eforge/src/cli/mcp-tool-factory.ts` — register `eforge_recover` tool via `createDaemonTool`. Inputs: `setName`, `prdId`. Output: JSON of the verdict + sidecar paths.
- `packages/eforge/src/cli/mcp-proxy.ts` — add `recover` allowed flags to `ALLOWED_FLAGS` so the proxy forwards args correctly.
- `packages/monitor/src/server.ts` — add a listener that on `plan:build:failed` spawns `eforge recover <setName> <prdId>` via `execFile` from `node:child_process`. Wire stdout/stderr (and the JSON event stream the subprocess emits) into the existing per-session event channel. Do *not* acquire a permit from `concurrency.ts`.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — add cases for `recovery:start | recovery:summary | recovery:complete | recovery:error`. Render verdict + confidence chip; add a sidecar markdown link on rows where a `recovery:complete` event is present. Read display fields from the JSON twin.
- `packages/pi-eforge/extensions/eforge/index.ts` — wire the new `recovery-commands.ts` registrations.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` from `0.8.1` to `0.9.0`.

## Verification

- [ ] `pnpm build` produces a functional `packages/eforge/dist/cli.js` that accepts `recover <setName> <prdId>` and exits 0 with a `manual` verdict against a fixture failed PRD; both `<prdId>.recovery.md` and `<prdId>.recovery.json` appear in the failed PRD's directory.
- [ ] CLI exits with non-zero code only when given an unresolvable `setName`/`prdId` or when `git log` fails on a missing feature branch (asserted via integration test).
- [ ] MCP `eforge_recover` tool is reachable through `mcp-proxy.ts` and returns a JSON response containing `verdict`, `confidence`, and the two sidecar paths.
- [ ] Daemon integration: forcing a `plan:build:failed` (intentionally erroring PRD) triggers the daemon to spawn `eforge recover` as a child process; a `recovery:complete` event arrives on the existing per-session event channel and the markdown sidecar appears next to the failed PRD.
- [ ] Concurrency invariant: while recovery runs, a second queued build claims its semaphore permit on schedule (asserted by the integration test using `availableParallelism()` >= 2).
- [ ] Monitor UI failed-build row renders a verdict chip, a confidence chip, and a clickable sidecar markdown link sourced from `<prdId>.recovery.json`.
- [ ] Pi extension exposes a recovery-trigger MCP tool and a sidecar-read MCP tool reachable via the Pi extension entry point.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version reads `0.9.0`.
- [ ] `pnpm type-check && pnpm test` pass.
- [ ] No new code in `packages/engine/src/concurrency.ts` (recovery is outside the build semaphore).
- [ ] The recovery agent emits no side effects beyond the two sidecar files: no PRD movement, no `git` writes, no queue mutation (asserted by an integration test that snapshots `eforge/queue/` before and after — only the two sidecar files appear, the failed PRD is untouched).
