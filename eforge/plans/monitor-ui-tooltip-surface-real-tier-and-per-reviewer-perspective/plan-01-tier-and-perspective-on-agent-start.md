---
id: plan-01-tier-and-perspective-on-agent-start
name: Surface tier and reviewer perspective on agent:start
branch: monitor-ui-tooltip-surface-real-tier-and-per-reviewer-perspective/tier-and-perspective
---

# Surface tier and reviewer perspective on agent:start

## Architecture Context

Two data-flow defects in the monitor UI tooltip share the same root-cause shape: information resolved upstream is dropped before it reaches the harness, so the `agent:start` event the monitor consumes never carries it.

**Defect 1 - tier shows `unknown`.** `resolveTierForRole` in `packages/engine/src/pipeline/agent-config.ts:88-101` always returns a real `AgentTier` plus a `tierSource` provenance. Pipeline stages spread the resolved config into agent-runner options. At the agent-runner -> harness boundary, every runner calls `harness.run({ ..., ...pickSdkOptions(options) }, ...)`. `pickSdkOptions` (`packages/engine/src/harness.ts:50`) drops keys in `NON_SDK_KEYS`, which today includes `tier`, `tierSource`, `effortSource`, `thinkingSource`, `effortClamped`, `effortOriginal`, `thinkingCoerced`, `thinkingOriginal`, `harness`, `harnessSource`. These are all valid `AgentRunOptions` fields the harness needs for `agent:start` stamping and for the `thinking-coerced` warning - they are not SDK fields, but the exclusion was overly broad. With `tier` stripped, both harnesses fall back to the literal string `'unknown'`. The harness already explicitly picks which fields to forward to the underlying SDK (`packages/engine/src/harnesses/claude-sdk.ts:207-235` enumerates `model`, `cwd`, `maxTurns`, `tools`, `effort`, `thinking`, `maxBudgetUsd`, `fallbackModel`, `allowedTools`, `disallowedTools`, plus `abortController`), so trimming `NON_SDK_KEYS` will not leak metadata into the SDK call.

**Defect 2 - no perspective on `agent:start`.** `packages/engine/src/agents/parallel-reviewer.ts:165-196` creates one `ParallelTask` per perspective. Each task calls `harness.run({ ..., ...pickSdkOptions(options) }, 'reviewer', planId)`. The `agent` argument is the literal string `'reviewer'` - perspective is never passed in. `BuildAgentStartEventOptions` (`packages/engine/src/harnesses/common.ts:19-40`) does not have a `perspective` field; the `agent:start` event union (`packages/engine/src/events.ts:243`) does not have one either. The path is intentionally generic: making `perspective` an optional `string` (not narrowed to `ReviewPerspective`) lets future fan-outs (planner per module, builder per shard) reuse the same plumbing without another schema change.

## Implementation

### Overview

Trim `NON_SDK_KEYS` to just `'promptAppend'` so the resolved metadata flows through to the harness. Drop the `?? 'unknown'` / `?? 'tier'` fallbacks in both harnesses. Add an optional `perspective?: string` to `AgentRunOptions`, `BuildAgentStartEventOptions`, the `agent:start` event variant, and `AgentThread`. Forward `perspective` from `parallel-reviewer.ts` into `harness.run`. Render a `perspective: <name>` line in the tooltip when set.

### Key Decisions

