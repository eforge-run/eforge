---
id: plan-01-types-and-agents
name: Tester Types, Schemas, Parsers, and Agent Implementations
depends_on: []
branch: tester-agent-separate-test-concerns-from-builder/types-and-agents
---

# Tester Types, Schemas, Parsers, and Agent Implementations

## Architecture Context

This is the foundation layer: new types, schemas, XML parser, and both agent implementations (test-writer and tester). Everything in plan-02 (pipeline stages, prompt updates) and plan-03 (UI, tests) depends on these types and agents existing first.

## Implementation

### Overview

Add `TestIssue` type and events to `events.ts`, Zod schema + YAML getter to `schemas.ts`, XML parser to `common.ts`, agent roles to `config.ts`, and both agent runners to a new `tester.ts` file. Also create the two prompt files.

### Key Decisions

1. `TestIssue` is a standalone type (not a subset of `ReviewIssue`) because test issues have `testFile` and `testOutput` fields that review issues lack, and use different categories (`production-bug`, `missing-behavior`, `regression`). A `testIssueToReviewIssue()` converter bridges the gap for the evaluate stage.
2. Both agents live in `src/engine/agents/tester.ts` following the doc-updater pattern (start event, try/catch with AbortError passthrough, complete event always yielded).
3. The tester agent parses `<test-issues>` XML from its output - same pattern as `parseEvaluationBlock()` in `common.ts`.

## Scope

### In Scope
- `TestIssue` type definition in `events.ts`
- New `EforgeEvent` variants: `build:test:write:start/complete`, `build:test:start/complete`
- `'test-writer' | 'tester'` added to `AgentRole` union
- `testIssueSchema` Zod schema and `getTestIssueSchemaYaml()` in `schemas.ts`
- `parseTestIssues()` XML parser in `common.ts`
- `testIssueToReviewIssue()` converter in `common.ts`
- `runTestWriter()` and `runTester()` async generators in `tester.ts`
- `test-writer.md` and `tester.md` prompt files
- Agent role additions in `config.ts` (`AGENT_ROLES` array)
- Default maxTurns for test-writer (30) and tester (40) in `pipeline.ts` `AGENT_MAX_TURNS_DEFAULTS`

### Out of Scope
- Pipeline stage registration (plan-02)
- Builder prompt changes (plan-02)
- Planner/module-planner prompt updates (plan-02)
- CLI display and monitor UI (plan-03)
- Tests (plan-03)

## Files

### Create
- `src/engine/agents/tester.ts` — test-writer and tester agent runners
- `src/engine/prompts/test-writer.md` — test-writer agent prompt template
- `src/engine/prompts/tester.md` — tester agent prompt template

### Modify
- `src/engine/events.ts` — add `TestIssue` type, new event variants, extend `AgentRole` union
- `src/engine/schemas.ts` — add `testIssueSchema`, `testIssueCategorySchema`, `getTestIssueSchemaYaml()`
- `src/engine/agents/common.ts` — add `parseTestIssues()` and `testIssueToReviewIssue()`
- `src/engine/config.ts` — add `'test-writer'` and `'tester'` to `AGENT_ROLES`
- `src/engine/pipeline.ts` — add `'test-writer'` and `'tester'` to `AGENT_MAX_TURNS_DEFAULTS`

## Detailed Changes

### `src/engine/events.ts`

Add to `AgentRole` union (line 10):
```typescript
export type AgentRole = '...' | 'test-writer' | 'tester';
```

Add `TestIssue` type (after `ReviewIssue` line 18):
```typescript
export interface TestIssue {
  severity: 'critical' | 'warning';
  category: 'production-bug' | 'missing-behavior' | 'regression';
  file: string;
  testFile: string;
  description: string;
  testOutput?: string;
  fix?: string;
}
```

Add to `EforgeEvent` union in the "Building (per-plan)" section (after line 164, the `build:doc-update:complete` entry):
```typescript
| { type: 'build:test:write:start'; planId: string }
| { type: 'build:test:write:complete'; planId: string; testsWritten: number }
| { type: 'build:test:start'; planId: string }
| { type: 'build:test:complete'; planId: string; passed: number; failed: number; testBugsFixed: number; productionIssues: TestIssue[] }
```

### `src/engine/schemas.ts`

Add after the `testCategorySchema` (line 57):
```typescript
const testIssueCategorySchema = z.enum([
  'production-bug', 'missing-behavior', 'regression',
]).describe('Category of test-discovered issue');

const testIssueSeveritySchema = z.enum(['critical', 'warning'])
  .describe('Test issue severity: critical = failing test, warning = missing coverage');

export const testIssueSchema = z.object({
  severity: testIssueSeveritySchema,
  category: testIssueCategorySchema,
  file: z.string().describe('Production file with the bug'),
  testFile: z.string().describe('Test file that exposed the issue'),
  description: z.string().min(1).describe('Description of the issue'),
  testOutput: z.string().optional().describe('Relevant test failure output'),
  fix: z.string().optional().describe('Description of unstaged fix applied'),
});
```

Add getter (after `getTestsReviewIssueSchemaYaml`):
```typescript
export function getTestIssueSchemaYaml(): string {
  return getSchemaYaml('test-issue', testIssueSchema);
}
```

### `src/engine/agents/common.ts`

