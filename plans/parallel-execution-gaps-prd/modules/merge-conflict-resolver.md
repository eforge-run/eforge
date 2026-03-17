# Merge Conflict Resolver Agent

## Architecture Reference

This module implements [Merge Conflict Resolver Agent] and [Between merge-conflict-resolver and orchestrator] from the architecture.

Key constraints from architecture:
- The merge resolver agent implements the existing `MergeResolver` callback type from `worktree.ts` - receives `MergeConflictInfo`, returns `Promise<boolean>`
- The agent is an async generator yielding `EforgeEvent`s, but the callback signature returns `boolean` - the bridge in `eforge.ts` iterates the generator, yields events, and returns the boolean result
- `MergeConflictInfo` gains optional fields for plan context: `planName`, `planSummary`, `otherPlanName`, `otherPlanSummary`
- The orchestrator needs to accept an event sink alongside the resolver callback so merge-resolution events are visible in the monitor
- Follows the same structure as `validation-fixer.ts`: options interface, async generator, `AgentBackend` for LLM interaction, lifecycle events

## Scope

### In Scope
- New `runMergeConflictResolver()` async generator agent
- New `merge-conflict-resolver.md` prompt file
- Extending `MergeConflictInfo` with plan context fields
- New `merge:resolve:start` / `merge:resolve:complete` event types
- Adding `'merge-conflict-resolver'` to the `AgentRole` union
- Wiring the agent as the `MergeResolver` callback in `eforge.ts`
- Plumbing plan context (plan names, summaries) from the orchestrator into `MergeConflictInfo`
- Agent wiring tests using `StubBackend`

### Out of Scope
- Edit region markers (separate module)
- Changes to the orchestrator's control flow or merge logic in `worktree.ts` (the callback interface and merge/abort flow already exist)
- Retry logic for failed resolutions (if the agent can't resolve, fall through to existing abort behavior)

## Implementation Approach

### Overview

The merge conflict resolver follows the validation-fixer pattern: a one-shot coding agent that receives conflict context in its prompt, uses tools to read/edit files in the repo, and resolves the conflicts. The agent runner yields lifecycle events (`merge:resolve:start`/`complete`) and delegates to `AgentBackend.run()` with `tools: 'coding'`. The callback bridge in `eforge.ts` wraps the generator, forwards events to the orchestrator's event stream, and returns `true`/`false` based on whether the agent succeeded.

### Key Decisions

1. **One-shot coding agent, not multi-turn** - Merge conflicts are localized to specific files with clear conflict markers. The agent reads the conflicted files, understands intent from both plans, edits to resolve, and stages. No interactive loop needed. Uses `maxTurns: 30` (same as validation-fixer) to give the agent room for multi-file conflicts, but the prompt is one-shot in intent.

2. **Plan context via extended `MergeConflictInfo`** - The agent needs to understand what each side was trying to accomplish, not just the raw diff. Adding optional `planName`, `planSummary`, `otherPlanName`, `otherPlanSummary` fields to `MergeConflictInfo` gives the agent enough intent context without requiring it to re-read plan files. The orchestrator populates these from plan file frontmatter during merge.

3. **Event sink on orchestrator for merge-resolution events** - The `MergeResolver` callback returns `Promise<boolean>`, but the agent yields events. The bridge closure in `eforge.ts` can't yield (it's inside a `Promise`-returning function called by `mergeWorktree`). Instead, the orchestrator accepts an optional `eventSink: (event: EforgeEvent) => void` alongside `mergeResolver`. The bridge pushes events to this sink, and the orchestrator's `execute()` generator drains them interleaved with its own events.

4. **Post-resolution verification stays in `worktree.ts`** - After the resolver returns `true`, the existing code in `mergeWorktree()` already verifies no conflict markers remain (lines 150-158). No duplication needed in the agent.

## Files

### Create
- `src/engine/agents/merge-conflict-resolver.ts` - Agent runner: `MergeConflictResolverOptions` interface and `runMergeConflictResolver()` async generator
- `src/engine/prompts/merge-conflict-resolver.md` - Agent prompt with template variables for conflict context and plan summaries
- `test/merge-conflict-resolver.test.ts` - Agent wiring tests using `StubBackend`

