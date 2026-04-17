---
id: plan-02-runtime-override-events
name: Runtime Per-Plan Override + Clamping + Event Enrichment + Planner Prompt
depends_on:
  - plan-01-schema-capabilities
branch: opus-4-7-support-planner-driven-per-plan-effort-thinking/runtime-override-events
---

# Runtime Per-Plan Override + Clamping + Event Enrichment + Planner Prompt

## Architecture Context

This plan builds on the widened schema and model-capability map from Plan 1 to wire per-plan effort/thinking overrides through the full engine pipeline. The planner gains the ability to assess plan complexity and emit per-agent tuning in plan frontmatter. `resolveAgentConfig` gains a new precedence tier (planner override) and model-capability clamping. Both backends emit enriched `agent:start` events so the monitor UI (Plan 3) can display runtime decisions.

## Implementation

### Overview

Four interconnected changes:
1. **Schema + parsing**: Add `agentTuningSchema` and optional `agents` field to `planFileFrontmatterSchema` and `planSetSubmissionPlanSchema`. Update `parsePlanFile` and `parseOrchestrationConfig` to read and validate the `agents` block. Propagate through `PlanFile` and `OrchestrationConfig` event types.
2. **resolveAgentConfig**: Add optional `planEntry` parameter. Insert planner override as highest-priority tier for `effort`/`thinking`. Apply `clampEffort()` after resolution. Record `effortClamped`, `effortOriginal`, `effortSource` on `ResolvedAgentConfig`. Update Group A call sites (7 per-plan build-stage agents) to pass the plan entry. Groups B and C pass `undefined`.
3. **Event enrichment**: Extend `agent:start` event type and `AgentRunOptions` with `effort`, `thinking`, `effortClamped`, `effortOriginal`, `effortSource`. Both backends read these from options and include in `agent:start` emission.
4. **Planner prompt**: Add model-agnostic complexity assessment instructions to `planner.md`.

### Key Decisions

1. **Precedence order**: `planEntry override -> user per-role -> user global -> built-in per-role -> built-in global`. The planner's assessment wins because it has the most signal about each plan's complexity. Users can still override by editing the plan frontmatter before building.
2. **Clamping applies after full resolution** - not at any intermediate tier. This means the final resolved value is always valid for the target model, regardless of where it came from.
3. **`effortSource` tracks provenance**: `'planner'` when from plan frontmatter, `'role-config'` when from per-role config, `'global-config'` when from global config, `'default'` when from built-in defaults or unset. This powers the monitor UI source badge.
4. **Group A call sites share `planEntry` via `ctx.orchConfig.plans.find()`** - the existing pattern at pipeline.ts:1343 already does this lookup for `maxContinuations`; we extend it to also extract `agents`.
5. **Malformed `agents` block in frontmatter logs a warning and is dropped** - does not block the build. This makes the feature gracefully degradable.
6. **`AgentRunOptions` gains the new fields as non-SDK keys** - they're added to `NON_SDK_KEYS` in `pickSdkOptions` so they don't get forwarded to the Claude SDK or Pi SDK, only used for event emission.
7. **Seven roles in the agents tuning block**: builder, reviewer, review-fixer, evaluator, doc-updater, test-writer, tester. These correspond exactly to the Group A per-plan build-stage agents.
8. **Planner prompt stays model-agnostic** - no mention of Opus, Sonnet, Haiku, or version numbers. Assessment instructions use the full enum and note that the engine clamps to what the selected model supports.

## Scope

### In Scope
- `agentTuningSchema` definition: `z.object({ effort, thinking, rationale })` all optional
- `agents` field on `planFileFrontmatterSchema` and `planSetSubmissionPlanSchema` for 7 roles
- `parsePlanFile` reading and validating `agents` from frontmatter with graceful fallback on malformed data
- `parseOrchestrationConfig` propagating `agents` through plan entries
- `PlanFile` and `OrchestrationConfig` plan entry types gaining `agents` field
- `ResolvedAgentConfig` gaining `effortClamped`, `effortOriginal`, `effortSource` fields
- `AgentRunOptions` gaining `effortClamped`, `effortOriginal`, `effortSource` fields (non-SDK)
- `resolveAgentConfig` gaining optional `planEntry` parameter with precedence logic and clamping
- 7 Group A call sites in pipeline.ts passing plan entry with agents block
- Groups B (10 compile-time) and C (7 run-level) call sites unchanged (parameter is optional, defaults to undefined)
- `agent:start` event type gaining `effort`, `thinking`, `effortClamped`, `effortOriginal`, `effortSource`
- Both backends enriching `agent:start` emission from `AgentRunOptions`
- Planner prompt additions for model-agnostic complexity assessment
- Tests in `test/agent-wiring.test.ts` and `test/plan-parsing.test.ts`

### Out of Scope
- `AGENT_ROLE_DEFAULTS` - built-in defaults stay empty for effort/thinking
- Backend profile YAMLs under `eforge/backends/`
- Monitor UI rendering (Plan 3)
- CHANGELOG

## Files

