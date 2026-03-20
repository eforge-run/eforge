---
id: plan-03-ui-and-tests
name: CLI Display, Monitor UI, and Agent Wiring Tests
depends_on: [plan-02-pipeline-and-prompts]
branch: tester-agent-separate-test-concerns-from-builder/ui-and-tests
---

# CLI Display, Monitor UI, and Agent Wiring Tests

## Architecture Context

This is the consumer layer: CLI event rendering, monitor web UI updates, and agent wiring tests. All depend on the types from plan-01 and pipeline stages from plan-02 being in place. The exhaustive switch in `display.ts` will fail to compile without handling the new event types.

## Implementation

### Overview

Add rendering for four new test event types in CLI display, update the monitor UI (event cards, reducer, types), and write comprehensive agent wiring tests using StubBackend.

### Key Decisions

1. CLI display follows the existing spinner pattern: `build:test:write:start` and `build:test:start` update the plan spinner text, `complete` events log summary info.
2. Monitor UI `PipelineStage` gets a `'test'` stage. The reducer handles test events to update plan status and accumulate test issues alongside review issues.
3. Tests follow the existing `agent-wiring.test.ts` pattern: stub backend responses, collect events, assert event types and parsed data.

## Scope

### In Scope
- CLI `renderEvent()` cases for `build:test:write:start/complete` and `build:test:start/complete`
- Monitor `event-card.tsx`: `eventSummary()` and `eventDetail()` for test events
- Monitor `reducer.ts`: `processEvent()` handling for test events, plan status tracking
- Monitor `types.ts`: `'test'` added to `PipelineStage`
- Agent wiring tests in `test/tester-wiring.test.ts`
- XML parser tests for `parseTestIssues()` in `test/xml-parsers.test.ts` (if file exists) or in the tester wiring test
- Pipeline integration tests for verification scope detection

### Out of Scope
- Agent implementations (plan-01)
- Pipeline stage registration (plan-02)
- Prompt content (plan-01, plan-02)

## Files

### Create
- `test/tester-wiring.test.ts` — agent wiring tests for test-writer and tester

### Modify
- `src/cli/display.ts` — add rendering for test events in `renderEvent()` switch
- `src/monitor/ui/src/components/timeline/event-card.tsx` — add summaries and details for test events
- `src/monitor/ui/src/lib/reducer.ts` — handle test events in `processEvent()`
- `src/monitor/ui/src/lib/types.ts` — add `'test'` to `PipelineStage` union

## Detailed Changes

### `src/cli/display.ts`

Add four cases in the `renderEvent()` switch, after the `build:doc-update:complete` case (line 336) and before `build:files_changed`:

```typescript
case 'build:test:write:start': {
  const s = spinners.get(`build:${event.planId}`);
  if (s) s.text = `${chalk.cyan(event.planId)} — writing tests...`;
  break;
}

case 'build:test:write:complete': {
  if (event.testsWritten > 0) {
    console.log(chalk.dim(`  ${chalk.cyan(event.planId)} — ${event.testsWritten} test(s) written`));
  }
  break;
}

case 'build:test:start': {
  const s = spinners.get(`build:${event.planId}`);
  if (s) s.text = `${chalk.cyan(event.planId)} — running tests...`;
  break;
}

case 'build:test:complete': {
  const s = spinners.get(`build:${event.planId}`);
  const passedText = chalk.green(`${event.passed} passed`);
  const failedText = event.failed > 0 ? chalk.red(`, ${event.failed} failed`) : '';
  const fixedText = event.testBugsFixed > 0 ? chalk.yellow(`, ${event.testBugsFixed} test bugs fixed`) : '';
  const issuesText = event.productionIssues.length > 0 ? chalk.red(`, ${event.productionIssues.length} production issue(s)`) : '';
  if (s) s.text = `${chalk.cyan(event.planId)} — tests: ${passedText}${failedText}${fixedText}${issuesText}`;
  break;
}
```

### `src/monitor/ui/src/lib/types.ts`

Update `PipelineStage` (line 18):
```typescript
export type PipelineStage = 'plan' | 'implement' | 'doc-update' | 'test' | 'review' | 'evaluate' | 'complete' | 'failed';
```

### `src/monitor/ui/src/lib/reducer.ts`

In `processEvent()`, add handling inside the planId switch block (after the `build:doc-update:*` no-op cases around line 139):

```typescript
case 'build:test:write:start':
case 'build:test:start':
  state.planStatuses[planId] = 'test';
  break;
case 'build:test:write:complete':
case 'build:test:complete':
  // Don't advance stage — next stage (review/evaluate) will set it
  break;
```

Also update the existing `build:implement:complete` case. Currently it falls through to `'review'`:
```typescript
case 'build:implement:complete':
case 'build:review:start':
  state.planStatuses[planId] = 'review';
```
Split this so `build:implement:complete` no longer assumes review follows immediately (test stages may run first):
```typescript
case 'build:implement:complete':
  // Don't advance — next stage (test or review) will set the status
  break;
case 'build:review:start':
  state.planStatuses[planId] = 'review';
  break;
```

