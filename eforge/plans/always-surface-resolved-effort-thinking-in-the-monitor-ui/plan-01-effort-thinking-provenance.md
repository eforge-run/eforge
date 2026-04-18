---
id: plan-01-effort-thinking-provenance
name: Effort and Thinking Provenance Tracking
depends_on: []
branch: always-surface-resolved-effort-thinking-in-the-monitor-ui/effort-thinking-provenance
---

# Effort and Thinking Provenance Tracking

## Architecture Context

The engine resolves per-agent config via `resolveAgentConfig` in `pipeline.ts`, which walks a precedence chain (planner > role-config > global-config > built-in defaults) for effort and thinking. Effort already has provenance tracking (`effortSource`) but it is only stamped when `result.effort !== undefined`, meaning agents with no configured effort emit no source. Thinking has no provenance tracking at all. The monitor UI tooltip conditionally renders effort/thinking rows and lacks labels, making it impossible to distinguish overrides from defaults.

This plan adds `thinkingSource` tracking parallel to `effortSource`, moves source stamping outside the undefined guard so sources are always emitted, and updates the monitor UI to always render labeled rows with visual override indicators.

## Implementation

### Overview

Thread `thinkingSource` through the full stack: type definition -> resolver -> event -> backend plumbing -> reducer -> UI. Simultaneously fix the always-stamp gap for `effortSource` and update the tooltip rendering.

### Key Decisions

1. **Always stamp source fields** - Move `result.effortSource = effortSource` outside the `if (result.effort !== undefined)` guard in `resolveAgentConfig`. When effort/thinking is undefined after the precedence walk, the source is `'default'` meaning "no layer set it; backend picks its own default." This ensures the UI always has provenance data.
2. **Mirror existing pattern for thinkingSource** - Use the exact same `'planner' | 'role-config' | 'global-config' | 'default'` union type and precedence tracking as `effortSource`. Track a `thinkingSource` local variable alongside `effortSource` in the SDK_FIELDS loop, updating it at the same branch points.
3. **Add `thinkingSource` to `NON_SDK_KEYS`** - Like `effortSource`, `thinkingSource` is metadata for monitoring and must not be forwarded to the backend SDK.
4. **UI always renders both rows** - Remove the conditional guards on `thread.effort` and `thread.thinking`. Show `unset` when the value is undefined. Prefix with `effort:` and `thinking:` labels. Style planner-overridden rows with accent color (e.g. `text-blue-400 font-medium`) vs dim `opacity-50 text-[10px]` for non-override rows.

## Scope

### In Scope
- `thinkingSource` field on `ResolvedAgentConfig`, `AgentRunOptions`, `agent:start` event, `AgentThread`
- Always-stamp `effortSource` and `thinkingSource` in `resolveAgentConfig` (even when values are undefined)
- `thinkingSource` emission in claude-sdk and pi backend `agent:start` yields
- `thinkingSource` in `NON_SDK_KEYS` exclusion set
- Monitor UI tooltip: always render effort/thinking rows, add labels, add override styling
- Test updates for resolver provenance and reducer event capture

### Out of Scope
- Planner override logic (already works, emits `planEntry.agents[role]`)
- New UI surfaces beyond the existing thread-bar tooltip
- Data migration for old events (reducer already uses `'X' in event` guards)

## Files

### Modify
- `packages/engine/src/config.ts` (lines 234-254) - Add `thinkingSource?: 'planner' | 'role-config' | 'global-config' | 'default'` to `ResolvedAgentConfig` interface
- `packages/engine/src/pipeline.ts` (lines 495-656) - In `resolveAgentConfig`: add `thinkingSource` tracking variable (parallel to `effortSource` at line 524), update the SDK_FIELDS loop (lines 529-543) to set `thinkingSource` at the same branch points as `effortSource`, move `result.effortSource = effortSource` and add `result.thinkingSource = thinkingSource` outside the `if (result.effort !== undefined)` guard (lines 642-653) so both are always stamped
- `packages/engine/src/backend.ts` (lines 77-100, line 39) - Add `thinkingSource?: 'planner' | 'role-config' | 'global-config' | 'default'` to `AgentRunOptions` interface; add `'thinkingSource'` to the `NON_SDK_KEYS` set
- `packages/engine/src/events.ts` (line 231) - Add `thinkingSource?: string` to the `agent:start` event type in the discriminated union
- `packages/engine/src/backends/claude-sdk.ts` (line 48) - Add `...(options.thinkingSource !== undefined ? { thinkingSource: options.thinkingSource } : {})` to the `agent:start` yield, matching the existing `effortSource` spread pattern
- `packages/engine/src/backends/pi.ts` (lines 252, 258, 265) - Add `...(options.thinkingSource !== undefined ? { thinkingSource: options.thinkingSource } : {})` to all three `agent:start` yield sites
- `packages/monitor-ui/src/lib/reducer.ts` (lines 12-31, 268-293) - Add `thinkingSource?: string` to `AgentThread` interface; add `thinkingSource: 'thinkingSource' in event ? (event as { thinkingSource?: string }).thinkingSource : undefined` to the agent:start handler, matching the `effortSource` capture pattern
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (lines 849-886) - Replace conditional effort/thinking rendering with always-visible rows. Each row: label prefix (`effort:` / `thinking:`), value or `unset`, source in parens with label mapping (planner/config/default), clamp display preserved for effort. When source is `'planner'`, apply `text-blue-400 font-medium` styling; otherwise keep existing `opacity-50 text-[10px]` dim treatment
- `test/agent-wiring.test.ts` (lines 842-945) - Add test: `resolveAgentConfig` returns `effortSource: 'default'` and `thinkingSource: 'default'` when no layer configures them. Add test: `thinkingSource` tracks through planner/role-config/global-config precedence. Update existing "no effort configured" test (lines 938-944) to assert `effortSource: 'default'` is present on the result
- `test/monitor-reducer.test.ts` (lines 868-1042) - Add test: `agent:start` with `thinkingSource` populates `thread.thinkingSource`. Add test: `agent:start` without `thinkingSource` leaves it undefined (backward compat). Update existing effort/thinking test block to verify `thinkingSource` handling

## Verification

- [ ] `pnpm type-check` passes with zero errors across the workspace
- [ ] `pnpm test` passes - all existing tests still pass, new resolver tests assert `effortSource: 'default'` and `thinkingSource: 'default'` when no layer sets them
- [ ] `resolveAgentConfig` returns `thinkingSource` with correct provenance values (`'planner'`, `'role-config'`, `'global-config'`, `'default'`) matching the layer that set thinking
- [ ] `resolveAgentConfig` returns `effortSource: 'default'` even when `result.effort` is undefined (source always stamped)
- [ ] `agent:start` events include `thinkingSource` field when the resolver produces one
- [ ] `AgentThread` in the reducer captures `thinkingSource` from `agent:start` events
- [ ] Monitor UI tooltip renders an `effort:` row and a `thinking:` row for every agent thread, including when values are undefined (showing `unset`)
- [ ] Rows display format: `effort: low (planner)`, `thinking: adaptive (config)`, `effort: unset (default)`
- [ ] Clamped effort renders as `effort: low (clamped from high) (planner)`
- [ ] Planner-overridden rows use `text-blue-400 font-medium` styling; non-override rows use `opacity-50 text-[10px]`
- [ ] Older `agent:start` events (missing `thinkingSource`) render thinking row as `thinking: <value or unset>` without errors
