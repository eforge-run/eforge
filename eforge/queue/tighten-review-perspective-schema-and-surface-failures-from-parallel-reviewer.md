---
title: Tighten review-perspective schema and surface failures from parallel reviewer
created: 2026-05-06
---

# Tighten review-perspective schema and surface failures from parallel reviewer

## Problem / Motivation

The build-stage `review-cycle` silently no-ops when an orchestration plan requests review perspectives that aren't recognized by `parallel-reviewer.ts`. The orchestration.yaml in the recent event-source-spine expedition specified `perspectives: [correctness, architecture]`, but `PERSPECTIVE_PROMPTS` in `packages/engine/src/agents/parallel-reviewer.ts` only knows six keys (`code, security, api, docs, test, verify`). As a result:

- `PERSPECTIVE_SCHEMA_YAML[perspective]()` is `undefined()` → throws synchronously.
- `runParallel` at `packages/engine/src/concurrency.ts:144-149` catches and silently swallows the throw.
- The reviewer agent never starts. No `agent:start` event fires. The swim lane is empty.
- `plan:build:review:complete` fires with `issues: []` in the same millisecond as `:start`.
- `review-cycle` exits, `review-fix` and `evaluate` are skipped, and the build proceeds as if review passed cleanly.

The schemas at `packages/engine/src/schemas.ts:456` and `packages/engine/src/config.ts:110` declare `perspectives: z.array(z.string()).nonempty()` — any string passes validation. The doc example in `config.ts:110` even uses an invalid example (`"performance"`).

Net effect: ~6.5K LOC across 4 plans landed on the feature branch without code review. The orchestration plan looked correct (semantically reasonable perspective names) and validation accepted it.

## Goal

Make the perspective vocabulary self-enforcing: invalid names fail at compile-time validation rather than silently disabling reviews. Surface any per-perspective task failure as a domain event in the timeline so future failures are visible.

## Approach

Five small touches across four files in `packages/`:

### 1. `packages/client/src/events.ts`

Lift `ReviewPerspective` to a const-derived type so a single source of truth feeds both the type and the schema:

```ts
// Replace line 64:
export type ReviewPerspective = 'code' | 'security' | 'api' | 'docs' | 'test' | 'verify';

// With:
export const REVIEW_PERSPECTIVES = ['code', 'security', 'api', 'docs', 'test', 'verify'] as const;
export type ReviewPerspective = typeof REVIEW_PERSPECTIVES[number];
```

In the `EforgeEvent` union (after line 336, after `perspective:complete`), add the error variant:

```ts
| { type: 'plan:build:review:parallel:perspective:error'; planId: string; perspective: string; error: string }
```

Use `perspective: string` (not `ReviewPerspective`) on the error variant — the whole point is to surface invalid names that wouldn't fit the enum.

### 2. `packages/engine/src/schemas.ts:456`

```ts
// Before:
perspectives: z.array(z.string()).nonempty().describe('Review perspective names'),

// After:
perspectives: z.array(z.enum(REVIEW_PERSPECTIVES)).nonempty()
  .describe(`Review perspective names. Valid: ${REVIEW_PERSPECTIVES.join(', ')}`),
```

Plus `import { REVIEW_PERSPECTIVES } from '@eforge-build/client';` at the top.

### 3. `packages/engine/src/config.ts:110`

Same enum swap as schemas.ts. Drop the misleading `"performance"` from the doc example — replace with a real example like `["code", "security", "api"]`.

### 4. `packages/engine/src/agents/parallel-reviewer.ts:165-196`

Wrap each perspective task body in try/catch so the error surfaces instead of being eaten by `runParallel`:

```ts
const tasks: ParallelTask<EforgeEvent>[] = perspectives.map((perspective) => ({
  id: `review-${perspective}`,
  run: async function* (): AsyncGenerator<EforgeEvent> {
    yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:perspective:start', planId, perspective };
    try {
      const prompt = await loadPrompt(PERSPECTIVE_PROMPTS[perspective], {
        plan_content: planContent,
        base_branch: baseBranch,
        review_issue_schema: PERSPECTIVE_SCHEMA_YAML[perspective](),
      }, options.promptAppend);

      let fullText = '';
      for await (const event of harness.run(
        { prompt, cwd, maxTurns: 30, tools: 'coding', abortSignal: abortController?.signal, ...pickSdkOptions(options), perspective },
        'reviewer',
        planId,
      )) {
        if (isAlwaysYieldedAgentEvent(event) || verbose) yield event;
        if (event.type === 'agent:message' && event.content) fullText += event.content;
      }

      const issues = parseReviewIssues(fullText);
      allIssues.push({ perspective, issues });
      yield { timestamp: new Date().toISOString(), type: 'plan:build:review:parallel:perspective:complete', planId, perspective, issues };
    } catch (err) {
      yield {
        timestamp: new Date().toISOString(),
        type: 'plan:build:review:parallel:perspective:error',
        planId,
        perspective,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
}));
```

### 5. Reducer + UI handling

Add a no-op reducer entry for the new event type so type-check passes (the pure-event-reducer work currently in flight is adding `_Exhaustive` registry gates that will catch missing variants). For UI, treat the error event like `perspective:complete` — it terminates a perspective lane, rendered with a failure indicator and the error string in a tooltip.

Update `packages/monitor-ui/src/components/pipeline/__tests__/agent-stage-map.test.ts` to cover the error event.

## Scope

**In scope:**
- The five file edits above.
- Bumping `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` (the EforgeEvent union changed, even though the change is additive).
- If the pure-event-reducer expedition has merged by build time, also add the new event type to the eventRegistry.

**Out of scope:**
- Adding `correctness` and `architecture` as real review perspectives (they don't exist as prompts and would require new prompt files + schemas; defer to a follow-up).
- Updating the planner/pipeline-composer prompts that originally emitted the bad perspective names. The enum tightening means a bad name now hard-fails compile validation, which is self-correcting — the planner will produce visible errors instead of silent reviews.
- Auditing the already-merged code in the event-source-spine expedition (separate effort).

## Acceptance Criteria

1. Setting `review.perspectives: [foo]` in any orchestration.yaml or plan-file frontmatter causes plan compilation to fail with a Zod validation error naming the invalid perspective and listing valid choices.
2. If a reviewer task throws (e.g. for any future runtime failure inside `harness.run`), a `plan:build:review:parallel:perspective:error` event is emitted with the perspective and error message. The event appears in the run-state event log and is visible in the monitor UI's pipeline view.
3. The valid 6-perspective set continues to work end-to-end. At least one integration path exercising one of these perspectives produces an `agent:start` event with `agent: reviewer`, followed by either real `agent:tool_use` activity or a `:perspective:complete` event with parsed issues.
4. `pnpm type-check`, `pnpm test`, and `pnpm build` pass.
