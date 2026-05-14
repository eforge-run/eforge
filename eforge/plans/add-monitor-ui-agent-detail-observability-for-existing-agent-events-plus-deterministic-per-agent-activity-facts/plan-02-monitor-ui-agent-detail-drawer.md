---
id: plan-02-monitor-ui-agent-detail-drawer
name: Monitor UI agent detail drawer and deterministic facts rendering
branch: add-monitor-ui-agent-detail-observability-for-existing-agent-events-plus-deterministic-per-agent-activity-facts/plan-02-monitor-ui-agent-detail-drawer
---

# Monitor UI agent detail drawer and deterministic facts rendering

## Architecture Context

Monitor UI state is shaped by the reducer in `packages/monitor-ui/src/lib/reducer.ts`. `AgentThread` (lines 54-91) is the per-agent durable summary used by the pipeline view. The agent-event handlers in `packages/monitor-ui/src/lib/reducer/handle-agent.ts` currently match `agent:result` events to threads via a reverse scan keyed on `(agent === event.agent, planId === event.planId, durationMs === null)` (lines 201-210), and they do not preserve `result.resultText` on the thread.

The pipeline renders per-plan agent bars in `packages/monitor-ui/src/components/pipeline/plan-row.tsx` (lines 229-305). Each bar already has hover behavior wired through `onStageHover` and receives per-agent streaming events through `eventsByAgent` (built in `thread-pipeline.tsx` at lines 130-145). Currently the bar is `cursor-default` — there is no click handler.

A shadcn-style `SheetContent` is already implemented at `packages/monitor-ui/src/components/ui/sheet.tsx` and is reused by `RecoverySidecarSheet` (`packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx`) and by `DecisionTimeline`. The new drawer should follow the same pattern: open/close state is owned by the parent, and the sheet uses `role="dialog"` and an Escape-to-close handler that the primitive already provides.

After plan-01 ships, the new wire fields and event are already part of `EforgeEvent`: `agent:result` carries an optional `agentId` and `agent:activity` carries deterministic file/diffstat facts plus an `attribution` quality marker. This plan consumes those fields.

## Implementation

### Overview

1. Extend `AgentThread` with `resultText?: string` and `activity?: AgentActivityFacts` (a new local type that mirrors the wire `agent:activity` payload minus the envelope fields).
2. Update `handleAgentResult` to (a) populate `resultText` on the matched thread, and (b) prefer `event.agentId` for matching when available, falling back to the existing reverse-walk by `(agent, planId, durationMs === null)` for legacy logs.
3. Add a new `handleAgentActivity` handler that locates the matching thread by `agentId` and stores activity facts on it.
4. Register the new handler in the reducer dispatch table and update the `_Exhaustive` event-type checks if any.
5. Build a new `AgentDetailSheet` component under `packages/monitor-ui/src/components/pipeline/` that renders the thread's deterministic facts (role/plan/perspective, model/harness/tier/effort/thinking/toolbelt, start/end/duration, tokens/cost/turns, warnings, retries, stop errors, tool/message activity grouped from `eventsByAgent`, final result text with truncation/collapse, and the file/diffstat facts when present).
6. Wire the click handler in `plan-row.tsx` so clicking an agent bar opens the drawer for that specific agent. Preserve hover/stage highlighting behavior.
7. Pass `eventsByAgent` down to the drawer so it can derive warnings/retries/tool activity without copying event payloads into reducer state.
8. Add reducer tests covering `resultText` storage, `agentId`-preferred matching, fallback for legacy events without `agentId`, and `agent:activity` storage. Add a focused component test for the drawer's data derivation (e.g. tool counts, attribution badge rendering, large-payload collapse).

### Key Decisions

