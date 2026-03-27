---
id: plan-02-tests
name: Tests for planner continuation and builder max turns reduction
dependsOn:
  - plan-01-source-changes
branch: builder-max-turns-reduction-and-planner-continuation-handoff/tests
---

# Tests for planner continuation and builder max turns reduction

## Architecture Context

This plan adds tests for the planner continuation mechanism and updates existing tests that assert builder maxTurns of 75. All source changes are already in place from plan-01. Tests follow existing patterns in `test/continuation.test.ts` and `test/pipeline.test.ts`.

## Implementation

### Overview

Add new test cases and update existing assertions across two test files. Tests follow the established patterns: `StubBackend` for agent wiring, `collectEvents`/`findEvent`/`filterEvents` from `test/test-events.ts`, and `useTempDir` for filesystem tests.

### Key Decisions

1. **New tests go in `test/planner-continuation.test.ts`** - a dedicated file following the "group by what's tested" convention, since planner continuation is a distinct logical unit from builder continuation.

2. **Existing builder maxTurns tests in `test/pipeline.test.ts` are updated in place** - three assertions change from 75 to 50.

3. **Agent wiring tests verify prompt injection** - following the builder continuation test pattern in `test/continuation.test.ts`, test that `runPlanner` with `continuationContext` injects "Continuation Context" into the prompt, and without it the prompt does not contain that section.

4. **Type-check test verifies `plan:continuation` compiles as `EforgeEvent`** - same pattern as the existing `build:implement:continuation` type-check test.

## Scope

### In Scope
- New `test/planner-continuation.test.ts` with agent-level and type-check tests
- Updating 3 existing assertions in `test/pipeline.test.ts` from 75 to 50
- Testing `runPlanner` with and without `continuationContext`
- Testing `plan:continuation` event type compilation
- Testing `error_max_turns` propagation from `runPlanner`

### Out of Scope
- Integration-level pipeline continuation loop tests (those would require mocking the full pipeline context)
- Changing any source files

## Files

### Create
- `test/planner-continuation.test.ts` - New test file with these test groups:
  - **`runPlanner with continuation context`**: Pass `continuationContext` with attempt/maxContinuations/existingPlans to `runPlanner`, assert `backend.prompts[0]` contains "Continuation Context", the attempt number, and "Do NOT redo"
  - **`runPlanner without continuation context`**: Normal planner call, assert prompt does NOT contain "Continuation Context"
  - **`plan:continuation event type`**: Type-check that `{ type: 'plan:continuation', attempt: 1, maxContinuations: 2 }` satisfies `EforgeEvent` (same pattern as existing `build:implement:continuation` test)
  - **`Continuation context coexists with prior clarifications`**: Provide both `continuationContext` and trigger a clarification restart, verify both "Continuation Context" and prior clarification sections appear in the prompt
  - **`StubBackend error_max_turns propagation`**: When StubBackend throws `error_max_turns`, verify `runPlanner` propagates the error (it does not handle retries - the pipeline stage does)
  - **`resolveAgentConfig for builder is 50`**: Assert `resolveAgentConfig('builder', DEFAULT_CONFIG).maxTurns === 50`
  - **`resolveAgentConfig for planner is 30`**: Assert `resolveAgentConfig('planner', DEFAULT_CONFIG).maxTurns === 30` (planner uses global default, no role-specific override)

### Modify
- `test/pipeline.test.ts` - Update 3 assertions:
  1. Line 373: `expect(result.maxTurns).toBe(75)` -> `expect(result.maxTurns).toBe(50)` (with updated comment)
  2. Line 381: `expect(result.maxTurns).toBe(75)` -> `expect(result.maxTurns).toBe(50)`
  3. Line 390: `expect(result.maxTurns).toBe(75)` -> `expect(result.maxTurns).toBe(50)` (with updated comment on line 387)

## Verification

- [ ] `pnpm test` passes all tests including existing ones
- [ ] `test/planner-continuation.test.ts` contains at least 7 test cases
- [ ] `test/pipeline.test.ts` has no remaining assertions of builder maxTurns === 75
- [ ] All test imports resolve without errors
- [ ] `pnpm type-check` passes (no type errors in test files)
