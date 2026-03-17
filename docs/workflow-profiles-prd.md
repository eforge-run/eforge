# Config-Driven Workflow Profiles

## Problem

The agent pipeline in eforge is hardcoded. Scope assessment returns `errand | excursion | expedition`, and each branches into a fixed compile path while the build path runs identically for all scopes. Turn limits, tool presets, and prompt files are constants scattered across agent call sites. The review cycle always runs one round with a heuristic-based parallel-or-single strategy. There's no way to customize the pipeline for different types of work, and no way to test whether a different pipeline configuration would produce better outcomes.

Different work benefits from different workflows. A database migration doesn't need the same review scrutiny as a security-sensitive feature. A quick refactor shouldn't pay the cost of plan review. Teams develop intuitions about what works, but there's no structured way to encode those intuitions or validate them with data.

## Current behavior

Understanding what's hardcoded today is essential for getting the profile design right.

**Compile path** (scope-dependent):
- All scopes: planner runs, then plan artifacts are committed, then plan-review-cycle runs unconditionally (non-fatal). There is no per-scope skip of plan review today.
- Expedition only: between planner and commit, the engine runs module planning (dependency-wave-ordered, with completed module plans passed as context to dependents), cohesion review cycle, and compilation.

**Build path** (identical for all scopes):
- implement (builder, maxTurns=50)
- parallel-review (auto-decides parallel vs single based on changeset size via `shouldParallelizeReview()`)
- review-fix (only if review found issues)
- evaluate (only if unstaged changes remain)

The parallel review decision is currently automatic - not configurable. The `runReviewCycle()` helper is only used for plan review and cohesion review. Code review in the build path is a separate inline sequence.

**`complete` scope**: When the planner assesses the work as already done, it returns immediately with no plans. No build phase runs.

## Solution

Make the agent pipeline config-driven through **workflow profiles**. A profile is a declarative definition of which agents run, in what order, with what parameters. Eforge ships built-in profiles that match today's hardcoded behavior. Users can define custom profiles alongside the built-ins. The planner auto-selects the best profile for each run by matching the PRD against profile descriptions.

## Design

### Profile structure

A profile defines the compile pipeline, build pipeline, per-agent parameters, and review strategy:

```yaml
profiles:
  excursion:
    description: >
      Multi-file feature work or refactors that need planning and review
      but fit in a single plan. Use for medium-complexity tasks with
      cross-file changes.
    compile:
      - planner
      - plan-review-cycle
    build:
      - implement
      - review
      - review-fix
      - evaluate
    agents:
      planner:
        maxTurns: 30
        prompt: planner        # references src/engine/prompts/planner.md
      builder:
        maxTurns: 50
        prompt: builder
      reviewer:
        maxTurns: 30
        tools: none
    review:
      strategy: auto
      maxRounds: 1
```

The `description` field is critical - it's what the planner reads when deciding which profile fits the work. Good descriptions encode the type of work, risk profile, and signals that distinguish this profile from others.

### Built-in profiles

Eforge ships three built-in profiles encoding today's behavior. These are defined in `src/engine/config.ts` as part of `DEFAULT_CONFIG.profiles`, following the same pattern as all other defaults. This means they participate in the merge chain automatically - a project-level `eforge.yaml` can override fields on a built-in profile just by defining a profile with the same name.

- **errand** - Small, self-contained changes. Single file or a few lines. Low risk, no architectural impact. Compile: planner + plan-review-cycle (matching current behavior where plan review runs unconditionally). Build: implement, review, review-fix, evaluate.
- **excursion** - Multi-file feature work or refactors that need planning and review but fit in a single plan. Compile: planner + plan-review-cycle. Build: implement, review, review-fix, evaluate.
- **expedition** - Large cross-cutting work spanning multiple modules. Needs architecture planning, module decomposition, and parallel execution. Compile: planner + module-planning + cohesion-review-cycle + compile-expedition. Build: implement, review, review-fix, evaluate (per-plan, orchestrated in waves).

Note: errand and excursion have identical pipelines today. The distinction is in the planner's behavior (depth of exploration, plan complexity) rather than in which stages run. Profiles make it possible to actually differentiate them - for example, a future errand profile might skip plan review.

