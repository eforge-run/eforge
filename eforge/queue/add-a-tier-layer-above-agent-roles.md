---
title: Add a Tier Layer Above Agent Roles
created: 2026-04-25
---

# Add a Tier Layer Above Agent Roles

## Problem / Motivation

The engine has 23 distinct agent roles (planner, builder, reviewer, plan-reviewer, architecture-reviewer, cohesion-reviewer, evaluator, plan-evaluator, architecture-evaluator, cohesion-evaluator, review-fixer, validation-fixer, merge-conflict-resolver, doc-updater, test-writer, tester, formatter, prd-validator, dependency-detector, pipeline-composer, gap-closer, module-planner, staleness-assessor). Each has its own prompt, output schema, tool set, and turn budget — they are genuinely different units of work and should not be collapsed into a small number of runtime-dispatched archetypes.

But the *configuration burden* should not scale with agent count. A user who wants "frontier model + high thinking for planning and review, workhorse + medium for implementation, frontier + low thinking for evaluation" has to either: (a) accept the built-in defaults and lose the customization, or (b) write 23 entries under `agents.roles`. Today's `agents.roles.{role}` overrides exist (`config.ts:184`), but there is no aggregation level above them.

## Goal

Introduce a **tier** (archetype) layer that sits *above* `agents.roles` and *below* `agents` (global), so users configure 4 tiers instead of 23 roles, while per-role escape hatches remain. The change is purely additive — existing configs keep working unchanged.

## Approach

### Tier Definitions

Four tiers, mapped to all 23 agents:

| Tier | Built-in defaults | Agents |
|---|---|---|
| **planning** | `modelClass: max`, `effort: high` | planner, module-planner, formatter, pipeline-composer, dependency-detector |
| **implementation** | `modelClass: balanced`, `effort: medium`, `maxTurns: 80` (builder), `maxTurns: 30` (others) | builder, doc-updater, gap-closer, review-fixer, validation-fixer, merge-conflict-resolver, test-writer, tester |
| **review** | `modelClass: max`, `effort: high` | reviewer, plan-reviewer, architecture-reviewer, cohesion-reviewer, prd-validator, staleness-assessor |
| **evaluation** | `modelClass: max`, `effort: high` | evaluator, plan-evaluator, architecture-evaluator, cohesion-evaluator |

Tier names are user-visible config keys; treat them as a stable contract.

### Resolution Chain

Insert tier resolution into the existing chain in `packages/engine/src/pipeline/agent-config.ts`. New precedence (highest → lowest), per field (effort, thinking, model, modelClass, maxTurns, etc.):

1. Plan-file override (`planEntry.agents[role]`) — unchanged
2. **User per-role override** (`config.agents.roles[role]`) — unchanged
3. **User per-tier config** (`config.agents.tiers[tierForRole(role)]`) — *NEW*
4. User global config (`config.agents.{model,thinking,effort,maxTurns}`) — unchanged
5. Built-in per-role defaults (`AGENT_ROLE_DEFAULTS[role]`) — kept for exceptions only
6. **Built-in per-tier defaults** (`BUILTIN_TIER_DEFAULTS[tier]`) — *NEW*

The role's tier is determined by `config.agents.roles[role].tier ?? AGENT_ROLE_TIERS[role]` so a user can move a single role between tiers without editing engine code.

Most entries in `AGENT_ROLE_DEFAULTS` (`agent-config.ts:16-35`) collapse into `BUILTIN_TIER_DEFAULTS`. Genuine per-role exceptions — e.g. `builder.maxTurns = 80`, `tester.maxTurns = 40`, `module-planner.maxTurns = 20` — stay in `AGENT_ROLE_DEFAULTS`. `AGENT_MODEL_CLASSES` (`agent-config.ts:47-71`) is replaced by per-tier `modelClass` defaults plus per-role overrides for the few outliers.

### Files to Modify

#### 1. `packages/engine/src/pipeline/agent-config.ts`
- Add `AgentTier` type (`'planning' | 'implementation' | 'review' | 'evaluation'`).
- Add `AGENT_ROLE_TIERS: Record<AgentRole, AgentTier>` mapping all 23 roles to their tier.
- Add `BUILTIN_TIER_DEFAULTS: Record<AgentTier, Partial<ResolvedAgentConfig> & { modelClass?: ModelClass }>` (effort, thinking?, modelClass, maxTurns).
- Slim `AGENT_ROLE_DEFAULTS` down to genuine exceptions (turn budgets that differ from tier default).
- Update `resolveSdkPassthrough` to walk: plan → role → **tier** → global → built-in role → built-in tier.
- Update `resolveModel` to consult `config.agents.tiers[tier].modelClass` between role override and global.
- Stamp `tier` and `tierSource` (`'role-config' | 'role-tier-override' | 'default'`) onto the returned `ResolvedAgentConfig` so the monitor can show it.