1. **Drawer data is derived from existing reducer state, not duplicated.** Per source design decision 6, warnings/retries/errors/tool calls/messages are grouped from `RunState.events` filtered by `agentId`. Only durable per-thread summaries (`resultText`, `activity`) are added to `AgentThread`.
2. **`agentId`-preferred matching is additive.** The fallback `(agent, planId, durationMs === null)` reverse-walk is retained so that replayed historical logs without `agentId` on `agent:result` still attach correctly. A wire-parity test in plan-01 guarantees the schema allows missing `agentId`; the reducer test added here proves the fallback fires.
3. **Result text and tool payloads are truncated with a click-to-expand control.** Source acceptance criterion 1 requires "safe truncation/collapse behavior." The drawer renders the first ~600 chars and exposes an expand button; tool inputs/results render with the same control.
4. **Drawer labels avoid implying AI summarization.** The result-text section is labeled `Final result` (not `Summary`). The diffstat section is labeled `Files changed (deterministic)` with an explicit `attribution` badge: green for `exact`, yellow for `best_effort`, gray for `unavailable`.
5. **Drawer state lives in the closest pipeline ancestor that owns the agent list.** `thread-pipeline.tsx` owns `agentThreads`, hover state, and `eventsByAgent`, so it owns the `selectedAgentId` state and passes a click handler to `PlanRow` -> agent-bar. This keeps `plan-row.tsx` stateless beyond what it already manages.

## Scope

### In Scope
- Add `resultText?: string` and `activity?: AgentActivityFacts` to `AgentThread`; define `AgentActivityFacts` to mirror the wire shape from `agent:activity` (minus envelope).
- Update `handleAgentResult` in `handle-agent.ts` to: populate `resultText`, and prefer `event.agentId` for thread matching. Retain the legacy reverse-walk fallback when `agentId` is absent.
- Add `handleAgentActivity` to `handle-agent.ts` and register it in `reducer/index.ts`.
- Add the `AgentDetailSheet` React component under `packages/monitor-ui/src/components/pipeline/agent-detail-sheet.tsx` that consumes `AgentThread` + `eventsByAgent[agentId]` + `agent:warning`/`agent:retry` events and renders the deterministic detail view described in source scope item 2.
- Modify `plan-row.tsx` so each agent bar accepts an `onSelect(agentId)` prop and replaces `cursor-default` with `cursor-pointer` plus a click handler. Hover/stage highlighting is preserved.
- Modify `thread-pipeline.tsx` to own `selectedAgentId` state, pass an `onSelect` prop through `PlanRow`, and render `AgentDetailSheet` mounted once at the pipeline root.
- Update `packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts` to cover: `resultText` storage; matching by `agentId` when present; fallback by `(agent, planId, durationMs === null)` when `agentId` is missing; storing `agent:activity` payload on the matched thread by `agentId`.
- Add `packages/monitor-ui/src/components/pipeline/__tests__/agent-detail-sheet.test.tsx` covering: drawer renders title with role and plan; result text renders truncated when over 600 chars with an expand control; attribution badge renders the correct text for `exact`, `best_effort`, `unavailable`; file totals render when present and are omitted when `activity` is undefined.

### Out of Scope
- LLM-generated summaries or any new model call.
- Changing the engine wire schema or harness emission (already shipped in plan-01).
- Redesign of the pipeline timeline, density overlay, or stage hover.
- Persisting drawer-open state across page reloads.
- Surfacing per-agent activity for doc-author, doc-syncer, or test-writer paths beyond what plan-01 emits.

## Files

### Create
- `packages/monitor-ui/src/components/pipeline/agent-detail-sheet.tsx` — New shadcn-style `SheetContent`-based drawer. Props: `{ thread: AgentThread | null; events: StoredEvent[]; open: boolean; onClose: () => void }`. Derives warnings/retries/stop-error/tool activity by filtering `events` for the given `agentId`. Renders sections: identity (role, plan, perspective, agentId), runtime (model, harness, tier, effort, thinking, toolbelt), lifecycle (start, end, duration, turns), usage (input/output/total tokens, cacheRead/cacheCreation, cost), warnings + retries + stop error, activity facts when present (attribution badge + file list + totals), tool calls summary (count + collapsible list), recent messages (count + collapsible list), final result text (collapsible).
- `packages/monitor-ui/src/components/pipeline/__tests__/agent-detail-sheet.test.tsx` — Component-logic tests using vitest + jsdom (already a dev dependency). Hand-crafts an `AgentThread` and a small `StoredEvent[]` and asserts the rendered text content.

