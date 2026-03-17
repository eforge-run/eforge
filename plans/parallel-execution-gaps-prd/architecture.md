# Parallel Execution & Profile Gaps - Architecture

## Vision and Goals

Close the gaps between the profile/orchestration infrastructure already built and the runtime behavior that should consume it. Four concrete issues surfaced during the workflow-profiles build session:

1. **Review strategy config is parsed but ignored** - users can configure review fields that silently do nothing
2. **Merge conflicts between same-wave plans abort the build** - the callback infrastructure is wired but no agent backs it
3. **No proactive mechanism to prevent merge conflicts** - cohesion reviewer detects overlaps after the fact, too late to prevent them
4. **Profile selection is static** - every PRD gets a predefined profile, no way to tailor review strategy or stages to the specific work

## Core Architectural Principles

### 1. Config flows to behavior

Every field in `ReviewProfileConfig` must have a code path that reads it and changes behavior. If a field exists in config, it works. No dead config.

### 2. Agents follow established patterns

New agents (merge-resolver) follow the same structure as existing ones (validation-fixer): options interface, async generator yielding `EforgeEvent`s, `AgentBackend` for LLM interaction, lifecycle events for monitor visibility.

### 3. Prompts are the conflict-prevention mechanism

Edit region markers are a prompt-level convention - not enforced by code, but by instructing planners and builders to respect region boundaries. This keeps the implementation lightweight and avoids brittle AST-level enforcement.

### 4. Generated profiles use existing infrastructure

Dynamic profile generation plugs into the existing `plan:profile` event's optional `config` field. The pipeline already prefers inline config over named lookup. The new work is validation and the agent/prompt that produces the config.

## Integration Contracts

### Between review-strategy-wiring and pipeline stages

`PipelineContext.profile.review` is the single source of truth for review behavior. Each build stage reads the relevant field:

- `reviewStage` reads `strategy` and `perspectives`
- The review-fix-evaluate loop reads `maxRounds` (new loop wrapper)
- `reviewFixStage` reads `autoAcceptBelow` (filters issues before passing to fixer)
- `evaluateStage` reads `evaluatorStrictness` (passes to evaluator prompt as template variable)

### Between merge-conflict-resolver and orchestrator

The merge resolver agent implements the existing `MergeResolver` callback type from `worktree.ts`. It receives `MergeConflictInfo` (extended with plan context) and returns `Promise<boolean>`. The orchestrator calls it on merge failure - no changes to the orchestrator's control flow needed.

The resolver yields events internally but the callback signature returns `boolean`. The agent runner in `eforge.ts` wraps the async generator, collects events, and returns success/failure.

### Between edit-region-markers and the planning pipeline

Region markers are a convention enforced through prompts at three levels:

1. **Planner/module-planner** - detects shared files, emits region marker instructions in plan output
2. **Builder** - respects region boundaries during implementation
3. **Cohesion reviewer** - validates regions don't overlap (extends existing overlap detection)

No new events, types, or pipeline stages needed. This is purely prompt engineering.

### Between dynamic-profile-generation and the planner

The planner (or a dedicated pre-step) generates a `ResolvedProfileConfig` and emits it via the existing `plan:profile` event with the `config` field populated. The pipeline's existing logic already handles this - `event.config` is preferred over named lookup.

New validation ensures the generated config has valid stage names and required fields before it reaches the pipeline.

## Technical Decisions

### Review round loop location

The review-fix-evaluate loop lives in `pipeline.ts` as a new `reviewCycleStage` that wraps the existing `review`, `review-fix`, and `evaluate` stages. This avoids duplicating the loop logic and keeps the individual stages simple. Profiles that set `maxRounds > 1` get multiple passes; the loop exits early if no issues remain above the `autoAcceptBelow` threshold.

**Alternative considered**: Looping inside each individual stage. Rejected because the loop spans three stages and needs shared state (remaining issues count).

### Merge resolver event collection

The merge resolver agent is an async generator (like all agents) but the `MergeResolver` callback returns `Promise<boolean>`. The bridge in `eforge.ts` iterates the generator, yields events to the orchestrator's event stream, and returns the boolean result. This requires the orchestrator to accept an event sink alongside the resolver callback.

**Alternative considered**: Making `MergeResolver` return an async generator. Rejected because it would change the existing interface contract and complicate the orchestrator's merge logic.

### MergeConflictInfo extension

`MergeConflictInfo` gains optional fields for plan context: `planName`, `planSummary`, `otherPlanName`, `otherPlanSummary`. These are populated from the plan file frontmatter and body during orchestration. The merge resolver agent uses these to understand the intent behind each side's changes.

### Evaluator strictness implementation

Rather than maintaining three separate evaluator prompts, the evaluator prompt gains a `{{strictness}}` template variable that injects a strictness-specific paragraph. The three variants are short blocks embedded in the prompt file using conditional sections. This keeps the prompt as a single file while allowing behavioral variation.

### Profile validation

A new `validateProfileConfig()` function in `config.ts` checks:
- All required fields present (`description`, `compile`, `build`, `review`)
- Stage names exist in the stage registry (compile and build registries)
- Agent roles in `agents` are from the allowed set
- Review config values are within allowed enums

This function is called both for user-defined profiles (at config load time) and for agent-generated profiles (at runtime before pipeline execution).

### Edit region marker format

Markers use a comment format that's language-agnostic for TypeScript/JavaScript:

```typescript
// --- eforge:region {module-id} ---
// --- eforge:endregion {module-id} ---
```

Markers are instructions in the plan, not code the planner writes. The builder writes the actual code within the designated regions. Post-build cleanup is optional and deferred - the markers are benign comments if left in place.

## Quality Attributes

- **Backward compatibility**: All changes are additive. Default config values match current hardcoded behavior, so existing profiles produce identical results.
- **Testability**: Review strategy wiring and profile validation are unit-testable with existing test patterns (real objects, no mocks). Merge resolver uses `StubBackend` for agent wiring tests. Region markers are tested through plan/prompt content assertions.
- **Observability**: New events (`merge:resolve:start/complete`) surface in the monitor. Review round progress is visible through existing `build:review:complete` events emitted per round.