1. **Trim `NON_SDK_KEYS` to `'promptAppend'` only** rather than enumerate fields by purpose. The SDK call is already explicit about which fields it forwards (`claude-sdk.ts:207-235` and the equivalent block in `pi.ts`), so anything not on that explicit list is automatically safe. The narrower set documents intent ("only `promptAppend` is stripped because it's a prompt-shaping field, not a passthrough") and prevents future regressions when new metadata fields are added to `AgentRunOptions`.
2. **Drop the `?? 'unknown'` and `?? 'tier'` fallbacks entirely** in both harnesses. `resolveTierForRole` always populates real values - the fallbacks were defensive coding for an upstream bug that was never real. Keeping them would silently mask future regressions in the resolver. Now if `tier` is missing, the type system will catch it at the call site.
3. **Type `perspective` as `string`, not `ReviewPerspective`.** Per the PRD's explicit out-of-scope item, this lets future fan-outs (planner per module, builder per shard) reuse the same plumbing without another schema change. Reviewers happen to use `code | security | api | docs | test | verify` today, but the field semantics are "which specialist is this agent acting as," which is broader than review.
4. **No new tests beyond what existing harnesses suites cover.** Per the PRD: data-flow plumbing only, no new modules. Existing tests in `test/agent-config.tier-resolution.test.ts`, `test/claude-sdk-backend.test.ts`, and `test/backend-common.test.ts` already cover tier resolution and `buildAgentStartEvent`; they will fail loudly if the change breaks resolution. Update them as needed when removing the `?? 'unknown'` literal expectations.
5. **Tooltip renders `perspective: <name>` only when set.** Non-reviewer strips (planner, builder, evaluator) have undefined `perspective` and render no perspective line. Single (non-parallel) reviewers also have no `perspective` set because `parallel-reviewer.ts` is the only call site that supplies it. This matches AC #10 and #12.

## Scope

### In Scope

- Trim `NON_SDK_KEYS` in `packages/engine/src/harness.ts` to `new Set(['promptAppend'])` so all resolved metadata fields (`tier`, `tierSource`, `harness`, `harnessSource`, `effortSource`, `thinkingSource`, `effortClamped`, `effortOriginal`, `thinkingCoerced`, `thinkingOriginal`) flow through `pickSdkOptions` to the harness.
- Add optional `perspective?: string` to `AgentRunOptions` in `packages/engine/src/harness.ts` (alongside the existing tier/source/clamping fields).
- Add optional `perspective?: string` to the `agent:start` event variant in `packages/engine/src/events.ts:243`.
- Add optional `perspective?: string` to `BuildAgentStartEventOptions` in `packages/engine/src/harnesses/common.ts:19-40`. Update `buildAgentStartEvent` to copy `perspective` onto the event when defined (mirror existing `effortSource` handling at line 60).
- Drop the `tier: options.tier ?? 'unknown'` and `tierSource: options.tierSource ?? 'tier'` fallbacks in `packages/engine/src/harnesses/claude-sdk.ts:119-120`. Drop the `harnessSource: options.harnessSource ?? 'tier'` fallback at line 118. Pass `perspective: options.perspective` through to `buildAgentStartEvent`.
- Drop the same fallbacks in `packages/engine/src/harnesses/pi.ts` in all three branches (no-model: lines 285-287; no-provider: lines 308-310; normal run: lines 332-334). Pass `perspective: options.perspective` through to `buildAgentStartEvent` in each branch.
- Forward `perspective` from `packages/engine/src/agents/parallel-reviewer.ts:178` into `harness.run`. Inside the per-perspective `run` closure, pass `perspective` (the closure variable from `perspectives.map`) as part of the options object.
- Add `perspective?: string` to `AgentThread` in `packages/monitor-ui/src/lib/reducer.ts:35-61`. Capture it in the `agent:start` handler at lines 306-332 (mirror the existing `tier` extraction pattern: `'perspective' in event ? (event as { perspective?: string }).perspective : undefined`).
- Render a `perspective: <name>` tooltip line in `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (insert after the existing `tier` block at lines 873-880, conditional on `thread.perspective` being defined).
- Update any tests in `test/` that assert `tier === 'unknown'` literal or that exercise the `pickSdkOptions` strip set so they reflect the new behavior. Likely candidates: `test/claude-sdk-backend.test.ts`, `test/backend-common.test.ts`, `test/agent-config.tier-resolution.test.ts`. Do not add new test files - update assertions in place.

### Out of Scope

- Narrowing `perspective` to a `ReviewPerspective` union type. It stays `string` so future fan-outs (planner per module, builder per shard) can reuse the field without a schema change.
- Cross-cutting redesign of how metadata fields flow from resolver to harness. The fix is local: trim `NON_SDK_KEYS`, drop fallbacks, add one new field.
- Surfacing `perspective` on lifecycle events other than `agent:start` (e.g. `agent:stop`, `agent:result`). The PRD targets the agent-strip tooltip only, which keys off `agent:start`.
- New regression tests beyond updates to existing assertions. Existing harness/resolver test coverage is sufficient.
- Dependency upgrades, new modules, or behavioral changes outside the tier/perspective surfacing path.

## Files

### Modify

- `packages/engine/src/harness.ts` - trim `NON_SDK_KEYS` to `new Set(['promptAppend'])`; add `perspective?: string` to `AgentRunOptions`.
- `packages/engine/src/events.ts` - add optional `perspective?: string` to the `agent:start` event variant.
- `packages/engine/src/harnesses/common.ts` - add `perspective?: string` to `BuildAgentStartEventOptions`; in `buildAgentStartEvent`, copy `opts.perspective` onto the event when defined.
- `packages/engine/src/harnesses/claude-sdk.ts` - drop the `?? 'unknown'` fallback for `tier`, the `?? 'tier'` fallbacks for `tierSource` and `harnessSource`. Pass `perspective: options.perspective` to `buildAgentStartEvent`.
- `packages/engine/src/harnesses/pi.ts` - drop the same fallbacks in all three call sites (no-model branch ~lines 279-296, no-provider branch ~lines 301-319, normal-run branch ~lines 326-343). Pass `perspective: options.perspective` to `buildAgentStartEvent` in each.
- `packages/engine/src/agents/parallel-reviewer.ts` - in the `tasks` closure (~line 178), include `perspective` in the options object passed to `harness.run`.
- `packages/monitor-ui/src/lib/reducer.ts` - add `perspective?: string` to `AgentThread`; in the `agent:start` handler (~lines 306-332), capture `perspective` from the event using the same `'perspective' in event` pattern used for `tier`.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` - insert a new tooltip line after the `tier` block (~lines 873-880), conditional on `thread.perspective`, rendering `perspective: {thread.perspective}`. Match the styling of adjacent metadata lines (`opacity-50 text-[10px]`).
- Existing tests under `test/` that assert the old `'unknown'` tier behavior or `pickSdkOptions` strip set - update assertions in place. Run `pnpm test` and update failing tests to reflect the new behavior.