### Modify
- `src/engine/events.ts` - Add `'merge-conflict-resolver'` to `AgentRole` union; add `merge:resolve:start` and `merge:resolve:complete` event variants to `EforgeEvent`
- `src/engine/worktree.ts` - Extend `MergeConflictInfo` with optional `planName?: string`, `planSummary?: string`, `otherPlanName?: string`, `otherPlanSummary?: string` fields
- `src/engine/orchestrator.ts` - (1) Add optional `eventSink?: (event: EforgeEvent) => void` to `OrchestratorOptions`; (2) populate plan context fields on `MergeConflictInfo` before calling the resolver; (3) drain events from the sink in the `execute()` generator between yields
- `src/engine/eforge.ts` - Create `mergeResolver` callback closure (mirroring `validationFixer` pattern): imports `runMergeConflictResolver`, creates tracing span, iterates agent events pushing to orchestrator's event sink, returns boolean; pass both `mergeResolver` and `eventSink` to `Orchestrator` constructor

## Detailed Implementation

### Agent runner (`src/engine/agents/merge-conflict-resolver.ts`)

```typescript
export interface MergeConflictResolverOptions {
  backend: AgentBackend;
  cwd: string;        // repoRoot - agent runs here to read/edit conflicted files
  conflict: MergeConflictInfo;
  verbose?: boolean;
  abortController?: AbortController;
}

export async function* runMergeConflictResolver(
  options: MergeConflictResolverOptions,
): AsyncGenerator<EforgeEvent>
```

- Yields `{ type: 'merge:resolve:start', planId: options.conflict.branch }` before agent call
- Loads prompt via `loadPrompt('merge-conflict-resolver', { ... })` with template vars:
  - `{{branch}}` - the branch being merged
  - `{{base_branch}}` - the target branch
  - `{{conflicted_files}}` - newline-separated list of conflicted file paths
  - `{{conflict_diff}}` - full diff with conflict markers
  - `{{plan_name}}` - name of the plan being merged (from extended `MergeConflictInfo`)
  - `{{plan_summary}}` - summary of what the plan intended
  - `{{other_plan_name}}` - name of the plan that merged first
  - `{{other_plan_summary}}` - summary of the other plan's intent
- Calls `backend.run()` with `tools: 'coding'`, `maxTurns: 30`, agent role `'merge-conflict-resolver'`
- Iterates backend events, yielding always-yielded events and (when verbose) all events
- Does not parse structured output - the agent's job is to edit files and `git add` them, not produce XML
- Yields `{ type: 'merge:resolve:complete', planId: options.conflict.branch, resolved: true }` on successful completion
- On error (non-abort): yields `{ type: 'merge:resolve:complete', planId: options.conflict.branch, resolved: false }`, does not rethrow

### Prompt (`src/engine/prompts/merge-conflict-resolver.md`)

The prompt instructs the agent to:
1. Understand the intent of both plans from the provided summaries
2. Read the conflicted files to see the full context (not just the diff)
3. Resolve each conflict by choosing the correct combination of both sides' changes
4. `git add` each resolved file
5. Not create a commit (the caller handles that)

Key prompt sections:
- Context block with branch names, plan names, plan summaries
- The conflict diff with markers
- List of conflicted files
- Instructions: resolve all conflicts, preserve intent from both plans, stage resolved files
- Explicit constraint: do NOT run `git commit` or `git merge --continue`

### Event types (`src/engine/events.ts`)

Add to `AgentRole`:
```typescript
export type AgentRole = '...' | 'merge-conflict-resolver';
```

Add to `EforgeEvent` union (in the Orchestration section, after `merge:complete`):
```typescript
| { type: 'merge:resolve:start'; planId: string }
| { type: 'merge:resolve:complete'; planId: string; resolved: boolean }
```

### `MergeConflictInfo` extension (`src/engine/worktree.ts`)

Add four optional fields to the existing interface:
```typescript
export interface MergeConflictInfo {
  branch: string;
  baseBranch: string;
  conflictedFiles: string[];
  conflictDiff: string;
  /** Name of the plan whose branch is being merged */
  planName?: string;
  /** Summary of what the plan being merged intended to accomplish */
  planSummary?: string;
  /** Name of a plan that already merged and may have caused the conflict */
  otherPlanName?: string;
  /** Summary of the other plan's intent */
  otherPlanSummary?: string;
}
```

### Orchestrator changes (`src/engine/orchestrator.ts`)

