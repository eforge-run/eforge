---
id: plan-01-foundation
name: Submission Tool Foundation
depends_on: []
branch: structured-plan-submission-tool-engine/foundation
---

# Submission Tool Foundation

## Architecture Context

The planner agent currently writes plan files by calling the Write tool N times from inside its agent loop. This plan introduces the infrastructure for a structured submission tool: schemas, backend custom tool plumbing, event types, and engine-side file writers. The planner agent refactor (plan-02) consumes these pieces.

All changes here are additive - no existing behavior changes. The `customTools` field on `AgentRunOptions` is optional, so existing callers are unaffected. New schemas, events, and writer functions are unused until plan-02 wires them.

## Implementation

### Overview

Add five pieces of infrastructure:
1. `CustomTool` type and `customTools` field on `AgentRunOptions`
2. `planSetSubmissionSchema` and `architectureSubmissionSchema` in schemas.ts
3. `plan:submission` and `plan:error` event types in events.ts
4. `writePlanSet` and `writeArchitecture` functions in plan.ts
5. Backend forwarding in both claude-sdk.ts and pi.ts

### Key Decisions

1. **CustomTool uses a handler closure pattern.** Each custom tool has a `name`, `description`, `inputSchema` (JSON Schema object), and a `handler: (input: unknown) => Promise<string>` function. The handler captures submission state via closure. This avoids adding state management to the backend interface.

2. **Schemas validate mechanical fields only.** Per the PRD's schema scope principle, `plans[].body` is `z.string()` and `architecture` is `z.string()`. Content quality is the plan-reviewer's job. The schema catches structural errors: duplicate IDs, dangling deps, cycles, orchestration-to-plans mismatch.

3. **Validation happens in the handler, not the writer.** The submission handler validates the Zod schema and dependency graph, then stores the validated payload. The writer functions (`writePlanSet`/`writeArchitecture`) receive already-validated data and focus on serialization. This separation means validation errors surface as tool results to the agent.

4. **Claude SDK backend translates CustomTool to in-memory tool format.** The SDK's `query()` options already accept tool arrays alongside presets. Custom tools are appended to the tools array. Pi backend already has a `customTools` parameter on `createAgentSession` - we map `CustomTool[]` to Pi's `AgentTool[]` format.

5. **`plan:submission` event carries a redacted shape (counts/sizes).** The event records that the tool was invoked and the payload dimensions (plan count, total body size, has migrations) without echoing the full body text into the event stream.

## Scope

### In Scope

- `CustomTool` interface and `AgentRunOptions.customTools` in `backend.ts`
- `planSetSubmissionSchema` and `architectureSubmissionSchema` in `schemas.ts`
- `getPlanSetSubmissionSchemaYaml()` and `getArchitectureSubmissionSchemaYaml()` getters
- `plan:submission` and `plan:error` event types in `events.ts`
- `writePlanSet(cwd, outputDir, planSetName, payload)` in `plan.ts`
- `writeArchitecture(cwd, outputDir, planSetName, payload)` in `plan.ts`
- Claude SDK backend: forward `customTools` to SDK tool array
- Pi backend: forward `customTools` to session `customTools`
- `StubBackend`: accept and record `customTools` from options
- Unit tests for submission schemas (duplicate IDs, dangling deps, cycles, orchestration mismatch)
- Unit tests for `writePlanSet` and `writeArchitecture` output format

### Out of Scope

- Planner agent changes (plan-02)
- Prompt changes (plan-02)
- Module planner agents
- Reviewer/evaluator/tester agents

## Files

### Modify

