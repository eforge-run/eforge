---
id: plan-01-backend-common-and-usage-contract
name: Backend Common Helpers and Unified Usage Cadence
depends_on: []
branch: hardening-05-de-duplicate-backend-event-emission-and-normalize-shape/backend-common-and-usage-contract
---

# Backend Common Helpers and Unified Usage Cadence

## Architecture Context

eforge runs agents through two production backends - `ClaudeSDKBackend` (wraps `@anthropic-ai/claude-agent-sdk`) and `PiBackend` (wraps `@mariozechner/pi-coding-agent`). Both implement `AgentBackend` in `packages/engine/src/backend.ts` and emit the engine's `EforgeEvent` union defined in `packages/engine/src/events.ts`. Downstream consumers (CLI renderer in `packages/eforge/src/cli/display.ts`, monitor UI reducer in `packages/monitor-ui/src/lib/reducer.ts`, tracing) observe events without caring which backend produced them - that abstraction depends on both backends emitting identical event shapes at comparable points in the run.

Today the two backends drift on three axes: the `agent:start` payload is constructed via near-identical inline ternary expressions (`packages/engine/src/backends/claude-sdk.ts:111` and `packages/engine/src/backends/pi.ts:278,284,291`); the mapping from provider-native tool-call ID fields (`block.id` for Claude SDK, `event.toolCallId` for Pi) onto the unified `toolUseId` emission field is undocumented; and while both backends happen to emit `agent:usage` per turn today, neither emits an authoritative final cumulative event, and the contract for what per-turn values mean (delta vs cumulative) is undocumented so consumers treat each event as last-wins-cumulative.

## Implementation

### Overview

Introduce a new `packages/engine/src/backends/common.ts` module housing two small helpers (`buildAgentStartEvent`, `normalizeToolUseId`). Replace the inline ternary `agent:start` construction in both backends with a single call to `buildAgentStartEvent`. Route tool-call ID extraction through `normalizeToolUseId` in both backends. Document the `toolUseId` normalization contract at the top of `packages/engine/src/backend.ts`. Add a `final?: boolean` field to the `agent:usage` variant of `EforgeEvent` and document the unified emission cadence next to it in `packages/engine/src/events.ts`. Update `ClaudeSDKBackend` and `PiBackend` to emit a final cumulative `agent:usage` event with `final: true` at session end (`ClaudeSDKBackend` currently emits only per-turn `task_progress` usage and no final cumulative; `PiBackend` currently emits cumulative-so-far per turn and no final-flagged event). Change `PiBackend`'s per-turn emission to be a per-turn delta so both backends share per-turn-delta semantics; the per-turn `task_progress` path in `ClaudeSDKBackend` already reports per-turn-scoped numbers and stays as-is (total_tokens and tool_uses from each task_progress message, not cumulative session counters). Update the monitor UI reducer in `packages/monitor-ui/src/lib/reducer.ts` to last-wins on `final === true` and sum deltas otherwise when overlaying live usage. Add `test/backend-common.test.ts` covering both helpers.

### Key Decisions

1. **Single plan, not split.** Adding a required-at-some-call-sites helper (`buildAgentStartEvent`) plus a new optional event field (`final?: boolean`) plus the consumer update in the monitor reducer must all land together to keep `pnpm build` and `pnpm test` green between merges. Splitting the helper from its two consumers would mean the intermediate commit has no callers; splitting the reducer from the event type change would mean the reducer reads a field the event type does not define.

2. **`final` is optional with `final: true` as the discriminator.** The PRD specifies `final?: boolean`, which keeps the event shape backward compatible: older replays and any tests constructing `agent:usage` without `final` continue to type-check. Consumers branch on `event.final === true` (not just truthy) to be explicit about the discriminator.

3. **Per-turn semantics become deltas, not cumulative.** The PRD's rule "last-wins on `final`, sum deltas otherwise" only makes sense when per-turn events carry deltas. `PiBackend` today reads `session.getSessionStats()` after each `turn_end` - those are cumulative. This plan switches Pi's per-turn emission to a delta by subtracting the previously observed cumulative totals before emitting, and keeps a running snapshot for the next turn's delta computation. The per-turn `task_progress` path in `ClaudeSDKBackend` already emits per-turn scoped numbers (total_tokens and tool_uses from each task_progress message) and stays as-is.

4. **Final cumulative emission happens inside `run()`, before `agent:result`.** Both backends already compute cumulative totals at session end for `agent:result`. Emitting the final `agent:usage` just before `agent:result` gives consumers a single authoritative total in the usage channel, co-located with the rest of the lifecycle sequence, without requiring them to cross-read from `agent:result.result.usage`.

5. **Tool-call ID normalization stays a two-line helper.** The PRD explicitly notes the helper is "not strictly necessary" but makes normalization visible. Implementing it anyway yields a single source of truth for the error message when the id is missing and a single place to update if a third backend ever joins.

