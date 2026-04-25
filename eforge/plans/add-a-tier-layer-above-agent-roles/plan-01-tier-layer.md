---
id: plan-01-tier-layer
name: Add tier layer above agent roles
depends_on: []
branch: add-a-tier-layer-above-agent-roles/tier-layer
agents:
  builder:
    effort: high
    rationale: Resolution-chain ordering and merge wiring are tightly specified in
      the source. The builder must coordinate changes across schema, resolver,
      event payload, and UI consumer in lockstep without breaking backward
      compatibility.
  reviewer:
    effort: high
    rationale: "Backward compatibility is a hard contract (acceptance criterion 4 +
      9). Reviewer must verify resolution precedence is exactly: plan > role >
      tier > global > builtin-role > builtin-tier, and that the role-default
      slimming preserves existing behavior."
---

# Add tier layer above agent roles

## Architecture Context

eforge has 23+ distinct agent roles (24 in the `AgentRole` type — the source PRD enumerates 23, plus `recovery-analyst` which exists in code). Each role has its own prompt, schema, tool set, and turn budget. Today users configure them via:

- `agents.{model,thinking,effort,maxTurns}` — global
- `agents.roles.{role}` — per-role (defined in `packages/engine/src/config.ts:185-190`)
- Built-in `AGENT_ROLE_DEFAULTS` and `AGENT_MODEL_CLASSES` tables in `packages/engine/src/pipeline/agent-config.ts:16-72`

To customize 23 agents, a user has to write 23 entries. This plan introduces an `AgentTier` archetype layer (planning / implementation / review / evaluation) that sits between per-role and global config so the common case shrinks to four entries.

The resolution chain in `resolveAgentConfig` (currently four tiers) becomes six tiers, and tier provenance is plumbed through to the agent-runtime event so the monitor stage hover can show it (parallel to the existing `effortSource` / `thinkingSource`).

## Implementation

### Overview

Additive change with no schema break. Six edits:

1. **`packages/engine/src/pipeline/agent-config.ts`** — Add `AgentTier` type, `AGENT_ROLE_TIERS` mapping, `BUILTIN_TIER_DEFAULTS`. Slim `AGENT_ROLE_DEFAULTS` to genuine exceptions. Replace `AGENT_MODEL_CLASSES` per-role table with per-tier `modelClass` defaults plus per-role outlier overrides for the cases that don't match their tier (e.g. `formatter`, `merge-conflict-resolver`, `doc-updater`, `gap-closer`, `pipeline-composer` are currently `max` model class but the source assigns them to `planning` or `implementation` tiers). Insert tier resolution into `resolveSdkPassthrough` and `resolveModel`. Stamp `tier` and `tierSource` onto the returned `ResolvedAgentConfig`.
2. **`packages/engine/src/config.ts`** — Add `agentTierSchema`, add `tiers:` field on the `agents` schema, add `tier:` field on the role value schema, extend `ResolvedAgentConfig` interface and `EforgeConfig.agents` runtime type, wire `tiers` through `resolveConfig` and `mergePartialConfigs`.
3. **`packages/engine/src/events.ts`** — Add `tier?` and `tierSource?` to the `agent:start` event payload.
4. **`packages/engine/src/harnesses/common.ts`** — Add `tier` and `tierSource` to `AgentStartEventOptions` and pass them through `buildAgentStartEvent`.
5. **`packages/engine/src/harnesses/{claude-sdk,pi}.ts`** — Pass `tier` and `tierSource` from the resolved agent config into the agent-start event options (parallel to `effortSource` / `thinkingSource`).
6. **`packages/monitor-ui/src/lib/reducer.ts` + `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx`** — Capture `tier` and `tierSource` on the thread state, render the resolved tier on the stage hover next to effort/thinking.

New tests live next to the existing resolution tests in `test/agent-config.resolution.test.ts`.

### Key Decisions

