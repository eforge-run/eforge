---
title: Real-time build feedback for the eforge Claude Code plugin (and Pi parity)
created: 2026-04-21
depends_on: ["fix-planner-submission-tools-on-the-pi-backend"]
---

# Real-time build feedback for the eforge Claude Code plugin (and Pi parity)

## Problem / Motivation

Today when a user kicks off a build via the Claude Code plugin (`/eforge:build` → `eforge_build` MCP tool), the tool returns immediately with `{ sessionId, monitorUrl }` and the conversation goes silent until the user manually invokes `/eforge:status`. There *is* already an SSE subscriber in the MCP proxy that forwards daemon events as MCP `logging` notifications, but those render as a side-channel log, not inline in the conversation, so the user correctly perceives "nothing is happening."

We want live progress to appear **inside the Claude Code conversation** while a build runs, without polling, leveraging the push infrastructure that already exists:
- The daemon already streams every `EforgeEvent` over SSE at `GET /api/events/{sessionId}` (`packages/monitor/src/server.ts`).
- The MCP SDK (`@modelcontextprotocol/sdk` v1.29) supports `notifications/progress` tied to a tool call's `progressToken` - the mechanism Claude Code renders as live tool progress UI.

The Pi extension is currently on par with the Claude Code plugin (also one-shot + silent), but Pi's tool contract exposes an `onUpdate(msg)` callback that is present-but-unused in every eforge tool today. We can deliver an analogous live-follow experience on the Pi side by populating `onUpdate` from the same SSE stream. Pi does not use MCP, so the transport is different, but the feature and infrastructure are the same.

## Goal

Deliver live, in-conversation build progress for both the Claude Code plugin (via MCP progress notifications) and the Pi extension (via `onUpdate`), so users see high-signal phase/build/review events stream inline while a build runs and receive a final summary as the tool result.

## Approach

Add a new long-running MCP tool, **`eforge_follow`**, that blocks for the lifetime of a build session and emits streaming progress. Keep `eforge_build` fire-and-forget (preserves queue-first semantics). Skills chain follow after build automatically so the user gets live feedback without learning a new command. Mirror the capability in the Pi extension using Pi's `onUpdate` callback.

### 1. Factor out the per-session SSE subscription (engine-agnostic helper)

The SSE-subscribe logic (connect → parse `EforgeEvent` lines → reconnect with backoff → handle `session:end`) already lives inside `startSseSubscriber` in `packages/eforge/src/cli/mcp-proxy.ts`. Extract the single-session piece into a reusable function, e.g. `subscribeToSession(sessionId, { onEvent, onEnd, signal }): Promise<SessionSummary>`, and place it in `packages/client/src/` so both the MCP server and the Pi extension can import it from `@eforge-build/client`.

- Input: `sessionId`, event callback, abort signal
- Output: promise that resolves with the final session summary when the daemon emits `session:end` (or an error event)
- Reuses the existing reconnect/backoff behavior

The daemon-wide "auto-discover new sessions and forward to MCP logging" behavior should remain in `mcp-proxy.ts` as a thin wrapper around the new helper - no behavior change there.

### 2. New MCP tool `eforge_follow`

In `packages/eforge/src/cli/mcp-proxy.ts`:

- Register `eforge_follow({ sessionId: string, timeoutMs?: number })`.
- In the handler, read `extra._meta.progressToken` from `RequestHandlerExtra`. If present, stream via `this.server.server.notification({ method: "notifications/progress", params: { progressToken, progress, total?, message } })`.
- Call `subscribeToSession(sessionId, { onEvent })`. For each event, map to a progress update:
  - `phase:start` → `"Phase: <name> starting"`
  - `phase:end` → `"Phase: <name> complete"`
  - `build:files_changed` → `"Files changed: N"`
  - `review:issue` (high/critical) → `"Issue: <summary>"`
  - `build:error` / `phase:error` → surface as progress message; let the tool return with the error payload
- Resolve when `session:end` arrives. Return a final summary (status, phase counts, files changed, monitor URL) as the tool result so the *final* outcome is part of the conversation transcript, not just the progress stream.
- Default timeout: long (e.g. 30 min) but cancellable via the MCP abort signal.

Event → progress mapping lives next to the tool in a small `eventToProgress()` function driven by the `EforgeEvent` discriminated union in `packages/engine/src/events.ts`. Keep the mapping deliberately narrow - high-signal phase/build/review events only; skip the noisy agent-level events that already spam the monitor UI.

### 3. Wire skills to auto-chain follow

Teach the existing skills to invoke `eforge_follow` right after enqueue so users don't need to know the tool exists:

- `eforge-plugin/skills/build/SKILL.md` - after calling `eforge_build`, instruct Claude to call `eforge_follow` with the returned `sessionId` and report the final summary.
- `eforge-plugin/skills/status/SKILL.md` - if a session is currently running, offer to follow it live via `eforge_follow`.
- Bump plugin version in `eforge-plugin/.claude-plugin/plugin.json` (per AGENTS.md rule).

### 4. Pi extension parity (separate transport, same UX)