6. **`buildAgentStartEvent` takes the option bag, not a spread of args.** The existing `agent:start` event shape has ten+ optional fields (`fallbackFrom`, `effort`, `thinking`, `effortClamped`, `effortOriginal`, `effortSource`, `thinkingSource`, `thinkingCoerced`, `thinkingOriginal`, plus `model` and `backend` which are required). A single options object keeps call sites greppable and trivially extended when the next runtime decision (e.g. thinking-budget class) ships.

7. **No new CLI rendering.** `packages/eforge/src/cli/display.ts` handles `agent:usage` with an empty case (line 653-654) today. Adding `final`-aware rendering here is out of scope - the CLI renderer already does nothing with per-turn usage, so the unified contract doesn't change its behavior.

## Scope

### In Scope

- Create `packages/engine/src/backends/common.ts` with `buildAgentStartEvent` and `normalizeToolUseId`.
- Replace inline `agent:start` construction in `packages/engine/src/backends/claude-sdk.ts` (the single call at line 111) and in `packages/engine/src/backends/pi.ts` (all three early-return and main-path calls currently at lines 278, 284, 291) with `buildAgentStartEvent`.
- Route tool-call ID extraction through `normalizeToolUseId` in `claude-sdk.ts` (assistant `tool_use` mapping and tool result mapping) and in `pi.ts` (`translatePiEvent`'s `tool_execution_start` / `tool_execution_end` cases).
- Add a block comment at the top of `packages/engine/src/backend.ts` documenting that `tool_use` and `tool_result` events on the `AgentBackend` event stream always use `toolUseId`, and that backends are responsible for mapping `block.id` (Claude SDK) or `toolCallId` (Pi) onto it.
- Add `final?: boolean` to the `agent:usage` variant in `packages/engine/src/events.ts` and add a block comment next to that variant documenting the unified cadence.
- In `ClaudeSDKBackend`, emit a final `agent:usage` with `final: true` right before `agent:result` in `mapSDKMessages` (the `result` case, subtype `success` path). The final emission should carry the cumulative session totals from the SDK `result` message (`modelUsage` rolled up) rather than a zero row.
- In `PiBackend`, change the per-turn `turn_end` emission to carry per-turn deltas (by diffing against a tracked previous-cumulative snapshot) and emit a final `agent:usage` with `final: true` just before the existing `agent:result` yield in the main path. The final emission uses the same cumulative numbers that feed `resultData.usage`.
- Update `packages/monitor-ui/src/lib/reducer.ts` `agent:usage` branch (currently around line 298) so that when `event.final === true`, live-usage overlay and the matching `AgentThread` fields are last-wins-replaced; otherwise the numeric fields are additive (summing deltas into the running live totals).
- Add `test/backend-common.test.ts` covering: `buildAgentStartEvent` produces the expected shape for minimal input, for every optional field set, and never emits keys with `undefined` values; `normalizeToolUseId` prefers `id` over `toolCallId`, falls back to `toolCallId`, and throws a typed error when neither is present.

### Out of Scope

- Refactoring any other large methods in `claude-sdk.ts` / `pi.ts` (covered elsewhere).
- Adding a third backend or touching the `AgentBackend` interface signature.
- Retry handling inside backends.
- Changes to tracing / langfuse emission of usage.
- CLI renderer display of per-turn or final usage (the existing empty case stays empty).
- Any schema change affecting `agent:result.result.usage` (stays cumulative, as today).

## Files

### Create

- `packages/engine/src/backends/common.ts` - new file exporting `buildAgentStartEvent(opts)` returning `Extract<EforgeEvent, { type: 'agent:start' }>` and `normalizeToolUseId(raw)` returning a string, throwing with a descriptive message when neither `id` nor `toolCallId` is set.
- `test/backend-common.test.ts` - vitest suite covering both helpers. No SDK imports; construct fixture inputs inline and assert on the returned event shape and on the error thrown by `normalizeToolUseId`.

### Modify

- `packages/engine/src/backend.ts` - add a block comment near the top (above `AgentBackend` or above the `CustomTool` section) documenting that `tool_use` and `tool_result` events emitted on the `AgentBackend` event stream always use `toolUseId` as the stable identifier, and that backends are responsible for mapping `block.id` (Claude SDK) or `toolCallId` (Pi) onto this name before emission. No type changes.
- `packages/engine/src/events.ts` - add `final?: boolean` to the `agent:usage` variant of `EforgeEvent` (line 234). Add a JSDoc-style block comment immediately above that variant documenting that `agent:usage` is emitted after each assistant turn that reports usage (as a per-turn delta) plus a final cumulative emission at session end identifiable by `final: true`; consumers that need totals prefer the final event, consumers that need live progress aggregate deltas.
- `packages/engine/src/backends/claude-sdk.ts` - import from `./common.js`; replace the single inline `agent:start` construction at the current line 111 with `yield buildAgentStartEvent({ ... })`. In `mapSDKMessages`, swap `block.id` (assistant tool_use case) and the inferred id for tool results through `normalizeToolUseId`. In the `result` case (subtype `success`), just before `yield { type: 'agent:result', ... }`, add an additional `yield { type: 'agent:usage', ..., final: true }` carrying the cumulative session numbers derived from the existing `extractResultData` path (or from a shared local computed from `result.modelUsage`). The `task_progress` per-turn emission stays intact and does not set `final`.
- `packages/engine/src/backends/pi.ts` - import from `./common.js`; replace the three inline `agent:start` constructions (current lines 278, 284, 291) with `buildAgentStartEvent` calls. In `translatePiEvent`, swap `event.toolCallId` for `normalizeToolUseId({ toolCallId: event.toolCallId })` in both `tool_execution_start` and `tool_execution_end`. Introduce a `prevCumulative` snapshot in `run()` initialized to zeros; in the `turn_end` handler, compute per-turn deltas (current stats minus `prevCumulative`), update the snapshot, and push the `agent:usage` with the delta values. Just before the existing `yield { type: 'agent:result', ... }` (around line 734), yield one final `agent:usage` with `final: true` carrying the session cumulative totals that already feed `resultData.usage`.
- `packages/monitor-ui/src/lib/reducer.ts` - update the `agent:usage` branch (currently line 298) so that: if `event.final === true`, behavior is the existing last-wins replacement of `state.liveAgentUsage[event.agentId]` and the matching thread fields (this preserves today's semantics for the authoritative total). If `event.final` is not `true`, treat the event as a delta: add its numeric fields (`input`, `output`, `cacheRead`, `cacheCreation`, `costUsd`, `numTurns`) into the running `state.liveAgentUsage[event.agentId]` and into the matching `AgentThread`'s numeric fields (seeding from zero if the entry is missing). `total` should be derived as `input + output` for the overlay (or recomputed from the thread's current sums) rather than trusting the delta's `total` field.

## Verification

- [ ] `packages/engine/src/backends/common.ts` exists and exports `buildAgentStartEvent` and `normalizeToolUseId` with the signatures described in Files > Create.
- [ ] Grepping `packages/engine/src/backends/claude-sdk.ts` and `packages/engine/src/backends/pi.ts` for `type: 'agent:start'` returns zero inline object literal hits; all `agent:start` events are emitted via `buildAgentStartEvent`.
- [ ] Grepping `packages/engine/src/backends/claude-sdk.ts` for `block.id` and `packages/engine/src/backends/pi.ts` for `event.toolCallId` inside tool-use / tool-result event emission paths shows those reads now flow through `normalizeToolUseId` (direct reads outside emission paths, e.g. `toolNameMap.set(block.id, block.name)` keying, are fine to leave as-is).
- [ ] `packages/engine/src/backend.ts` contains a block comment that states all `tool_use` and `tool_result` events on the `AgentBackend` event stream use `toolUseId` as the stable identifier and names both `block.id` (Claude SDK) and `toolCallId` (Pi) as the provider-native names that must be mapped onto it.
- [ ] `packages/engine/src/events.ts` declares `final?: boolean` as an optional field on the `agent:usage` variant of `EforgeEvent`, and the comment immediately above that variant documents: per-turn deltas plus a final cumulative at session end; the final event is identifiable by `final: true`; consumers needing totals prefer the final event and consumers needing live progress aggregate deltas.
- [ ] `ClaudeSDKBackend` emits exactly one `agent:usage` event with `final: true` per successful run, immediately before `agent:result`, carrying the session cumulative totals derived from the SDK `result` message.
- [ ] `PiBackend` emits one `agent:usage` event with `final: true` per successful run, immediately before `agent:result`, and its per-turn `agent:usage` emissions carry per-turn deltas (verified by running a fixture multi-turn session and summing the non-final deltas to equal the final cumulative totals).
- [ ] `packages/monitor-ui/src/lib/reducer.ts`'s `agent:usage` handler branches on `event.final === true`: last-wins replacement on final, additive sum into `liveAgentUsage[event.agentId]` and into the matching `AgentThread` numeric fields otherwise; entries missing from `liveAgentUsage` are seeded from zero on the first delta.
- [ ] `test/backend-common.test.ts` covers: `buildAgentStartEvent` with only required fields emits no keys with `undefined` values; `buildAgentStartEvent` with every optional field set returns all of them at the top level of the event; `normalizeToolUseId` returns `id` when only `id` is present, returns `toolCallId` when only `toolCallId` is present, prefers `id` when both are present, and throws with a message naming both field names when neither is present.
- [ ] `pnpm type-check` exits zero.
- [ ] `pnpm test` exits zero (the new `test/backend-common.test.ts` plus the existing `test/agent-wiring.test.ts` suite pass unchanged).
- [ ] `pnpm build` exits zero.