## Verification

- [ ] `pnpm type-check` exits 0 across all workspace packages.
- [ ] `pnpm test` exits 0; any test that previously asserted `tier === 'unknown'` literal has been updated to assert the resolved tier value.
- [ ] `pnpm build` produces a clean engine bundle with no `tier: options.tier ?? 'unknown'` or `tierSource: options.tierSource ?? 'tier'` or `harnessSource: options.harnessSource ?? 'tier'` strings remaining in `packages/engine/src/harnesses/claude-sdk.ts` or `packages/engine/src/harnesses/pi.ts` (verify with grep).
- [ ] In `packages/engine/src/harness.ts`, `NON_SDK_KEYS` contains exactly one entry: `'promptAppend'`.
- [ ] Hover any agent strip in the monitor UI for a freshly-run build: tooltip shows `tier: <real-tier> (<source>)` where `<real-tier>` is one of `planning | implementation | review | evaluation` and `<source>` is one of `tier | role | plan`. The literal string `unknown` does not appear in the tier line for any agent strip.
- [ ] Trigger a parallel review (10+ files changed or set `strategy: parallel` on the plan's review config). Hover each of the parallel reviewer strips: each tooltip shows a `perspective: <name>` line where `<name>` is one of `code | security | api | docs | test | verify`. Each parallel strip displays a distinct perspective; no two strips show the same perspective.
- [ ] Trigger a single (non-parallel) review. The reviewer strip tooltip does not show a `perspective:` line.
- [ ] Hover non-reviewer strips (planner, builder, evaluator, doc-author, doc-syncer, tester): tooltip shows the real tier with no `perspective:` line.
- [ ] Trigger a build where an agent's effort is clamped (e.g. xhigh requested on a model that caps at high): tooltip shows `effort: high (clamped from xhigh)` with the source provenance suffix, confirming the previously-stripped `effortClamped` and `effortOriginal` fields now flow through.
- [ ] Trigger a build where a user has set a per-role tier override in `~/.config/eforge/config.yaml`: tooltip shows `tier: <tier> (role)` with the `(role)` source styled in amber per the existing tooltip rule at thread-pipeline.tsx:874.
