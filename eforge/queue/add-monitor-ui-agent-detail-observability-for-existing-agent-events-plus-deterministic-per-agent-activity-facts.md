---
title: Add monitor UI agent detail observability for existing agent events plus deterministic per-agent activity facts
created: 2026-05-14
profile: claude-sdk-4-7
---

# Add monitor UI agent detail observability for existing agent events plus deterministic per-agent activity facts

## Problem / Motivation

The monitor pipeline already shows agent lifespans and aggregate usage, but clicking/inspecting an individual agent does not provide a concise, per-agent view of what happened. Users want to understand an agent's work without paying for extra LLM-generated summaries by default.

Evidence reviewed:

- `packages/client/src/events.schemas.ts` is the wire-protocol source of truth. It already defines `agent:start`, `agent:usage`, `agent:message`, `agent:tool_use`, `agent:tool_result`, `agent:result`, and `agent:stop`.
- `agent:result` currently carries `durationMs`, `durationApiMs`, `numTurns`, `totalCostUsd`, token usage, model usage, and optional `resultText`, but its schema/event shape does not include `agentId`.
- Harnesses (`packages/engine/src/harnesses/claude-sdk.ts`, `packages/engine/src/harnesses/pi.ts`) emit `agentId` on start/usage/tool/stop events and emit final `agent:usage` immediately before `agent:result`; `agent:result` is emitted without `agentId`.
- Monitor UI state (`packages/monitor-ui/src/lib/reducer.ts`, `packages/monitor-ui/src/lib/reducer/handle-agent.ts`) already creates `AgentThread` entries and tracks duration/tokens/cost/turns, but does not preserve `resultText` on the thread.
- Pipeline UI (`packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx`, `plan-row.tsx`, `activity-overlay.tsx`) already groups streaming activity by `agentId`, renders clickable-looking lifespan bars with tool/message density overlays, and uses shadcn-style `SheetContent` elsewhere for drill-down drawers.
- Existing file-change tracking is plan-level: `packages/engine/src/pipeline/git-helpers.ts` emits `plan:build:files_changed` with file names and per-file diffs. `packages/engine/src/prd-validator-diff.ts` already contains robust `git diff --name-status -z` / `--numstat -z` parsing patterns that can inform a small shared diffstat helper.
- Roadmap alignment: this fits the integration/maturity theme of keeping runtime choice, cost, and agent work visible. It does not conflict with current roadmap items.

Assumptions / unknowns:

- Per-agent file/LOC attribution is reliable for sequential mutating build stages, but may be ambiguous if multiple mutating agents operate concurrently in the same worktree. Current evidence suggests builder/fixer flows are mostly wrapped/staged serially, but this should be validated while implementing.
- Existing `agent:result.resultText` may be useful enough for a first-pass human-readable "what happened" section. It is not guaranteed to be a concise summary, so UI should label it as the agent's final result, not a generated summary.

Pipeline bars already receive per-agent streaming events through `eventsByAgent`, so a details drawer can be built from existing state rather than a new model call.

## Goal

Implement the recommended first three layers: expose existing result text, add an agent detail drawer, and add deterministic per-agent activity facts where reliable. Avoid LLM-generated summaries in this scope.

## Approach

### Design Decisions

1. **Do not add LLM summarization in this change.**
   - Rationale: existing events and deterministic git facts should provide most of the desired observability with zero extra model spend or latency.
   - Future-compatible: an optional/on-demand LLM summary can later consume the same facts if this UI proves useful.

2. **Treat `agent:result.resultText` as existing final output, not as a generated summary.**
   - UI label should avoid overpromising. Use "Final result" / "Agent final text" rather than "Summary".
   - Preserve the raw text with reasonable truncation/collapse controls.

3. **Make `agentId` the primary matching key for agent results going forward.**
   - Add `agentId` to emitted `agent:result` and schema as optional/backward-compatible.
   - Reducer matching should prefer `event.agentId` when available, then fall back to current reverse scan by `(agent, planId, durationMs === null)` for historical logs.

4. **Add a deterministic facts event rather than embedding everything in `agent:stop`.**
   - Candidate name: `agent:activity` or `agent:activity:complete`.
   - Rationale: `agent:stop` is lifecycle/status; file stats and derived facts are observational data and may be unavailable without implying stop failure.
   - Suggested shape:
     ```ts
     {
       type: 'agent:activity',
       agentId: string,
       planId?: string,
       agent: AgentRole,
       files?: Array<{ path: string; status?: string; additions?: number; deletions?: number; binary?: boolean }>,
       totals?: { filesChanged: number; additions: number; deletions: number },
       attribution: 'exact' | 'best_effort' | 'unavailable',
       notes?: string[]
     }
     ```