#### 2. `packages/engine/src/config.ts`
- Add `agentTierSchema = z.enum(['planning', 'implementation', 'review', 'evaluation'])`.
- Add `tiers: z.record(agentTierSchema, sdkPassthroughConfigSchema.extend({ maxTurns, modelClass, agentRuntime })).optional()` to the `agents` schema (line 173).
- Add `tier: agentTierSchema.optional()` to the `roles` value schema (line 184) so a user can reassign a single role to a different tier without code changes.
- Extend `ResolvedAgentConfig` (line ~272) with `tier: AgentTier; tierSource: ...`.
- Wire `tiers` through the merge logic at lines 471-482 and the project/global merge at 676-698 (per-tier shallow merge, mirroring the existing per-role merge).

#### 3. `packages/engine/src/events.ts`
- Surface `tier` and `tierSource` on the agent-runtime event payload that the monitor consumes (parallel to `effortSource` / `thinkingSource`). Keep the existing per-agent runtime event — no schema break, just extra fields.

#### 4. `packages/monitor-ui/src/...` (stage hover)
- Show the resolved tier alongside effort/thinking on the agent stage hover. (Mark from memory: surface runtime agent decisions in monitor UI.) Single-line addition next to existing effort/thinking display.

#### 5. Tests in `test/`
- Add tier-resolution tests next to the existing agent-config resolution tests (search `test/` for `resolveAgentConfig` to find them).
- Cases: tier-only config, tier + role override, role override beats tier, tier beats global, built-in tier default applied when nothing else set, role moved to a different tier via `roles.{role}.tier`.

### Reused Code

- `resolveSdkPassthrough`, `resolveModel`, `applyEffortClamp`, `applyThinkingCoercion` (all in `agent-config.ts`) — extend, don't replace.
- `sdkPassthroughConfigSchema` in `config.ts` — reuse for tier value shape.
- Existing per-role merge logic at `config.ts:676-698` — copy/parallelize for tiers, don't rewrite.
- Provenance pattern (`effortSource`, `thinkingSource`) — extend with `tierSource` using the same vocabulary.

### Default User Config Example (post-change)

```yaml
agents:
  defaultAgentRuntime: balanced-runtime
  tiers:
    planning:
      effort: high
      thinking: { type: enabled, budgetTokens: 16000 }
      modelClass: max
    review:
      effort: high
      modelClass: max
    evaluation:
      effort: low
      modelClass: max
    implementation:
      effort: medium
      modelClass: balanced
  roles:
    builder:
      maxTurns: 80         # one-off override
    tester:
      tier: review         # promote tester into the review tier
```

This is exactly the user's example from the prompt and requires no per-role config for 21 of the 23 agents.

## Scope

### In Scope
- New `AgentTier` type, `AGENT_ROLE_TIERS` mapping, and `BUILTIN_TIER_DEFAULTS` in `packages/engine/src/pipeline/agent-config.ts`.
- Slimming `AGENT_ROLE_DEFAULTS` to genuine exceptions (e.g. `builder.maxTurns = 80`, `tester.maxTurns = 40`, `module-planner.maxTurns = 20`).
- Replacing `AGENT_MODEL_CLASSES` with per-tier `modelClass` defaults plus per-role outlier overrides.
- New tier resolution step inserted into `resolveSdkPassthrough` and `resolveModel`.
- New `tier` and `tierSource` fields on `ResolvedAgentConfig` and on the agent-runtime event payload in `events.ts`.
- New `tiers` schema and `tier` field on roles in `config.ts`, including merge wiring at lines 471-482 and 676-698.
- Monitor UI stage hover display of resolved tier alongside effort/thinking.
- Tier-resolution tests in `test/`.

### Out of Scope
- No collapsing of agent implementations into runtime-dispatched archetypes. The 23 agents stay.
- No deprecation of `AGENT_ROLE_DEFAULTS` or `AGENT_MODEL_CLASSES` — they remain as exception tables.
- No removal of `agents.roles.{role}` overrides — they remain as the most specific escape hatch.
- No changes to prompt loading (`prompts.ts`) — by-convention name match continues unchanged.

## Acceptance Criteria

1. `pnpm build` — typecheck clean.
2. `pnpm test` — all existing agent-config tests pass; new tier tests pass.
3. **Resolution test** — a script (or unit test) that calls `resolveAgentConfig` for every role with the example config above asserts: planner gets `max + high`, builder gets `balanced + medium + 80 turns`, evaluator gets `max + low`, tester resolves into the review tier.
4. **Backward-compatibility test** — an existing config with no `tiers` section produces the same `ResolvedAgentConfig` for every role as it did before this change.
5. **End-to-end** — enqueuing a tiny PRD via `mcp__plugin_eforge_eforge__eforge_enqueue` against a config that uses `tiers` shows the new `tier` field on the monitor stage hover alongside effort/thinking.
6. `pnpm type-check` from the repo root passes.
7. New tier-resolution tests cover: tier-only config, tier + role override, role override beats tier, tier beats global, built-in tier default applied when nothing else set, and role moved to a different tier via `roles.{role}.tier`.
8. Tier names (`planning`, `implementation`, `review`, `evaluation`) are treated as a stable user-visible contract.
9. The change is purely additive: existing configs keep working unchanged.