Add test issue accumulation after the `build:review:complete` handler (line 159):
```typescript
if (event.type === 'build:test:complete' && 'planId' in event && 'productionIssues' in event) {
  const issues = (event as { productionIssues: { severity: string; category: string; file: string; description: string }[] }).productionIssues;
  if (issues.length > 0) {
    state.reviewIssues[(event as { planId: string }).planId] = issues.map((i) => ({
      severity: i.severity as 'critical' | 'warning' | 'suggestion',
      category: i.category,
      file: i.file,
      description: i.description,
    }));
  }
}
```

### `src/monitor/ui/src/components/timeline/event-card.tsx`

Add cases to `eventSummary()` (after the `build:doc-update:complete` case around line 56):
```typescript
case 'build:test:write:start': return `Writing tests: ${event.planId}`;
case 'build:test:write:complete': return `[${event.planId}] ${event.testsWritten} test(s) written`;
case 'build:test:start': return `Running tests: ${event.planId}`;
case 'build:test:complete': return `[${event.planId}] Tests: ${event.passed} passed, ${event.failed} failed${event.productionIssues?.length ? `, ${event.productionIssues.length} production issue(s)` : ''}`;
```

Add to `eventDetail()` (after the `build:failed` case):
```typescript
case 'build:test:complete': {
  const parts: string[] = [];
  parts.push(`Passed: ${event.passed}, Failed: ${event.failed}`);
  if (event.testBugsFixed > 0) parts.push(`Test bugs fixed: ${event.testBugsFixed}`);
  if (event.productionIssues?.length) {
    parts.push('Production issues:');
    for (const issue of event.productionIssues) {
      parts.push(`  [${issue.severity}] ${issue.category} — ${issue.file}\n    ${issue.description}`);
    }
  }
  return parts.join('\n');
}
```

### `test/tester-wiring.test.ts`

Test file following `agent-wiring.test.ts` patterns:

```typescript
import { describe, it, expect } from 'vitest';
import { StubBackend } from './stub-backend.js';
import { collectEvents, findEvent, filterEvents } from './test-events.js';
import { runTestWriter } from '../src/engine/agents/tester.js';
import { runTester } from '../src/engine/agents/tester.js';
import { parseTestIssues, testIssueToReviewIssue } from '../src/engine/agents/common.js';
```

**Test cases for `parseTestIssues()`:**

1. **Parses well-formed XML**: Input with `<test-issues>` block containing 2 issues. Assert returns array of 2 `TestIssue` objects with all fields populated.
2. **Returns empty array for no block**: Input without `<test-issues>`. Assert returns `[]`.
3. **Handles malformed XML gracefully**: Incomplete XML, missing attributes. Assert returns empty or partial array, never throws.
4. **Parses optional `<fix>` and `<test-output>` children**: Issue with both optional children present, issue with neither. Assert fields are populated or undefined accordingly.

**Test cases for `testIssueToReviewIssue()`:**

5. **Converts TestIssue to ReviewIssue**: Input TestIssue with all fields. Assert output ReviewIssue has severity, category, file, description, fix. Assert `testFile` and `testOutput` are dropped.

**Test cases for `runTestWriter()`:**

6. **Yields start/complete lifecycle events**: StubBackend returns `<test-write-summary count="3">`. Assert `build:test:write:start` and `build:test:write:complete` events present. Assert `testsWritten` is 3.
7. **Defaults testsWritten to 0 on missing summary**: StubBackend returns text without summary block. Assert `build:test:write:complete` with `testsWritten: 0`.
8. **Is non-fatal on error**: StubBackend throws a non-abort error. Assert `build:test:write:complete` event is still yielded.

**Test cases for `runTester()`:**

9. **Yields start/complete lifecycle with parsed issues**: StubBackend returns XML with `<test-issues>` and `<test-summary>`. Assert events contain correct counts and parsed issues.
10. **Handles empty test issues**: StubBackend returns `<test-issues></test-issues>` and `<test-summary passed="5" failed="0" test_bugs_fixed="0">`. Assert `productionIssues` is empty array.
11. **Is non-fatal on error**: StubBackend throws. Assert `build:test:complete` event with zeroed counts.

**Test cases for pipeline integration (verification scope):**

12. **`hasTestStages` returns true when build includes test-cycle**: Verify the detection logic inline (import and test the helper if exported, otherwise test indirectly).
13. **`hasTestStages` returns false when build has no test stages**: Verify with standard `[implement, review-cycle]`.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` produces `dist/cli.js` without errors
- [ ] `pnpm test` — all tests pass including new `test/tester-wiring.test.ts`
- [ ] `test/tester-wiring.test.ts` contains tests for: `parseTestIssues` (4 cases), `testIssueToReviewIssue` (1 case), `runTestWriter` (3 cases), `runTester` (3 cases), verification scope detection (2 cases)
- [ ] `renderEvent()` in `display.ts` handles all four new event types without falling through to the `never` default case
- [ ] Monitor UI `PipelineStage` type includes `'test'`
- [ ] Monitor reducer updates `planStatuses` to `'test'` on `build:test:start` events