Pi doesn't use MCP, but it has the same need and a mechanism for it: Pi's tool `execute()` signature receives an `onUpdate(message)` callback (currently unused across all eforge tools in `packages/pi-eforge/`).

- Add an `eforge_follow` Pi tool that uses the shared `subscribeToSession()` helper from `@eforge-build/client` and forwards the same high-signal events through `onUpdate` with human-readable strings.
- Update the `/eforge:build` and `/eforge:status` command aliases / skills in `packages/pi-eforge/` to chain follow after enqueue.
- This satisfies the AGENTS.md cross-consumer parity rule.

### 5. Deprecate the logging-notification forwarding path

The existing "forward every daemon event as MCP logging notification" behavior in `mcp-proxy.ts` becomes redundant once `eforge_follow` pushes the same information via progress notifications into the conversation. Per the "no backward compatibility cruft" feedback, rip it out rather than keep both. The auto-discovery of new sessions (10s poll for sessions the user didn't start via this MCP) also becomes unnecessary - the tool call itself is the subscription trigger.

### Critical files

- `packages/eforge/src/cli/mcp-proxy.ts` - register `eforge_follow`; emit `notifications/progress`; remove obsolete logging forwarder.
- `packages/client/src/` - new `subscribeToSession()` helper and `SessionSummary` type; export from `@eforge-build/client`. Bump `DAEMON_API_VERSION` if the response shape for the SSE endpoint or the summary type changes (likely not - we're only *consuming* an existing endpoint).
- `packages/engine/src/events.ts` - existing `EforgeEvent` union; `eventToProgress()` mapping reads from here (no changes to the events themselves).
- `packages/monitor/src/server.ts` - existing `/api/events/{sessionId}` SSE endpoint; no changes.
- `eforge-plugin/skills/build/SKILL.md`, `eforge-plugin/skills/status/SKILL.md` - chain follow after enqueue.
- `eforge-plugin/.claude-plugin/plugin.json` - version bump.
- `packages/pi-eforge/src/` - new `eforge_follow` tool using `onUpdate`; update build/status command paths.

## Scope

**In scope:**
- New long-running MCP tool `eforge_follow` in `packages/eforge/src/cli/mcp-proxy.ts` emitting `notifications/progress` tied to the tool call's `progressToken`.
- Extracted `subscribeToSession()` helper and `SessionSummary` type in `packages/client/src/`, exported from `@eforge-build/client`, reused by both the MCP server and the Pi extension.
- `eventToProgress()` mapping for high-signal events: `phase:start`, `phase:end`, `build:files_changed`, `review:issue` (high/critical), `build:error`, `phase:error`.
- Final tool result containing session summary (status, phase counts, files changed, monitor URL).
- Default long timeout (e.g. 30 min), cancellable via MCP abort signal.
- Skill updates in `eforge-plugin/skills/build/SKILL.md` and `eforge-plugin/skills/status/SKILL.md` to auto-chain `eforge_follow`.
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json`.
- Pi extension parity: new `eforge_follow` Pi tool using `onUpdate`, and updates to `/eforge:build` and `/eforge:status` command aliases / skills in `packages/pi-eforge/` to chain follow after enqueue.
- Removal of the existing "forward every daemon event as MCP logging notification" behavior in `mcp-proxy.ts` and the 10s auto-discovery poll for new sessions.
- Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` **only if** the SSE endpoint response shape or summary type changes (likely not).

**Out of scope / explicitly not changed:**
- No changes to `EforgeEvent` definitions in `packages/engine/src/events.ts`.
- No changes to `/api/events/{sessionId}` SSE endpoint in `packages/monitor/src/server.ts`.
- Noisy agent-level events are deliberately excluded from the progress mapping.
- `eforge_build` remains fire-and-forget (queue-first semantics preserved).
- The daemon-wide auto-discovery wrapper remains as a thin wrapper around the new helper with no behavior change (aside from the deprecation in item 5 above).
- Monitor UI behavior is unchanged; it continues consuming the same SSE stream independently.

## Acceptance Criteria

1. **Unit / wiring tests**: a test in `test/` uses a stub daemon and verifies `subscribeToSession()` calls `onEvent` for each SSE line and resolves on `session:end`. Follows the no-mocks / real-code convention - uses the actual monitor HTTP server in test mode and pushes synthetic events, or hand-crafts event lines cast through `unknown` per the testing section of AGENTS.md.
2. **Manual e2e in Claude Code**: `pnpm build` → restart daemon (`eforge-daemon-restart` skill) → in a Claude Code session, run `/eforge:build` on a small PRD. Confirm:
   - `eforge_build` returns immediately with sessionId.
   - Claude auto-invokes `eforge_follow`, and the conversation shows a live progress indicator updating through `phase:start` / `phase:end` events.
   - Final tool result includes the session summary (status, phases, files changed, monitor URL).
   - Cancelling the tool (abort) terminates the SSE subscription cleanly.
3. **Manual e2e in Pi**: same flow via the Pi CLI; `onUpdate` messages render inline while the build runs.
4. **Regression**: `eforge_status`, `eforge_queue_list`, `eforge_auto_build` still return correct snapshots; the monitor UI still renders live (it consumes the same SSE stream independently).