These serve as the default palette and as bases for custom profiles.

### Custom profiles

Users define profiles in `eforge.yaml` or in a standalone YAML file passed via `--profiles`:

```yaml
# eforge.yaml (project-level)
profiles:
  migration:
    description: >
      Database schema changes, data migrations, or ORM model updates.
      Validation matters more than code review. Use when the PRD
      primarily involves schema or data layer changes.
    extends: errand
    build:
      - implement
      - validate
    agents:
      builder:
        maxTurns: 30

  security-sensitive:
    description: >
      Changes touching authentication, authorization, session management,
      or PII handling. Requires extra review scrutiny with security perspective.
    extends: excursion
    review:
      strategy: parallel
      perspectives: [code, security]
      maxRounds: 2
      evaluatorStrictness: strict
```

The `extends` field inherits from a named profile (built-in or custom). Only overridden fields need to be specified. Extension chains are resolved in order (a profile can extend a profile that extends another). Circular extensions are detected and rejected at config load time.

### Profile selection

Profile selection is a **pre-pipeline step**, not a pipeline stage. This avoids a chicken-and-egg problem: the planner needs to run to select a profile, but the profile defines the planner's config.

The selection flow:

1. The engine runs a lightweight profile-selection pass using the planner agent with fixed default config (not profile-dependent). The planner's prompt includes all available profile descriptions.
2. The planner assesses the PRD and codebase, selects a profile, and emits a `plan:profile` event with the profile name and rationale.
3. The engine resolves the selected profile's config and uses it to configure the rest of the pipeline - including the planner's own subsequent planning work if the profile overrides planner config.

If the planner selects `complete` (nothing to do), no profile applies and the run ends early, matching today's behavior.

This replaces the current `plan:scope` event. The three built-in profile names (`errand`, `excursion`, `expedition`) align with the old scope values for backwards compatibility.

### Config loading and merge chain

Profiles follow the same merge strategy as the rest of eforge config:

```
built-in defaults → global ~/.config/eforge/config.yaml → project eforge.yaml → --profiles file → env vars → CLI overrides
```

At each layer, profiles merge by name. A project-level `excursion` profile overrides fields from the built-in `excursion`. A `--profiles` file overlays on top of project config but before env vars and CLI overrides.

The `--profiles` CLI flag points to a YAML file containing a `profiles` section. It doesn't select a specific profile - it adds profiles to the palette that the planner considers.

### Per-agent configuration

Each agent slot in a profile accepts:

| Field | Type | Description |
|-------|------|-------------|
| `maxTurns` | number | Maximum conversation turns |
| `prompt` | string | Prompt file name or path (relative to prompts dir, or absolute) |
| `tools` | `'coding' \| 'none'` | Tool access preset |
| `model` | string | Model override for this agent |

Agent roles that can be configured: `planner`, `builder`, `reviewer`, `review-fixer`, `evaluator`, `plan-reviewer`, `plan-evaluator`, `module-planner`, `cohesion-reviewer`, `cohesion-evaluator`, `validation-fixer`, `assessor`.

When a profile `extends` another, agent config is shallow-merged per-agent: the child's `builder.maxTurns` overrides the parent's, but the parent's `builder.prompt` survives if the child doesn't set it.

### Review strategy configuration