- `packages/engine/src/backend.ts` - Add `CustomTool` interface (name, description, inputSchema, handler) and optional `customTools?: CustomTool[]` field on `AgentRunOptions`
- `packages/engine/src/schemas.ts` - Add `planSetSubmissionSchema` and `architectureSubmissionSchema` with validation rules (unique IDs, DAG check, orchestration-to-plans match, migration timestamp format). Add `getPlanSetSubmissionSchemaYaml()` and `getArchitectureSubmissionSchemaYaml()` getters following existing pattern.
- `packages/engine/src/events.ts` - Add `plan:submission` event type (with `planCount`, `totalBodySize`, `hasMigrations` fields) and `plan:error` event type (with `reason` field) to the `EforgeEvent` union
- `packages/engine/src/plan.ts` - Add `writePlanSet()` function that takes a validated submission payload and writes plan markdown files (with YAML frontmatter) + orchestration.yaml to the plan directory. Add `writeArchitecture()` that writes architecture.md + index.yaml + creates modules/ directory. Output must match the current format produced by the planner agent's Write calls.
- `packages/engine/src/backends/claude-sdk.ts` - When `options.customTools` is defined and non-empty, convert each `CustomTool` to the SDK's in-memory tool format and include them in the `tools` option alongside the preset. The SDK `query()` function accepts `{ type: 'custom', name, description, input_schema, handler }` entries in the tools array.
- `packages/engine/src/backends/pi.ts` - When `options.customTools` is defined, convert each `CustomTool` to Pi's `AgentTool` format and merge into the `customTools` array passed to `createAgentSession` (alongside existing MCP-bridged tools)
- `test/stub-backend.ts` - Store `options.customTools` on each call so tests can assert custom tools were injected

### Create

- `test/submission-schemas.test.ts` - Unit tests for `planSetSubmissionSchema` and `architectureSubmissionSchema`: valid payloads pass, duplicate plan IDs rejected, dangling dependsOn rejected, dependency cycles rejected, orchestration plans vs submitted plans ID mismatch rejected, invalid migration timestamps rejected
- `test/plan-writers.test.ts` - Unit tests for `writePlanSet` and `writeArchitecture`: writes expected files to temp directory, YAML frontmatter matches input, orchestration.yaml structure matches expected format, architecture.md content written, index.yaml modules match input, modules/ directory created

## Verification

- [ ] `CustomTool` interface exported from `packages/engine/src/backend.ts` with fields: `name: string`, `description: string`, `inputSchema: Record<string, unknown>`, `handler: (input: unknown) => Promise<string>`
- [ ] `AgentRunOptions.customTools` is `CustomTool[] | undefined`
- [ ] `planSetSubmissionSchema.safeParse()` rejects a payload where two plans share the same `frontmatter.id` value
- [ ] `planSetSubmissionSchema.safeParse()` rejects a payload where `frontmatter.dependsOn` references a plan ID not present in the submission
- [ ] `planSetSubmissionSchema` `.superRefine()` rejects a payload with a dependency cycle (A depends on B, B depends on A)
- [ ] `planSetSubmissionSchema` `.superRefine()` rejects when `orchestration.plans[].id` set does not match `plans[].frontmatter.id` set
- [ ] `architectureSubmissionSchema` validates `architecture` as `z.string().min(1)` and `modules` as an array of `{ id, description, dependsOn }`
- [ ] `writePlanSet()` creates `{planDir}/{planId}.md` files with `---\n{yaml frontmatter}\n---\n\n{body}` format
- [ ] `writePlanSet()` creates `{planDir}/orchestration.yaml` with `name`, `description`, `base_branch`, `mode`, `validate`, `plans` fields
- [ ] `writeArchitecture()` creates `architecture.md`, `index.yaml`, and `modules/` directory
- [ ] `plan:submission` event type exists in `EforgeEvent` union with `planCount: number` and `totalBodySize: number` fields
- [ ] `plan:error` event type exists in `EforgeEvent` union with `reason: string` field
- [ ] Claude SDK backend includes custom tools in the `tools` array when `options.customTools` is non-empty
- [ ] Pi backend merges custom tools into `customTools` array when `options.customTools` is non-empty
- [ ] `pnpm build && pnpm type-check && pnpm test` pass