1. Add `eventSink?: (event: EforgeEvent) => void` to `OrchestratorOptions`
2. In the merge section of `execute()`, before calling `mergeWorktree()`, look up the plan being merged and any same-wave plans that already merged. Wrap the `mergeResolver` callback to inject plan context into `MergeConflictInfo`:
   - `planName` and `planSummary` from the current plan's frontmatter
   - `otherPlanName` and `otherPlanSummary` from the most recently merged same-wave plan (heuristic - the likely conflict source)
3. After `mergeWorktree()` returns, drain any buffered events from the event sink by yielding them

### Wiring in `eforge.ts`

Create a `mergeResolver` callback closure following the `validationFixer` pattern:

```typescript
const mergeEvents: EforgeEvent[] = [];
const mergeEventSink = (event: EforgeEvent) => { mergeEvents.push(event); };

const mergeResolver: MergeResolver = async (repoRoot, conflict) => {
  const resolverSpan = tracing.createSpan('merge-conflict-resolver', {
    branch: conflict.branch,
    files: conflict.conflictedFiles,
  });
  const resolverTracker = createToolTracker(resolverSpan);
  let resolved = false;
  try {
    for await (const event of runMergeConflictResolver({
      backend,
      cwd: repoRoot,
      conflict,
      verbose,
      abortController,
    })) {
      resolverTracker.handleEvent(event);
      mergeEventSink(event);
      if (event.type === 'merge:resolve:complete') {
        resolved = event.resolved;
      }
    }
    resolverTracker.cleanup();
    resolverSpan.end();
  } catch (err) {
    resolverTracker.cleanup();
    resolverSpan.error(err as Error);
  }
  return resolved;
};
```

Pass `mergeResolver` and `mergeEventSink` (as `eventSink`) to the `Orchestrator` constructor.

## Testing Strategy

### Unit Tests (`test/merge-conflict-resolver.test.ts`)

- **Lifecycle events**: Run `runMergeConflictResolver` with a `StubBackend` that returns a simple text response. Verify the event stream contains `merge:resolve:start` followed by `agent:start`, `agent:stop`, and `merge:resolve:complete` with `resolved: true`.
- **Error propagation**: Configure `StubBackend` to throw a non-abort error. Verify `merge:resolve:complete` is emitted with `resolved: false` and the error does not propagate.
- **Abort handling**: Configure `StubBackend` to throw an `AbortError`. Verify the error is re-thrown (not swallowed).
- **Prompt variable interpolation**: Verify that `loadPrompt` is called with the expected template variables by checking the prompt passed to `backend.run()` (StubBackend captures this in `lastRunOptions`).
- **Plan context in prompt**: Provide `planName`, `planSummary`, `otherPlanName`, `otherPlanSummary` in the conflict info. Verify these appear in the prompt passed to the backend.
- **Missing plan context**: Omit optional plan context fields. Verify the agent runs without error (template vars resolve to empty strings).

### Not Tested (integration-level)

- Actual git merge conflict resolution (requires real git repos)
- Orchestrator event sink draining (orchestrator integration)
- End-to-end merge → resolve → commit flow
- `eforge.ts` callback wiring (tested via eval scenarios)

## Verification

- [ ] `runMergeConflictResolver()` yields `merge:resolve:start` before calling `backend.run()` and `merge:resolve:complete` after
- [ ] `merge:resolve:complete` event includes `resolved: boolean` field reflecting success/failure
- [ ] Agent role `'merge-conflict-resolver'` exists in the `AgentRole` union in `events.ts`
- [ ] `MergeConflictInfo` in `worktree.ts` has optional `planName`, `planSummary`, `otherPlanName`, `otherPlanSummary` fields
- [ ] `backend.run()` is called with `tools: 'coding'` and agent role `'merge-conflict-resolver'`
- [ ] Non-abort errors in the agent are caught and result in `resolved: false` (not re-thrown)
- [ ] `AbortError` from the agent is re-thrown (not swallowed)
- [ ] The prompt template includes `{{branch}}`, `{{base_branch}}`, `{{conflicted_files}}`, `{{conflict_diff}}`, `{{plan_name}}`, `{{plan_summary}}`, `{{other_plan_name}}`, `{{other_plan_summary}}`
- [ ] `OrchestratorOptions` accepts an optional `eventSink` callback
- [ ] `eforge.ts` constructs a `mergeResolver` closure and passes it to the `Orchestrator`
- [ ] All tests in `test/merge-conflict-resolver.test.ts` pass via `pnpm test`
- [ ] `pnpm type-check` passes with no errors