### Modify
- `packages/monitor-ui/src/lib/reducer.ts` — Add `resultText?: string` and `activity?: AgentActivityFacts` to the `AgentThread` interface. Define and export a local `AgentActivityFacts` type that mirrors the `agent:activity` wire shape minus the envelope (i.e. without `sessionId`/`runId`/`timestamp`/`type`).
- `packages/monitor-ui/src/lib/reducer/handle-agent.ts` — In `handleAgentResult`: extract `agentId` from the event when present and prefer it for the reverse-walk match; populate `resultText` on the updated thread from `result.resultText`. Add a new `handleAgentActivity` handler that finds the thread by `event.agentId` and patches `activity` onto it.
- `packages/monitor-ui/src/lib/reducer/index.ts` — Register `handleAgentActivity` under the `'agent:activity'` key in the handler registry. The discriminated-union type-check will force this addition.
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx` — Accept a new prop `onAgentSelect: (agentId: string) => void` on `PlanRowProps`. On each agent-bar element (around line 252), replace `cursor-default` with `cursor-pointer`, add `onClick={() => onAgentSelect(thread.agentId)}`, and add an `aria-label` describing the action (`Open detail for ${thread.agent}`). Preserve the existing `onMouseEnter`/`onMouseLeave` hover wiring and the `Tooltip`.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — Hold `const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);` at the top of `ThreadPipeline`. Pass `onAgentSelect={setSelectedAgentId}` to every `PlanRow`. Below the pipeline, render `<AgentDetailSheet thread={selectedThread} events={events} open={selectedAgentId !== null} onClose={() => setSelectedAgentId(null)} />` where `selectedThread = agentThreads.find(t => t.agentId === selectedAgentId) ?? null`.
- `packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts` — Add four new tests: (1) `agent:result` with `agentId` matches the thread by `agentId` and stores `resultText`. (2) `agent:result` without `agentId` falls back to `(agent, planId, durationMs === null)` and still stores `resultText`. (3) `agent:result` with `agentId` matching a thread whose `durationMs` is already set still updates the matched thread (proves `agentId` takes precedence over the legacy `durationMs === null` filter). (4) `agent:activity` event with `attribution: 'exact'` and a `files` array is stored on the matched thread; an `agent:activity` whose `agentId` matches no thread is a no-op (no crash, no state mutation).

## Verification

- [ ] `pnpm type-check` exits 0 across all workspaces.
- [ ] `vitest run packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts` exits 0 and includes the four new assertions described above.
- [ ] `vitest run packages/monitor-ui/src/components/pipeline/__tests__/agent-detail-sheet.test.tsx` exits 0 with assertions for: drawer title contains agent role and plan id; result text longer than 600 chars renders a button labeled `Show more`; attribution badge for `'exact'` contains the text `exact`; attribution badge for `'best_effort'` contains the text `best_effort`; activity totals (`files`, `+additions`, `-deletions`) render when `activity` is present and are omitted when `activity` is undefined.
- [ ] `pnpm test` (full suite) exits 0.
- [ ] Manual inspection of `plan-row.tsx`: each agent bar has `cursor-pointer` and an `onClick` handler that calls `onAgentSelect(thread.agentId)`; hover behavior continues to call `onStageHover(stripStage ?? null)`.
- [ ] Manual inspection of `thread-pipeline.tsx`: `<AgentDetailSheet />` is rendered exactly once at the pipeline root with `open` bound to `selectedAgentId !== null`.
- [ ] Manual inspection of `handle-agent.ts`: `handleAgentResult` prefers `event.agentId` for the reverse-walk match and only falls back to the `(agent, planId, durationMs === null)` predicate when `agentId` is absent from the event.