1. **Tier mapping per the source PRD, plus a 24th role.** The source enumerates 23 agents; the `AgentRole` union also contains `recovery-analyst`. Map `recovery-analyst` to the `implementation` tier (its current `AGENT_MODEL_CLASSES` entry is `balanced`, matching the implementation tier default). This keeps the type system exhaustive without expanding the source's stated scope.

2. **Resolution precedence (highest → lowest)** — every field (effort, thinking, model, modelClass, maxTurns, etc.):
   1. Plan-file override (`planEntry.agents[role]`)
   2. User per-role override (`config.agents.roles[role]`)
   3. **User per-tier (`config.agents.tiers[tierForRole(role)]`)** — NEW
   4. User global (`config.agents.{model,thinking,effort,maxTurns}`)
   5. Built-in per-role defaults (`AGENT_ROLE_DEFAULTS[role]`) — exceptions only
   6. **Built-in per-tier defaults (`BUILTIN_TIER_DEFAULTS[tier]`)** — NEW

3. **Tier-of-role lookup** is `config.agents.roles[role]?.tier ?? AGENT_ROLE_TIERS[role]` so a user can reassign a single role to a different tier (the source's `tester: { tier: review }` example) without editing engine code.

4. **`AGENT_MODEL_CLASSES` is replaced, not extended.** Per the source: `AGENT_MODEL_CLASSES` becomes per-tier `modelClass` defaults inside `BUILTIN_TIER_DEFAULTS`, plus a small per-role outlier override table (`AGENT_ROLE_MODEL_CLASS_OVERRIDES`) for the few roles whose default model class differs from their tier's default. Per the source PRD's tier mapping, all four tiers default `modelClass: max` *except* `implementation` which defaults `modelClass: balanced`. Concretely: `formatter` (planning), `pipeline-composer` (planning), `merge-conflict-resolver` (implementation), `doc-updater` (implementation), `gap-closer` (implementation) all currently sit at `max` in `AGENT_MODEL_CLASSES`; map them to outlier overrides where their resolved class would otherwise change. Walk every role to verify behavioral equivalence under a default config (acceptance criterion 4).

5. **`AGENT_ROLE_DEFAULTS` slims to genuine exceptions.** After this change, the table contains: `builder { maxTurns: 80, effort: 'high' }` (effort outlier — implementation tier defaults to `medium` but builder's current default is `high`, retained as a per-role exception for backward-compat), `tester { maxTurns: 40 }`, `module-planner { maxTurns: 20 }`, `doc-updater { maxTurns: 20 }`, `test-writer { maxTurns: 30 }`, `gap-closer { maxTurns: 20 }`. All other per-role `effort` entries collapse into per-tier `BUILTIN_TIER_DEFAULTS`. Confirm under default config that every role's resolved `effort` is unchanged: planning/review/evaluation = `high` (matches their tiers), implementation = `medium` (matches all implementation roles except builder, which is preserved via its per-role exception above).

6. **`tierSource` provenance vocabulary**: `'role-config'` (came from `config.agents.roles[role].tier`) | `'role-default'` (came from `AGENT_ROLE_TIERS[role]`). The tier itself is always resolved (never undefined).

7. **Six-tier merge wiring** mirrors per-role merge at `config.ts:680-697`. Per-tier shallow merge in `mergePartialConfigs`: project tier overrides global tier on collision, but global-only fields survive.

8. **No removal of `AGENT_ROLE_DEFAULTS` or `AGENT_MODEL_CLASSES`.** Per the source's Out-of-Scope section, both stay as exception tables. `AGENT_MODEL_CLASSES` is repurposed to a smaller `AGENT_ROLE_MODEL_CLASS_OVERRIDES` containing only roles whose default class does not match their tier (or kept as-is and consulted *between* role override and tier default in `resolveModel`). The plan picks the smaller exception-table approach for clarity.

9. **Stable user-visible contract**: tier names `planning`, `implementation`, `review`, `evaluation` are user-typed in YAML config. Treat the zod enum as load-bearing; do not rename without a migration.

## Scope

### In Scope
- New `AgentTier` type and `agentTierSchema` zod enum.
- New `AGENT_ROLE_TIERS: Record<AgentRole, AgentTier>` mapping all 24 roles (23 from source PRD + `recovery-analyst` → `implementation`).
- New `BUILTIN_TIER_DEFAULTS: Record<AgentTier, { effort, thinking?, modelClass, maxTurns? }>` per the source PRD's table.
- Slimmed `AGENT_ROLE_DEFAULTS` (turn-budget exceptions only).
- New `AGENT_ROLE_MODEL_CLASS_OVERRIDES: Partial<Record<AgentRole, ModelClass>>` for roles whose default class doesn't match their tier.
- Tier resolution step inserted into `resolveSdkPassthrough` and `resolveModel`, with tier-source provenance.
- `tier` and `tierSource` fields on `ResolvedAgentConfig` (in `config.ts`).
- `tier?` and `tierSource?` fields on the `agent:start` event (`events.ts`).
- `tier` and `tierSource` plumbed through `harnesses/common.ts`, `harnesses/claude-sdk.ts`, `harnesses/pi.ts`.
- New `tiers` schema field on the `agents` config object.
- New `tier` field on the role value schema in `agents.roles[role]`.
- Tier merge wiring in `resolveConfig` (line 472-484) and `mergePartialConfigs` (line 677-700).
- Monitor UI: add `tier` and `tierSource` to the thread state in `packages/monitor-ui/src/lib/reducer.ts`, render resolved tier on the stage hover in `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx`.
- Tier-resolution tests in `test/agent-config.resolution.test.ts`.

### Out of Scope
- Collapsing 23 agent implementations into runtime-dispatched archetypes. The 24 distinct roles stay.
- Removing `agents.roles.{role}` overrides — they remain the most specific escape hatch.
- Changes to prompt loading (`prompts.ts`) — by-name match continues unchanged.
- New CLI commands or config-file scaffolding for tiers.
- Changes to the `agents.maxContinuations` semantics or `AGENT_MAX_CONTINUATIONS_DEFAULTS`.
- Documentation rewrites beyond what `doc-updater` produces in its parallel pass.

## Files

### Modify

- `packages/engine/src/pipeline/agent-config.ts` — Add `AgentTier`, `AGENT_ROLE_TIERS`, `BUILTIN_TIER_DEFAULTS`, `AGENT_ROLE_MODEL_CLASS_OVERRIDES`. Slim `AGENT_ROLE_DEFAULTS` to maxTurns-only exceptions. Refactor `resolveSdkPassthrough` to walk plan → role → tier → global → builtin-role → builtin-tier. Refactor `resolveModel` to consult `config.agents.tiers[tier].modelClass` and the override table. Stamp `tier` + `tierSource` onto the result. Extend the `EffortSource` / `ThinkingSource` union types with `'tier-config'` so tier-sourced values are distinguishable in provenance.

- `packages/engine/src/config.ts` —
  - Add `agentTierSchema = z.enum(['planning', 'implementation', 'review', 'evaluation'])` near `agentRoleSchema`.
  - In `eforgeConfigBaseSchema.agents` (line 174-191): add `tiers: z.record(agentTierSchema, sdkPassthroughConfigSchema.extend({ maxTurns: z.number().int().positive().optional(), modelClass: modelClassSchema.optional(), agentRuntime: z.string().optional() })).optional()`.
  - In `roles` value schema (line 185-190): add `tier: agentTierSchema.optional()`.
  - Extend `ResolvedAgentConfig` interface (line 271-303): add `tier: AgentTier; tierSource: 'role-config' | 'role-default'`.
  - Extend `EforgeConfig.agents` runtime type (line 323-336): add `tiers?: Partial<Record<AgentTier, ...>>`.
  - In `resolveConfig` agents block (line 472-484): pass `tiers` through.
  - In `mergePartialConfigs` (line 677-700): per-tier shallow merge mirroring the existing per-role merge — extract a reusable `mergeRecord` helper or copy the existing pattern.
  - Extend `EforgeConfig` re-export for `AgentTier`.

- `packages/engine/src/events.ts` (line 240) — Add `tier?: 'planning' | 'implementation' | 'review' | 'evaluation'; tierSource?: 'role-config' | 'role-default'` to the `agent:start` payload. Re-export the `AgentTier` type from this module if convenient (or import from config).

- `packages/engine/src/harnesses/common.ts` —
  - Add `tier?` and `tierSource?` to `AgentStartEventOptions` (line 38-44).
  - In `buildAgentStartEvent` (line 65-75 region): pass them through.

- `packages/engine/src/harnesses/claude-sdk.ts` (line 121-128 region) — Pass `tier: resolved.tier, tierSource: resolved.tierSource` into the agent-start options.

- `packages/engine/src/harnesses/pi.ts` (lines 287-294, 309-316, 332-339 — three call sites) — Same pass-through.

- `packages/monitor-ui/src/lib/reducer.ts` —
  - Add `tier?: string; tierSource?: string` to the thread state interface (line 55-58 region).
  - In the `agent:start` reducer case (line 320-324 region): capture `tier` and `tierSource` from the event onto thread state.

- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (lines 902-933 hover/tooltip region) — Render the resolved tier on the stage hover next to effort/thinking. Single-line addition, follows the existing `effortSource === 'planner'` styling pattern with a neutral color for `'role-default'` and a highlight for `'role-config'`.

### Create

- `test/agent-config.tier-resolution.test.ts` — Tier-resolution tests. Cases:
  1. tier-only config (no per-role override) → tier values applied to every role in that tier.
  2. tier + role override → role override wins for that role only.
  3. role override beats tier (precedence verification).
  4. tier beats global.
  5. built-in tier default applied when nothing else set.
  6. role moved to a different tier via `roles.{role}.tier` → resolves under the new tier's defaults.
  7. Backward-compat sweep: with a config that has no `tiers` section, every role's resolved `ResolvedAgentConfig` matches the pre-change snapshot for `effort`, `modelClass`, `maxTurns`. Drives this from the existing `AgentRole` union to ensure all 24 roles are covered.
  8. `tier` and `tierSource` fields are present on every `ResolvedAgentConfig`.

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `pnpm test` exits 0; all existing agent-config tests pass; the new tier-resolution test file passes all 8 cases.
- [ ] Backward-compat test: a config with no `tiers` section produces a `ResolvedAgentConfig` for every role whose `effort`, `modelClass`, and `maxTurns` match the pre-change values exactly.
- [ ] Tier-resolution test: with the source's example config (planning: high+max, review: high+max, evaluation: low+max, implementation: medium+balanced; `builder.maxTurns: 80`; `tester.tier: review`), `resolveAgentConfig('planner', cfg)` returns `effort: 'high'` and `modelClass: 'max'`; `resolveAgentConfig('builder', cfg)` returns `effort: 'medium'`, `modelClass: 'balanced'`, `maxTurns: 80`; `resolveAgentConfig('evaluator', cfg)` returns `effort: 'low'`, `modelClass: 'max'`; `resolveAgentConfig('tester', cfg)` returns `effort: 'high'` (from review tier) and `tierSource: 'role-config'`.
- [ ] Every `ResolvedAgentConfig` returned by `resolveAgentConfig` has a non-undefined `tier` field whose value is one of `planning | implementation | review | evaluation`.
- [ ] The `agent:start` event TypeScript type includes optional `tier` and `tierSource` fields and the harness call sites populate them from the resolved config.
- [ ] Manual inspection: enqueuing a small PRD via `mcp__plugin_eforge_eforge__eforge_enqueue` with a config that uses `tiers` shows the resolved tier on the monitor stage hover next to effort/thinking.
- [ ] The four tier names (`planning`, `implementation`, `review`, `evaluation`) are the only accepted values in `agentTierSchema`; any other tier name in `tiers:` triggers a zod validation error during config parse.
- [ ] `AGENT_ROLE_TIERS` covers all 24 entries of the `AgentRole` union (compile-time check via `Record<AgentRole, AgentTier>`).
