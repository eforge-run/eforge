---
id: plan-01-deduplicate-shared-patterns
name: Deduplicate Repeated Patterns Across Engine and Tests
depends_on: []
branch: errand-deduplicate-repeated-patterns-across-engine-tests/deduplicate-shared-patterns
---

# Deduplicate Repeated Patterns Across Engine and Tests

## Architecture Context

The codebase has four independent duplication targets that have each crossed the 3-file threshold. All four are mechanical extractions - pull repeated code into a canonical location, replace inline definitions with imports. No behavioral changes.

## Implementation

### Overview

Extract four duplicated patterns into shared modules:
1. `SEVERITY_ORDER` map from 3 engine files into `src/engine/events.ts`
2. Filter-count-colorize pattern from 3 blocks in `src/cli/display.ts` into a private helper
3. `collectEvents()` / `findEvent()` / `filterEvents()` from 14 test files into `test/test-events.ts`
4. `makeTempDir()` + cleanup boilerplate from 7 test files into `test/test-tmpdir.ts`

### Key Decisions

1. `SEVERITY_ORDER` goes in `src/engine/events.ts` next to `ReviewIssue` because it's a direct derivative of that type's `severity` union - co-locating keeps them in sync.
2. `formatIssueSummary()` stays private (not exported) in `display.ts` because it's CLI-specific formatting, not a shared utility.
3. `useTempDir()` returns a getter function and registers its own `afterEach` cleanup - callers just call `const getTmpDir = useTempDir('eforge-test-')` at describe scope and use `getTmpDir()` to create directories. This eliminates both the array tracking and the cleanup hook from each test file.
4. Test files that only use a subset of the event helpers (e.g., `collectEvents` + `findEvent` but not `filterEvents`) still import from the shared module - unused exports are tree-shaken by the test runner.

## Scope

### In Scope
- Extract `SEVERITY_ORDER` to `src/engine/events.ts`, remove from `pipeline.ts`, `review-fixer.ts`, `parallel-reviewer.ts`
- Extract `formatIssueSummary()` as private helper in `display.ts`, replace 3 inline blocks
- Create `test/test-events.ts` with `collectEvents`, `findEvent`, `filterEvents` - update 14 test files
- Create `test/test-tmpdir.ts` with `useTempDir()` factory - update 7 test files (8 instances including `adopt.test.ts` which has 2)

### Out of Scope
- `collectEventsAndResult()` in `formatter-agent.test.ts` - unique variant, stays inline
- `asyncIterableFrom()` in `hooks.test.ts`, `sdk-mapping.test.ts`, `sdk-event-mapping.test.ts` - different helper, not part of this extraction
- Any behavioral changes

## Files

### Create
- `test/test-events.ts` - shared `collectEvents()`, `findEvent()`, `filterEvents()` helpers for test files
- `test/test-tmpdir.ts` - shared `useTempDir()` factory that registers `afterEach` cleanup

