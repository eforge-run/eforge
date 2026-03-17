# Model Tier Abstraction

## Problem

`AgentProfileConfig.model` and `AgentRunOptions.model` both exist as `string` fields, but nothing connects them through the pipeline. The config parser reads the value from YAML and then it gets dropped before reaching any agent. Beyond the wiring gap, raw model names in config couple profiles to a specific backend - if you switch from Claude SDK to something else, every profile breaks.

## Goal

A backend-agnostic model tier system where profiles declare intent (`powerful`, `balanced`, `fast`) and backends resolve those tiers to concrete models. Each agent declares its own default tier. The pipeline threads the resolved model through to every `backend.run()` call.

## Tiers

Three tiers - `powerful | balanced | fast` - expressed as a `ModelTier` union type.

- `powerful` - strongest available model. The default for most agents - planning, building, reviewing, and evaluating all benefit from the best reasoning available.
- `balanced` - good judgment and coding ability. For agents where speed or cost matters more than peak quality.
- `fast` - quick, cheap, low-stakes utility tasks only. Not suitable for evaluation, planning, reviewing, or building. No built-in agent defaults to this tier.

## Design

### Agent-owned defaults

Each agent file exports a `DEFAULT_MODEL_TIER` constant declaring what tier it needs. This is domain knowledge - the planner knows it needs `powerful`, the reviewer knows `balanced` is enough. Profiles can override per-agent, but the agent's own default is the fallback.

Default assignments:

| Agent | Default | Why |
|-------|---------|-----|
| planner | `powerful` | Codebase exploration, architecture, scope assessment |
| builder (implement) | `powerful` | Multi-file implementation |
| builder (evaluate) | `powerful` | Judges reviewer fixes - bad evaluations waste cycles |
| module-planner | `powerful` | Architecture-aware detailed planning |
| reviewer | `powerful` | Code review quality directly gates build quality |
| plan-reviewer | `powerful` | Plan quality assessment |
| plan-evaluator | `powerful` | Judges plan reviewer fixes |
| cohesion-reviewer | `powerful` | Cross-module cohesion analysis |
| cohesion-evaluator | `powerful` | Judges cohesion fixes |
| review-fixer | `powerful` | Applies review fixes - coding task |
| validation-fixer | `powerful` | Diagnoses and fixes validation failures |
| merge-conflict-resolver | `powerful` | Understands both sides of a conflict |
| assessor | `balanced` | Scope assessment is a lighter judgment call |

### Resolution chain

```
profile.agents[role].model   (tier override from config)
  ?? agent's DEFAULT_MODEL_TIER  (agent's own default)
  → backend.resolveModel(tier)   (tier → concrete model string)
  → AgentRunOptions.model        (passed to backend.run())
```

`AgentRunOptions.model` stays `string | undefined` - the backend receives a concrete model name, not a tier. Resolution happens in the pipeline layer.

### Backend contract

`AgentBackend` gains one method:

```typescript
resolveModel(tier: ModelTier): string
```

Each backend implementation maps tiers to its own models. For `ClaudeSDKBackend`, the initial map is `{ powerful: 'claude-sonnet-4-20250514', balanced: 'claude-sonnet-4-20250514', fast: 'claude-haiku-3-5-20241022' }`. The constructor accepts an optional `modelMap` override so callers can swap in different models without subclassing.

### Config syntax

```yaml
profiles:
  # Override defaults to save cost on simple tasks
  budget-errand:
    extends: errand
    agents:
      planner:
        model: balanced
      builder:
        model: balanced
      reviewer:
        model: balanced
```

`AgentProfileConfig.model` changes from `string` to `ModelTier`. The config parser validates against the known tier values.

## Scope

### In scope

- `ModelTier` type definition in `backend.ts`
- `resolveModel()` on `AgentBackend` interface + `ClaudeSDKBackend` + `StubBackend`
- `AgentProfileConfig.model` type change + config parser validation
- `DEFAULT_MODEL_TIER` export from each agent file
- Pipeline helper to resolve tier → model string
- Wire model through all pipeline stages and direct callers in `eforge.ts`
- Barrel re-export of `ModelTier`
- Tests for parsing, resolution, and wiring

### Out of scope

- New backends (OpenRouter, etc.)
- Per-run model override CLI flags
- Model cost tracking or budget limits