Add `parseTestIssues()` following the `parseEvaluationBlock()` pattern. Extracts `<test-issues>` XML block, parses `<issue>` elements with attributes `severity`, `category`, `file`, `testFile`. Description is the text content, optional `<fix>` and `<test-output>` child elements.

Add `testIssueToReviewIssue()` converter:
```typescript
export function testIssueToReviewIssue(issue: TestIssue): ReviewIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    file: issue.file,
    description: issue.description,
    fix: issue.fix,
  };
}
```

### `src/engine/agents/tester.ts`

Two async generators:

**`runTestWriter(options: TestWriterOptions)`**:
- Options: `backend`, `cwd`, `planId`, `planContent`, `implementationContext?` (git diff), `verbose?`, `abortController?`, `maxTurns?`
- Yields `build:test:write:start`
- Loads `test-writer` prompt with `plan_id`, `plan_content`, `implementation_context`
- Runs backend with `tools: 'coding'`, accumulates text
- Parses `<test-write-summary count="N">` from output (same pattern as doc-updater's `parseDocUpdateSummary`)
- Yields `build:test:write:complete` with `testsWritten` count
- Non-fatal: catches errors except AbortError

**`runTester(options: TesterOptions)`**:
- Options: `backend`, `cwd`, `planId`, `planContent`, `verbose?`, `abortController?`, `maxTurns?`
- Yields `build:test:start`
- Loads `tester` prompt with `plan_id`, `plan_content`, `test_issue_schema`
- Runs backend with `tools: 'coding'`, accumulates text
- Parses `<test-issues>` XML via `parseTestIssues()`
- Parses `<test-summary passed="N" failed="N" test_bugs_fixed="N">` for counts
- Yields `build:test:complete` with parsed counts and issues
- Non-fatal: catches errors except AbortError

### `src/engine/prompts/test-writer.md`

Template variables: `{{plan_id}}`, `{{plan_content}}`, `{{implementation_context}}`

Prompt structure:
- Role: test-writer agent in a git worktree
- Context: plan ID, plan content
- Instructions: discover test infra, write tests for plan acceptance criteria, follow conventions
- If `implementation_context` is present (post-implementation mode): read the diff to understand what was built, write tests that validate the implementation
- If no `implementation_context` (TDD mode): write tests from the spec alone, tests SHOULD fail initially
- Commit tests with `git add <test-files> && git commit -m "test({{plan_id}}): add tests\n\nForged by eforge https://eforge.run"`
- Output: `<test-write-summary count="N">` at the end

### `src/engine/prompts/tester.md`

Template variables: `{{plan_id}}`, `{{plan_content}}`, `{{test_issue_schema}}`

Prompt structure:
- Role: tester agent in a git worktree
- Context: plan ID, plan content
- Instructions: run test suite, classify failures as test-bug or production-bug
- Test bugs: fix directly, re-run, commit with `git add <test-files> && git commit -m "fix({{plan_id}}): fix test issues\n\nForged by eforge https://eforge.run"`
- Production bugs: apply minimal fix to production code, do NOT stage/commit, report in `<test-issues>` XML
- If all pass: check for uncovered plan requirements, write additional tests, commit
- Output format: `<test-issues><issue severity="..." category="..." file="..." testFile="...">description<test-output>output</test-output><fix>fix description</fix></issue></test-issues>`
- Output: `<test-summary passed="N" failed="N" test_bugs_fixed="N">` at the end
- Test issue schema YAML injected via `{{test_issue_schema}}`

### `src/engine/config.ts`

Add to `AGENT_ROLES` array (line 14-20):
```typescript
export const AGENT_ROLES = [
  'planner', 'builder', 'reviewer', 'evaluator', 'module-planner',
  'plan-reviewer', 'plan-evaluator', 'architecture-reviewer', 'architecture-evaluator',
  'cohesion-reviewer', 'cohesion-evaluator',
  'validation-fixer', 'review-fixer', 'merge-conflict-resolver',
  'staleness-assessor', 'formatter', 'doc-updater',
  'test-writer', 'tester',
] as const;
```

### `src/engine/pipeline.ts`

Add to `AGENT_MAX_TURNS_DEFAULTS` (line 225-229):
```typescript
const AGENT_MAX_TURNS_DEFAULTS: Partial<Record<AgentRole, number>> = {
  builder: 75,
  'module-planner': 20,
  'doc-updater': 20,
  'test-writer': 30,
  'tester': 40,
};
```

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` produces `dist/cli.js` without errors
- [ ] `pnpm test` — all existing tests pass (no regressions)
- [ ] `src/engine/agents/tester.ts` exports `runTestWriter` and `runTester` async generators
- [ ] `src/engine/prompts/test-writer.md` and `src/engine/prompts/tester.md` exist and contain `{{plan_id}}` and `{{plan_content}}` template variables
- [ ] `parseTestIssues()` is exported from `src/engine/agents/common.ts`
- [ ] `testIssueToReviewIssue()` is exported from `src/engine/agents/common.ts`
- [ ] `TestIssue` is exported from `src/engine/events.ts`
- [ ] `getTestIssueSchemaYaml()` is exported from `src/engine/schemas.ts`
- [ ] `AGENT_ROLES` in `config.ts` includes `'test-writer'` and `'tester'`