The `review` section of a profile controls the code review cycle in the build phase:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strategy` | `'auto' \| 'single' \| 'parallel'` | `'auto'` | `auto` uses changeset-size heuristic (current behavior), `single` forces single reviewer, `parallel` forces fan-out to specialists |
| `perspectives` | `string[]` | `['code']` | Which review perspectives to use when parallel (code, security, api, docs) |
| `maxRounds` | number | `1` | Review-fix-evaluate cycles before moving on |
| `autoAcceptBelow` | `'suggestion' \| 'warning'` | - | Auto-accept issues at or below this severity |
| `evaluatorStrictness` | `'strict' \| 'standard' \| 'lenient'` | `'standard'` | Maps to evaluator prompt variant |

Note: this configures the build-phase code review. Plan review and cohesion review are compile stages with their own (simpler) review cycle - those use `runReviewCycle()` and are always single-round today.

### Pipeline stages

The `compile` and `build` arrays reference named stages. Each stage is a unit of work with a uniform interface (accepts pipeline context, yields events).

**Compile stages:**
- `planner` - Plan file generation (profile selection happens before this, as a pre-pipeline step)
- `plan-review-cycle` - Plan reviewer + plan evaluator (uses `runReviewCycle()`)
- `module-planning` - Per-module planning in dependency waves (expedition). This is a complex stage internally: it resolves a dependency graph, computes waves, runs module planners in parallel within each wave, and passes completed module plans as context to dependent modules.
- `cohesion-review-cycle` - Cross-module cohesion review + evaluator (expedition, uses `runReviewCycle()`)
- `compile-expedition` - Module plans to plan files + orchestration.yaml (expedition)

**Build stages:**
- `implement` - Builder agent implements the plan
- `review` - Code review (strategy per review config: auto/single/parallel)
- `review-fix` - Review fixer applies aggregated issues (only runs if review found issues)
- `evaluate` - Evaluator accepts/rejects unstaged fixes (only runs if unstaged changes exist)
- `validate` - Run validation commands (post-merge or inline)

### CLI interface

```bash
eforge run prd.md                              # built-in profiles, planner picks
eforge run prd.md --profiles team.yaml         # overlay custom profiles, planner picks
```

The `--profiles` flag accepts a path to a YAML file. Multiple `--profiles` flags could be supported for layering.

### Adopt command

The `adopt` command currently runs a lightweight assessor agent for scope detection before wrapping an existing plan. With profiles, adopt would use the same profile-selection mechanism: the assessor/planner selects a profile, and the adopt flow uses that profile's build pipeline config. The compile pipeline doesn't apply to adopt since adopt skips planning.

## Code changes

### Config layer (`src/engine/config.ts`)

- Add `ProfileConfig` interface with `description`, `extends`, `compile`, `build`, `agents`, `review` fields
- Extend `EforgeConfig` with `profiles: Record<string, ResolvedProfileConfig>` (extensions already resolved)
- Add profile parsing in `parseRawConfig()`
- Add profile resolution: walk `extends` chains (detect cycles), shallow-merge per-field, shallow-merge per-agent within `agents`
- Merge profiles across config layers (global, project, --profiles file) before resolving extensions

### Backend interface (`src/engine/backend.ts`)

- Add optional `model` field to `AgentRunOptions`
- `ClaudeSDKBackend` passes model to SDK when specified

### Prompt loading (`src/engine/prompts.ts`)

- Support custom prompt paths: if the value looks like a path (contains `/`), load from that path; otherwise look in built-in prompts directory
- Prompt override per-agent per-profile flows through agent options

### Engine (`src/engine/eforge.ts`)

- Extract profile selection into a pre-pipeline step with fixed planner config
- `compile()` and `build()` become pipeline executors that iterate a stage list from the resolved profile
- Define a `PipelineStage` interface: each stage takes context + config, returns `AsyncGenerator<EforgeEvent>`
- Register built-in stages in a stage registry (map of name to factory)
- The `module-planning` stage encapsulates the existing wave-based module planning logic (dependency resolution, parallel execution, inter-module context passing)
- Replace `plan:scope` event with `plan:profile` event carrying the selected profile name
- Thread resolved profile config through to agent call sites (maxTurns, tools, prompt, model)

### Planner prompt (`src/engine/prompts/planner.md`)

- Add a section with available profile descriptions (templated at runtime)
- Planner outputs profile selection instead of scope assessment
- Existing scope assessment XML format evolves to profile selection format
- `complete` (nothing to do) remains a valid selection that short-circuits the pipeline

### Events (`src/engine/events.ts`)

- Add `plan:profile` event type with profile name and rationale
- Keep `plan:scope` during transition, derived from profile name when it matches a built-in
- `ScopeAssessment` type remains for backwards compatibility

### Build-phase review (`eforge.ts` planRunner + review helpers)

The build-phase code review is currently an inline sequence in the `planRunner` closure, separate from `runReviewCycle()`. Two paths to make it configurable:

1. **Unify**: Refactor the inline build-phase review to use a generalized review cycle that accepts strategy config (auto/single/parallel, perspectives, maxRounds, severity thresholds). Both plan review and code review use the same parameterized cycle.
2. **Configure separately**: Keep the two review paths distinct but make both accept config from the profile's `review` section.

Option 1 is cleaner long-term but a larger refactor. Option 2 is incremental.

Either way:
- `maxRounds` adds a loop around review → fix → evaluate
- `autoAcceptBelow` filters `ReviewIssue[]` before passing to review-fixer/evaluator
- `evaluatorStrictness` selects evaluator prompt variant
- `strategy` controls the parallel-vs-single decision (replacing `shouldParallelizeReview()` heuristic when set to `single` or `parallel`, preserving it for `auto`)

## Downstream updates

The `plan:profile` event and profile-driven pipeline touch code and documentation beyond the engine core.

### Events ripple (`src/engine/events.ts`)

`plan:scope` is referenced across 11 files today: the engine, planner, assessor, CLI display, monitor UI types, mock server, event cards, and barrel exports. Adding `plan:profile` and maintaining `plan:scope` during transition means:

- `src/engine/events.ts` - Add `plan:profile` event variant, keep `plan:scope`
- `src/engine/agents/planner.ts` - Emit `plan:profile` instead of (or alongside) `plan:scope`
- `src/engine/agents/assessor.ts` - Same for adopt flow
- `src/engine/agents/common.ts` - Update XML parsers if scope/profile output format changes
- `src/engine/eforge.ts` - Handle `plan:profile` event in compile/adopt flows
- `src/cli/display.ts` - Render profile selection (name + rationale)
- `src/cli/index.ts` - Accept `--profiles` flag, pass through to engine
- `src/monitor/ui/src/lib/types.ts` - Add `plan:profile` to monitor event types
- `src/monitor/ui/src/components/timeline/event-card.tsx` - Render profile selection in timeline
- `src/monitor/mock-server.ts` - Add `plan:profile` to mock event data
- `src/engine/index.ts` - Re-export new types

### CLAUDE.md

Update the following sections:
- **Architecture** - Document profile selection as a pre-pipeline step, mention profile config in the config loading description
- **Configuration** - Add `profiles` section to the config schema documentation, document `--profiles` flag
- **CLI commands** - Add `--profiles` flag to the flags list
- **Conventions** - Note that built-in profiles live in config defaults, not separate files

### README.md

If a README exists (or when one is created): document the profiles concept, show example `eforge.yaml` with custom profiles, explain the `--profiles` flag.

### Monitor

The monitor UI renders `plan:scope` events in the timeline and uses scope for run grouping. Updates needed:
- Display selected profile name and rationale in the timeline
- Potentially group or filter runs by profile in the sidebar

### eforge plugin (`eforge-plugin/`)

The Claude Code plugin surfaces status and run info. If it references scope assessment, it needs to handle profile selection. Bump plugin version per CLAUDE.md conventions.

## Eval integration

The eval framework should support profile comparison once profiles ship:

- `eval/scenarios.yaml` gains an optional `profiles` field per scenario (file path to a profiles YAML)
- A scenario can run multiple times across different profiles for comparison
- `result.json` captures: profile name, token cost, review rounds used, agent durations
- Comparison reporting: same PRD across profiles, diff on pass rate, cost, time
- This becomes the evidence loop for tuning profile parameters and descriptions

## What stays the same

- The engine's event-driven architecture (AsyncGenerator pattern)
- The AgentBackend abstraction (agents never import SDK directly)
- The orchestrator for expedition-mode parallel execution via worktrees
- State management and resume support
- Monitor, hooks, tracing, CLI rendering
- The planner still explores the codebase and generates plan files
- The review cycle pattern (reviewer -> evaluator) stays - it just becomes parameterized
- `complete` scope short-circuits before any pipeline runs

## Migration

The default experience is unchanged. Built-in profiles encode exactly today's behavior - including the fact that plan review runs for all scopes and the build pipeline is identical across scopes. `plan:scope` events continue to be emitted (derived from profile name) during transition so existing monitor UI and hooks don't break. The `--profiles` flag is additive - not providing it means only built-in profiles are available, which produces the same behavior as today.
