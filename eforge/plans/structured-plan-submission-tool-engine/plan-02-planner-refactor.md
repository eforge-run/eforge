---
id: plan-02-planner-refactor
name: Planner Agent Submission Tool Integration
depends_on:
  - plan-01-foundation
branch: structured-plan-submission-tool-engine/planner-refactor
---

# Planner Agent Submission Tool Integration

## Architecture Context

Plan-01 added the `CustomTool` interface, submission schemas, plan writer functions, and backend custom tool forwarding. This plan wires them into the planner agent so it uses `submit_plan_set` / `submit_architecture` instead of N Write calls, and replaces the disk-scan fallback with explicit error handling.

The planner agent (`packages/engine/src/agents/planner.ts`) currently:
1. Runs the agent with a prompt that instructs it to Write plan files
2. After the agent finishes, scans the plan directory for `.md` files (lines 185-209)
3. If no files found and no `<skip>` emitted, yields `plan:skip` with "No plans generated"

After this plan:
1. The planner injects `submit_plan_set` or `submit_architecture` as a custom tool
2. The handler captures the validated payload in a closure variable
3. After the agent finishes, the planner reads the captured payload (not the disk)
4. If neither `<skip>` nor submission fired, the planner yields `plan:error` (not `plan:skip`)
5. The engine writes files from the validated payload via `writePlanSet`/`writeArchitecture`

## Implementation

### Overview

Refactor `runPlanner()` in `planner.ts` to create submission tools, inject them via `customTools`, capture results, and use the new plan writers. Rewrite `planner.md` to instruct the agent to call the submission tool instead of using Write.

### Key Decisions

1. **One tool per mode, injected per run.** For errand/excursion, inject `submit_plan_set`. For expedition, inject `submit_architecture`. The planner knows the mode from `options.scope`. If scope is unknown (no pipeline composer), inject both tools and let the agent choose.

2. **Handler captures payload into a closure variable.** The `runPlanner` function creates a `let submissionPayload: PlanSetSubmission | ArchitectureSubmission | null = null` variable. The handler sets it. After `backend.run()` completes, the planner checks this variable.

3. **Emit `plan:submission` event when tool fires.** The handler yields a `plan:submission` event with redacted metadata (plan count, body sizes) before returning success to the agent. This provides diagnostics in the monitor.

4. **Replace implicit `plan:skip` with `plan:error`.** Lines 205-208 currently emit `plan:skip` when no plans are found. Replace with `plan:error` and a descriptive reason: "Planner agent completed without calling submit_plan_set or emitting <skip>". The engine's compile flow treats `plan:error` as a failure (non-zero exit).

5. **Remove the disk-scan fallback entirely.** Lines 185-209 are replaced with a check on the closure variable. The planner no longer reads the plan directory.

6. **Prompt rewrite preserves plan body format.** The markdown template for plan body content stays in the prompt - it describes the shape of the `body` string field, not instructions to write files. The "Output" section is rewritten to say "call `submit_plan_set` once" instead of "write files".

## Scope

### In Scope

- Refactor `runPlanner()` in `agents/planner.ts`
- Create submission tool factory functions (one for plan sets, one for architecture)
- Rewrite "Output" and "Phase 3: Plan Generation" sections of `prompts/planner.md`
- Add imperative paragraph about submission being the only way to complete
- Integration test using `StubBackend` that simulates a submission tool call
- Emit `plan:submission` event when tool fires
- Emit `plan:error` when neither skip nor submission occurs

### Out of Scope

- Module planner agents (separate follow-up)
- Reviewer/evaluator/tester agents
- The `<skip>` XML block mechanism (unchanged)
- Clarification flow (unchanged)
- Continuation logic (unchanged - continuation context still works, just the final scan is replaced)

## Files

### Modify

- `packages/engine/src/agents/planner.ts` - Major refactor:
  - Add import for `CustomTool` from backend.ts, submission schemas from schemas.ts, `writePlanSet`/`writeArchitecture` from plan.ts
  - Before the agent loop, create submission tools using a factory that captures payload into a closure variable
  - Pass `customTools` to `backend.run()` options
  - After the agent loop (line 181 onward), replace the disk-scan block (lines 185-209) with: check captured payload, if present call `writePlanSet`/`writeArchitecture`, yield `plan:submission` event, yield `plan:complete` with the written plans. If no payload and no skip, yield `plan:error`.
  - The `plan:error` event replaces the implicit `plan:skip` at line 207
  
- `packages/engine/src/prompts/planner.md` - Rewrite plan generation instructions:
  - In "Phase 3: Plan Generation" errand/excursion section (lines 110-123): replace "Create 1 or more plan files in `{{outputDir}}/{{planSetName}}/`" and "Then generate `{{outputDir}}/{{planSetName}}/orchestration.yaml`" with instructions to call `submit_plan_set` once with the full payload
  - In expedition section (lines 125-177): replace "Write `{{outputDir}}/{{planSetName}}/architecture.md`" and "Write `{{outputDir}}/{{planSetName}}/index.yaml`" with instructions to call `submit_architecture` once
  - In "Output" section (lines 472-476): add imperative paragraph: "Your only way to complete this turn is to call `submit_plan_set` (or `submit_architecture` for expeditions). Rendering plans as chat output does not count - the files are written from your tool call."
  - Keep the markdown format examples as the shape of `plans[].body` string content
  - Keep all schema references, quality criteria, and vague criteria patterns unchanged

### Create

- `test/planner-submission.test.ts` - Integration test using `StubBackend`:
  - Test: StubBackend emits a `submit_plan_set` tool call with valid payload -> planner writes expected files via `writePlanSet` and yields `plan:complete`
  - Test: StubBackend emits no tool call and no `<skip>` -> planner yields `plan:error`
  - Test: StubBackend emits `<skip>` block -> planner yields `plan:skip` (existing behavior preserved)
  - Test: StubBackend emits `submit_architecture` tool call -> planner writes architecture files and yields expedition events
  - Test: `plan:submission` event is yielded with plan count and body size metadata

## Verification

- [ ] `runPlanner()` passes `customTools` array to `backend.run()` containing at least one submission tool
- [ ] When `StubBackend` simulates a `submit_plan_set` tool call, `runPlanner()` yields `plan:complete` with plans matching the submission payload
- [ ] When `StubBackend` completes without a submission tool call or `<skip>`, `runPlanner()` yields an event with `type: 'plan:error'` and a reason string containing "submit_plan_set"
- [ ] `plan:skip` still emitted when `<skip>` XML block is present (existing behavior unchanged)
- [ ] `plan:submission` event is yielded when the submission tool handler executes, with `planCount` matching the number of plans submitted
- [ ] `planner.md` contains the phrase "call `submit_plan_set`" and does NOT contain instructions to use the Write tool for plan files
- [ ] `planner.md` contains the imperative paragraph about submission being the only completion mechanism
- [ ] The disk-scan block (readdir + parsePlanFile loop) is removed from `planner.ts`
- [ ] Written plan files from `writePlanSet` have YAML frontmatter with `id`, `name`, `depends_on`, `branch` fields followed by the body content
- [ ] `pnpm build && pnpm type-check && pnpm test` pass