5. **Keep attribution honest.**
   - If computed from before/after snapshots around a single mutating agent in one worktree, mark `exact` or near-exact.
   - If multiple agents can mutate concurrently or the helper cannot isolate the change, mark `best_effort` or `unavailable` and explain in `notes`.

6. **UI drawer should derive as much as possible from existing stored events.**
   - Warnings/retries/errors/tool calls/messages can be grouped by `agentId` from `RunState.events`.
   - Avoid duplicating all event payloads into `AgentThread`; only store durable per-thread summaries like `resultText` and deterministic activity facts.

7. **Keep large payloads safe for the UI.**
   - Tool inputs/results and result text should be truncated/collapsible.
   - The drawer can show counts first, then expandable raw details.

### Expected Code Impact

**Client / event contract:**
- `packages/client/src/events.schemas.ts`
  - Add optional `agentId` to `agent:result` for robust per-agent matching. Keep optional/backward-compatible for old event logs.
  - Add deterministic activity event schema if implementing emitted facts, e.g. `agent:activity` / `agent:activity:complete`.
- `packages/client/src/event-registry.ts`
  - Add registry metadata for any new event.
- Client wire/schema tests:
  - `packages/client/src/__tests__/events-wire-parity.test.ts`
  - `packages/client/src/__tests__/events-schemas.test.ts`

**Engine:**
- `packages/engine/src/harnesses/claude-sdk.ts`
- `packages/engine/src/harnesses/pi.ts`
  - Include `agentId` on emitted `agent:result` events.
- `packages/engine/src/pipeline/git-helpers.ts`
  - Add or call a helper for deterministic file stats around an agent run.
  - Existing plan-level `plan:build:files_changed` should remain unchanged unless shared helper extraction makes it natural to improve internals.
- Potential new helper near git utilities, or shared extraction from `packages/engine/src/prd-validator-diff.ts`, for robust `git diff --name-status -z` / `--numstat -z` parsing.
- Build-stage wrappers in `packages/engine/src/pipeline/stages/build-stages.ts`
  - Wrap mutating agent runs where per-agent file/LOC attribution is reliable, especially builder and review-fixer paths. Consider doc/test/validation-fixer agents if they mutate the worktree and run sequentially.

**Monitor UI state:**
- `packages/monitor-ui/src/lib/reducer.ts`
  - Add `resultText?: string`, and possibly `activity?: AgentActivityFacts`, to `AgentThread`.
- `packages/monitor-ui/src/lib/reducer/handle-agent.ts`
  - Populate `resultText` from `agent:result`.
  - Prefer matching by `agentId` when present; preserve existing role/plan reverse-walk fallback for old logs.
  - Handle new deterministic activity event if added.
- Reducer tests:
  - `packages/monitor-ui/src/lib/reducer/__tests__/handle-agent.test.ts`
  - `test/monitor-reducer.test.ts` or focused monitor-ui tests as appropriate.