### Modify
- `src/engine/events.ts` - add `export const SEVERITY_ORDER: Record<ReviewIssue['severity'], number>` next to the `ReviewIssue` interface
- `src/engine/pipeline.ts` - remove local `SEVERITY_ORDER` definition (~line 248-252), add import from `./events.js`
- `src/engine/agents/review-fixer.ts` - remove local `SEVERITY_ORDER` inside `formatIssuesForPrompt()` (~line 30-34), add import from `../events.js`
- `src/engine/agents/parallel-reviewer.ts` - remove local `SEVERITY_ORDER` inside `deduplicateIssues()` (~line 194-198), add import from `../events.js`
- `src/cli/display.ts` - add private `formatIssueSummary(issues: ReviewIssue[]): string` helper, replace 3 inline filter-count-colorize blocks (~lines 161-168, 198-205, 259-266) with calls to it
- `test/staleness-assessor.test.ts` - remove inline `collectEvents`/`findEvent`/`filterEvents`, import from `./test-events.js`
- `test/formatter-agent.test.ts` - remove inline `collectEvents`/`findEvent`/`filterEvents`, import from `./test-events.js` (keep `collectEventsAndResult` inline)
- `test/dynamic-profile-generation.test.ts` - remove inline event helpers + temp dir boilerplate, import from shared modules
- `test/merge-conflict-resolver.test.ts` - remove inline event helpers, import from `./test-events.js`
- `test/agent-wiring.test.ts` - remove inline event helpers + temp dir boilerplate, import from shared modules
- `test/parallel-reviewer.test.ts` - remove inline event helpers, import from `./test-events.js`
- `test/assessor-wiring.test.ts` - remove inline event helpers, import from `./test-events.js`
- `test/cohesion-review.test.ts` - remove inline event helpers, import from `./test-events.js`
- `test/validation-fixer.test.ts` - remove inline event helpers, import from `./test-events.js`
- `test/watch-queue.test.ts` - remove inline `collectEvents`/`findEvent`, import from `./test-events.js`
- `test/doc-updater-wiring.test.ts` - remove inline `collectEvents`/`findEvent`, import from `./test-events.js`
- `test/hooks.test.ts` - remove inline `collectEvents`, import from `./test-events.js`
- `test/sdk-mapping.test.ts` - remove inline `collectEvents`, import from `./test-events.js`
- `test/sdk-event-mapping.test.ts` - remove inline `collectEvents`, import from `./test-events.js`
- `test/plan-parsing.test.ts` - remove temp dir boilerplate, import `useTempDir` from `./test-tmpdir.js`
- `test/adopt.test.ts` - remove 2 instances of temp dir boilerplate, import `useTempDir` from `./test-tmpdir.js`
- `test/prd-queue-enqueue.test.ts` - remove temp dir boilerplate, import `useTempDir` from `./test-tmpdir.js`
- `test/prd-queue.test.ts` - remove temp dir boilerplate, import `useTempDir` from `./test-tmpdir.js`
- `test/state.test.ts` - remove temp dir boilerplate, import `useTempDir` from `./test-tmpdir.js`

## Implementation Details

### 1. SEVERITY_ORDER in events.ts

Add after the `ReviewIssue` interface:

```typescript
export const SEVERITY_ORDER: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
};
```

Each consuming file already imports from `events.js` - just add `SEVERITY_ORDER` to the existing import.

### 2. formatIssueSummary() in display.ts

```typescript
function formatIssueSummary(issues: ReviewIssue[]): string {
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const suggestions = issues.filter((i) => i.severity === 'suggestion').length;
  const parts: string[] = [];
  if (critical > 0) parts.push(chalk.red(`${critical} critical`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning`));
  if (suggestions > 0) parts.push(chalk.blue(`${suggestions} suggestion`));
  return parts.join(', ');
}
```

Replace each inline block with a call like `const summary = formatIssueSummary(planIssues);` and use the result where the parts array was joined.

### 3. test/test-events.ts

```typescript
import type { EforgeEvent } from '../src/engine/events.js';

export async function collectEvents(gen: AsyncIterable<EforgeEvent>): Promise<EforgeEvent[]> {
  const events: EforgeEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

export function findEvent<T extends EforgeEvent['type']>(
  events: EforgeEvent[],
  type: T,
): Extract<EforgeEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<EforgeEvent, { type: T }> => e.type === type);
}

export function filterEvents<T extends EforgeEvent['type']>(
  events: EforgeEvent[],
  type: T,
): Extract<EforgeEvent, { type: T }>[] {
  return events.filter((e): e is Extract<EforgeEvent, { type: T }> => e.type === type);
}
```

### 4. test/test-tmpdir.ts

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

export function useTempDir(prefix = 'eforge-test-'): () => string {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
```

Consuming test files replace their boilerplate with:
```typescript
import { useTempDir } from './test-tmpdir.js';

const makeTempDir = useTempDir('eforge-{context}-');
```

The `afterEach` block and `tempDirs` array are removed entirely - `useTempDir` handles cleanup internally.

## Verification

- [ ] `SEVERITY_ORDER` is defined exactly once in `src/engine/events.ts` - grep finds 1 definition, 0 local definitions in `pipeline.ts`, `review-fixer.ts`, or `parallel-reviewer.ts`
- [ ] `formatIssueSummary` exists in `display.ts` and the three inline filter-count-colorize blocks (filter by severity + push to parts array) are gone - only 1 filter-count pattern remains (inside the helper itself)
- [ ] `test/test-events.ts` exports `collectEvents`, `findEvent`, `filterEvents` - grep finds 0 inline definitions of these functions in test files (excluding the shared module itself)
- [ ] `test/test-tmpdir.ts` exports `useTempDir` - grep finds 0 `const tempDirs: string[]` patterns in test files
- [ ] `formatter-agent.test.ts` still contains `collectEventsAndResult` defined inline
- [ ] `pnpm type-check` exits 0
- [ ] `pnpm test` exits 0