### Modify
- `packages/engine/src/schemas.ts` (line 156) - Define `agentTuningSchema = z.object({ effort: effortLevelSchema.optional(), thinking: thinkingConfigSchema.optional(), rationale: z.string().optional() })`. Add optional `agents` field to `planFileFrontmatterSchema` as `z.object({ builder, reviewer, 'review-fixer', evaluator, 'doc-updater', 'test-writer', tester })` where each value is `agentTuningSchema.optional()`. Add same `agents` field to `planSetSubmissionPlanSchema.frontmatter`.
- `packages/engine/src/events.ts` (line 43) - Add `agents?: Record<string, { effort?: string; thinking?: object; rationale?: string }>` to `PlanFile` interface. (line 53) Add same field to `OrchestrationConfig.plans` array entry type. (line 230) Extend `agent:start` event with `effort?: string`, `thinking?: object`, `effortClamped?: boolean`, `effortOriginal?: string`, `effortSource?: 'planner' | 'role-config' | 'global-config' | 'default'`.
- `packages/engine/src/plan.ts` (lines 135-163, `parsePlanFile`) - After extracting existing frontmatter fields, attempt to parse `frontmatter.agents` through `agentTuningSchema`-based validation. On success, attach to returned `PlanFile`. On validation failure, log a warning and omit (do not throw). (lines 168-224, `parseOrchestrationConfig`) - In the plan entry mapping, propagate `agents` from the parsed plan entry data.
- `packages/engine/src/config.ts` (line 233) - Add `effortClamped?: boolean`, `effortOriginal?: EffortLevel`, `effortSource?: 'planner' | 'role-config' | 'global-config' | 'default'` to `ResolvedAgentConfig`.
- `packages/engine/src/backend.ts` (line 77) - Add `effortClamped?: boolean`, `effortOriginal?: EffortLevel`, `effortSource?: string` to `AgentRunOptions`. (line 39) Add `'effortClamped'`, `'effortOriginal'`, `'effortSource'` to `NON_SDK_KEYS` set.
- `packages/engine/src/pipeline.ts` (line 492) - Add optional fourth parameter `planEntry?: { agents?: Record<string, { effort?: EffortLevel; thinking?: ThinkingConfig; rationale?: string }> }` to `resolveAgentConfig`. Before the existing SDK_FIELDS loop, check `planEntry?.agents?.[role]?.effort` and `planEntry?.agents?.[role]?.thinking` as highest-priority overrides. After resolving effort, call `clampEffort(result.model?.id ?? '', result.effort)` and set `result.effortClamped`, `result.effortOriginal`, and `result.effortSource` on the returned config. Update 7 Group A call sites (lines 1340, 1478, 1530, 1603, 1687, 1731, 1783) to pass the plan entry: use existing `ctx.orchConfig.plans.find((p) => p.id === ctx.planId)` pattern (already present at 1343) and pass it as the new fourth argument.
- `packages/engine/src/backends/claude-sdk.ts` (line 48) - Extend `agent:start` event emission to include `effort: options.effort`, `thinking: options.thinking`, `effortClamped: options.effortClamped`, `effortOriginal: options.effortOriginal`, `effortSource: options.effortSource` (only when defined, using conditional spread pattern already used for `fallbackFrom`).
- `packages/engine/src/backends/pi.ts` (line 259) - Same enrichment to `agent:start` event emission. Also enrich the two early-return `agent:start` emissions at lines 246 and 252.
- `packages/engine/src/prompts/planner.md` (after line 242) - Add a new subsection under "Plan File Format" titled "### Per-Plan Agent Tuning (Optional)". Content: model-agnostic instructions explaining the optional `agents` frontmatter block, when to use it (plans notably harder or easier than typical), which roles to tune (builder, reviewer, review-fixer, evaluator, doc-updater, test-writer, tester), the full effort enum (`low`, `medium`, `high`, `xhigh`, `max`), and that the engine clamps to what the selected model supports. Include a brief frontmatter example showing the `agents` block. No model-specific names.
- `test/agent-wiring.test.ts` - Add new `describe('resolveAgentConfig per-plan override')` block with tests: planEntry override wins over per-role config for effort; missing planEntry falls back to current behavior; `'xhigh'` and `'max'` flow through to StubBackend options verbatim on claude-sdk when model supports them; clamping reflects in resolved config.
- `test/plan-parsing.test.ts` - Add tests: `parsePlanFile` round-trips frontmatter with valid `agents` block; malformed `agents` block is dropped (no throw, agents field is undefined); `parseOrchestrationConfig` propagates `agents` from plan data.

## Verification

- [ ] `pnpm type-check` passes with all new fields on `ResolvedAgentConfig`, `AgentRunOptions`, `PlanFile`, `OrchestrationConfig`, and `agent:start` event
- [ ] `test/agent-wiring.test.ts` passes: `resolveAgentConfig('builder', config, 'claude-sdk', { agents: { builder: { effort: 'xhigh' } } })` returns `effort: 'xhigh'` overriding a per-role `effort: 'high'`
- [ ] `test/agent-wiring.test.ts` passes: `resolveAgentConfig('builder', config, 'claude-sdk')` (no planEntry) returns same result as before this change
- [ ] `test/agent-wiring.test.ts` passes: resolved config for a Sonnet model with planEntry `effort: 'max'` has `effortClamped: true` and `effort: 'xhigh'`
- [ ] `test/plan-parsing.test.ts` passes: plan file with `agents: { builder: { effort: xhigh, rationale: 'complex refactor' } }` in frontmatter parses to `PlanFile` with `agents.builder.effort === 'xhigh'`
- [ ] `test/plan-parsing.test.ts` passes: plan file with malformed `agents: { builder: { effort: 'invalid' } }` parses without throwing and returns `agents` as undefined
- [ ] Planner prompt contains no model-specific names (Opus, Sonnet, Haiku, version numbers)
- [ ] `agent:start` event type includes `effort`, `thinking`, `effortClamped`, `effortOriginal`, `effortSource`
- [ ] All 24 non-test `resolveAgentConfig` call sites compile without error (7 Group A pass planEntry, 10 Group B and 7 Group C pass 3 args)
- [ ] `pnpm build` compiles with no errors
- [ ] `pnpm test` passes all existing and new tests