**Monitor UI components:**
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx`
- `packages/monitor-ui/src/components/pipeline/plan-row.tsx`
  - Pass event details and click handler into agent bars.
- New component likely under `packages/monitor-ui/src/components/pipeline/agent-detail-sheet.tsx`.
- Existing `ActivityOverlay` can remain focused on density; the new drawer can show detailed event/tool information.

Documentation likely minimal for this scoped UX improvement unless public monitor docs/screenshots are affected. If screenshots or monitor docs mention pipeline interactions, update them.

### Profile Signal

Recommended profile: **Excursion**.

Rationale: this is a cohesive multi-file feature touching the client event schema, engine harness/event emission, monitor reducer, and monitor UI. A single planner can describe the work without delegated module planning, so Expedition would be unnecessary. It is more than an Errand because it changes wire schema, reducer semantics, and UI behavior with tests.

### Assumptions And Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| Existing event stream has enough raw data for a useful first-pass drawer without an LLM call. | Verified schemas and reducer/UI paths for lifecycle, usage, result text, tool, message, warning, retry, and stop events. | High | Low | Build the drawer from `RunState.events` and `AgentThread`; verify with event replay tests. | Low; if insufficient, future optional/on-demand summary can still be added. |
| `agent:result.resultText` is available from both harnesses. | Verified `extractResultData` / Pi result handling and tests references; both harnesses can emit optional `resultText`. | High | Low | Add reducer test with result text from both old-style and new-style events. | Medium; drawer would still show deterministic facts but less narrative context. |
| Adding optional `agentId` to `agent:result` is backward-compatible. | Event schemas are TypeBox and old logs can omit optional fields; reducer can keep fallback matching. | High | Low | Add schema tests for with/without `agentId`; replay old fixture if available. | Medium; incorrect matching would make drawer details attach to the wrong thread. |
| Per-agent file/LOC attribution can be exact for at least main sequential mutating stages. | `withPeriodicFileCheck` already wraps builder implementation at stage level; review-fixer and other mutating stages appear staged, but concurrency needs implementation-time verification. | Medium | Medium | Inspect each mutating stage before wrapping; only emit `exact` where pre/post snapshots are isolated. Mark others `best_effort` or skip. | Medium/high; misleading LOC attribution would damage trust in monitor data. |
| Reusing/adapting numstat parsing patterns is better than parsing human diff output. | `prd-validator-diff.ts` already uses `git diff --name-status -z` and `--numstat -z` robustly. | High | Low | Extract small helper or duplicate narrowly with tests; avoid human-output parsing. | Low/medium; fragile parsing would make stats wrong for renamed/binary files. |
| UI can show potentially large result/tool payloads safely. | Existing event card detail already formats tool/result details; drawer can truncate/collapse. | High | Low | Add utility/component tests for truncation; manually inspect with long payloads. | Low; poor truncation could hurt monitor responsiveness/readability. |

No low-confidence/high-impact assumptions need user acceptance before build. The main implementation risk is attribution precision; the plan explicitly requires attribution quality markers and conservative emission.

## Scope

### In scope

1. **Preserve and display existing `agent:result.resultText`**
   - Add an optional field to `AgentThread` in the monitor UI state for the final result text.
   - Populate it in `handleAgentResult`.
   - Display it in the new agent detail drawer as "Final result" or similar, not as an AI-generated summary.

2. **Add an Agent Detail Drawer in the monitor UI**
   - Make each agent lifespan bar in the pipeline clickable.
   - Open a shadcn-style `SheetContent` drawer showing deterministic details for that agent:
     - role, plan, perspective if present
     - model, harness, tier, effort/thinking/toolbelt metadata
     - start/end/duration
     - input/output/cache tokens, cost, turns
     - final result text when available
     - warnings, retries, stop errors
     - tool calls/results summary from existing per-agent events
     - related messages/tool events, with truncation/collapsing for large payloads
   - Reuse existing styling patterns from `DecisionTimeline`, `ProfileBadge`, `RecoverySidecarSheet`, and `DaemonDrawer` where practical.

3. **Add deterministic per-agent activity facts**
   - Prefer factual instrumentation over an LLM summary.
   - Add a wire event for per-agent deterministic facts, likely `agent:activity` or `agent:activity:complete`, with `agentId`, `agent`, optional `planId`, and structured stats.
   - Include file/diffstat facts where reliable: changed files, additions, deletions, status, and an attribution quality marker such as `exact` / `best_effort` / `unavailable`.
   - Compute LOC/file stats with git diff/name-status/numstat helpers, reusing or adapting patterns from `packages/engine/src/prd-validator-diff.ts`.
   - Render those facts in the drawer when present.

### Out of scope

- No additional LLM call for summarization.
- No config for summary model selection.
- No generated prose summaries beyond existing `resultText`.
- No broad redesign of the timeline/pipeline.
- No attempt to make inherently ambiguous concurrent file attribution look exact; ambiguity should be disclosed in the data/UI.

## Acceptance Criteria

1. **Existing final result text is preserved and visible**
   - Given an `agent:result` event with `result.resultText`, the monitor reducer stores it on the corresponding `AgentThread`.
   - The agent detail drawer displays the final result text with a clear label and safe truncation/collapse behavior.

2. **Agent lifespan bars are clickable**
   - Clicking an agent bar in the pipeline opens a detail drawer for that specific agent.
   - Hover behavior/stage highlighting continues to work as before.

3. **Drawer shows deterministic lifecycle and usage facts**
   - Drawer includes role, plan, perspective, model, harness, tier, effort/thinking/toolbelt metadata where available.
   - Drawer includes start/end/duration, token usage, cache read/creation where available, cost, and turns.
   - Drawer includes warnings, retries, stop errors, and relevant tool/message activity grouped for that agent.

4. **Agent result matching is robust**
   - New `agent:result` events include `agentId` from both Claude SDK and Pi harnesses.
   - Monitor reducer prefers `agentId` for result matching and keeps the existing fallback for old logs without `agentId`.

5. **Deterministic per-agent activity facts are emitted/rendered where reliable**
   - A typed client event exists for per-agent activity facts.
   - Engine emits file/diffstat facts for at least the main mutating build agent path where attribution is reliable.
   - Drawer displays changed files plus additions/deletions totals when present.
   - If attribution is best-effort or unavailable, the UI shows that instead of implying precision.

6. **No additional LLM summarization is introduced**
   - No new model call is made for this feature.
   - No new summary-model config is required.

7. **Tests cover the behavior**
   - Wire/schema tests cover any new/changed event fields.
   - Reducer tests cover result text storage, `agentId`-preferred result matching, fallback matching for old logs, and deterministic activity fact storage.
   - UI/component tests or focused logic tests cover drawer data derivation enough to prevent regressions.

8. **Existing validation passes**
   - `pnpm type-check`
   - Relevant vitest tests, or full `pnpm test` if practical.
