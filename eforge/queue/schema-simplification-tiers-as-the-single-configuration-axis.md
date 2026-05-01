---
title: Schema Simplification: Tiers as the Single Configuration Axis
created: 2026-05-01
---

# Schema Simplification: Tiers as the Single Configuration Axis

## Problem / Motivation

A critical analysis of the relationship between model class and agent runtime in the eforge config schema surfaced a structural problem: today there are three overlapping enums (`AgentTier`, `ModelClass`, `harness`) and runtime is keyed on a different axis than model. The wizard hides this asymmetry and silently drops the `fast` selection.

After working through the design, the conclusion is a clean simplification: eliminate model class entirely. Each agent tier is a fully-specified recipe (harness + model + effort). Some duplication is fine for ~4-6 tiers. Wizards mitigate it with "copy from another tier".

Per the `feedback_no_backward_compat` rule, the old shape is removed cleanly with no compat layer.

## Goal

Collapse the eforge agent configuration to a single axis (tiers), where each tier is a self-contained recipe of `harness + model + effort` (plus optional fields), eliminating `ModelClass`, `agentRuntimes`, `defaultAgentRuntime`, and all engine-supplied defaults so resolution becomes drastically shorter and less ambiguous.

## Approach

### New schema shape

```yaml
# eforge/config.yaml or eforge/profiles/<name>.yaml
agents:
  tiers:
    planning:
      harness: claude-sdk
      model: { id: claude-opus-4-7 }
      effort: xhigh
      # optional: thinking, claudeSdk.disableSubagents, fallbackModel
    implementation:
      harness: pi
      pi: { provider: anthropic }
      model: { id: claude-sonnet-4-6 }
      effort: medium
    review:
      harness: claude-sdk
      model: { id: claude-opus-4-7 }
      effort: high
    evaluation:
      harness: claude-sdk
      model: { id: claude-opus-4-7 }
      effort: high

  # Optional per-role overrides (rare)
  roles:
    builder:
      maxTurns: 80
      effort: high            # implementation defaults to medium; builder needs more
    merge-conflict-resolver:
      tier: planning          # reassign tier wholesale
```

**Rules:**
- Every declared tier MUST specify `harness`, `model`, `effort`. No engine-supplied defaults.
- Per-role overrides splice individual fields (or `tier:` reassignment) over the tier's recipe.
- Plan-file overrides do the same.
- Tier names default to `planning | implementation | review | evaluation`, but you may add others (e.g., `architecture`); names are open strings.

### What this removes

| Concept | Today | New |
|---|---|---|
| `MODEL_CLASSES` enum (`max\|balanced\|fast`) | `config.ts:54` | **deleted** |
| `agents.models[class]` map | `config.ts:214` | **deleted** (model is on tier) |
| `agentRuntimes` registry | `config.ts:255` | **deleted** (runtime is on tier) |
| `defaultAgentRuntime` | `config.ts:256` | **deleted** (every tier is self-contained) |
| `BUILTIN_TIER_DEFAULTS` | `agent-config.ts:65` | **deleted** (no engine defaults) |
| `MODEL_CLASS_DEFAULTS` per-harness fallback | `agent-config.ts:113` | **deleted** |
| `AGENT_ROLE_MODEL_CLASS_OVERRIDES` | `agent-config.ts:78` | **deleted** — replaced by tier reassignments in `AGENT_ROLE_TIERS` |
| `MODEL_CLASS_TIER` fallback chain | `agent-config.ts:127` | **deleted** |
| `agents.tiers[t].modelClass` | `config.ts:226` | **deleted** |
| `agents.tiers[t].agentRuntime` | `config.ts:227` | **deleted** |
| `agents.roles[r].modelClass` | `config.ts:218` | **deleted** |
| `agents.roles[r].agentRuntime` | `config.ts:220` | **deleted** |

### What this adds / changes

| Concept | Change |
|---|---|
| `tierConfigSchema` | Becomes self-contained recipe: `{ harness, pi?, claudeSdk?, model, effort, thinking?, fallbackModel?, maxTurns?, allowedTools?, disallowedTools?, promptAppend? }` with `superRefine` enforcing harness/pi/claudeSdk consistency (lifted from `agentRuntimeEntrySchema`) |
| `agents.tiers` | Required (not optional); must declare a recipe for every tier referenced by `AGENT_ROLE_TIERS` |
| `agents.roles[r]` | Same field set as tiers (all optional), plus `tier?: string` for tier reassignment |
| `agentRuntimeEntrySchema` | Deleted; its `superRefine` rules move into `tierConfigSchema` |
| `AGENT_ROLE_TIERS` | Updated so the 6 ex-`AGENT_ROLE_MODEL_CLASS_OVERRIDES` roles land in tiers whose default recipe matches their previous (tier × class) cell. See "Role tier reassignment" below |

### Role tier reassignment

The 6 entries in today's `AGENT_ROLE_MODEL_CLASS_OVERRIDES` exist because the role's preferred *capacity* differs from its workload tier's default. With class gone, they need a tier whose recipe matches:

| Role | Today (tier × class) | New tier |
|---|---|---|
| merge-conflict-resolver | implementation × max | `planning` |
| doc-updater | implementation × max | `planning` |
| gap-closer | implementation × max | `planning` |
| dependency-detector | review × balanced | `implementation` |
| prd-validator | review × balanced | `implementation` |
| staleness-assessor | review × balanced | `implementation` |

If a user genuinely wants to keep the workload-shape grouping for these roles while still bumping capacity, they add a per-role override:

```yaml
agents:
  roles:
    merge-conflict-resolver:
      # keep tier=implementation, override model+effort
      model: { id: claude-opus-4-7 }
      effort: high
```

### Resolution algorithm (drastically shorter)

`resolveAgentConfig(role, config, planEntry?)`:

1. Determine tier: `planEntry?.tier > config.agents.roles[role]?.tier > AGENT_ROLE_TIERS[role]`
2. Take the tier recipe: `config.agents.tiers[tier]` (must exist; throw if missing)
3. Apply role override: spread `config.agents.roles[role]` over the recipe (only declared fields)
4. Apply plan-file override: spread `planEntry.agents[role]` over the result
5. Clamp effort, coerce thinking (existing helpers, unchanged)
6. Return resolved config with provenance per field (`harnessSource`, `modelSource`, `effortSource`, `thinkingSource`, `tierSource`)

Each step has a single resolution axis. `effortSource: 'role' | 'plan' | 'tier'` — three values, not five.

### Wizard changes (`packages/pi-eforge/extensions/eforge/`)

`profile-commands.ts` (lines 310-450) and `profile-payload.ts` are rewritten:

1. Walk through each tier (planning → implementation → review → evaluation).
2. For each tier, prompt: harness, (provider if pi), model id, effort. Or "copy from <previous tier>".
3. Preset shortcuts: "max preset" (claude-sdk + opus + high), "balanced preset" (claude-sdk + sonnet + medium), "fast preset" (claude-sdk + haiku + low).
4. YAML preview, submit.

`buildProfileCreatePayload` returns `{ name, scope, agents: { tiers: { ... } } }` — no `agentRuntimes`, no `models`, no `defaultAgentRuntime`.

### Migration

There is no auto-migration; existing config files must be rewritten by hand. Provide a clear validation error pointing at the new shape:

```
eforge/config.yaml: legacy schema detected.
  - `agentRuntimes` is no longer supported. Inline harness/pi config into `agents.tiers.<tier>`.
  - `agents.models` is no longer supported. Each tier carries its own model.
  - `defaultAgentRuntime` is no longer supported.
  See docs/config-migration.md.
```

Test fixtures, sample profiles, and `docs/` examples are updated in the same PR.

### Files to modify

**Engine schema and resolver:**
- `packages/engine/src/config.ts` — schema rewrite (lines 51-309, 1700+ for profile derivation)
- `packages/engine/src/pipeline/agent-config.ts` — collapse 6-tier resolution into 3-tier (lines 50-407)
- `packages/engine/src/pipeline/agent-config.ts:78` — delete `AGENT_ROLE_MODEL_CLASS_OVERRIDES`
- `packages/engine/src/pipeline/agent-config.ts:65` — delete `BUILTIN_TIER_DEFAULTS`
- `packages/engine/src/pipeline/agent-config.ts:113` — delete `MODEL_CLASS_DEFAULTS`
- `packages/engine/src/pipeline/agent-config.ts:25-58` — update `AGENT_ROLE_TIERS` per the table above
- `packages/engine/src/agent-runtime-registry.ts` — simplify; lookup by tier rather than runtime name (lines 154-196)

**Wizard / profile creation:**
- `packages/pi-eforge/extensions/eforge/profile-payload.ts` — rewrite payload shape
- `packages/pi-eforge/extensions/eforge/profile-commands.ts` (lines 310-450) — rewrite wizard flow
- `eforge-plugin/skills/eforge-profile-new/SKILL.md` — update if the Claude plugin has a parallel skill
- `packages/monitor/src/server.ts` — update `/api/profile/create` validator if it lives daemon-side

**Monitor UI (provenance display):**
- `packages/monitor-ui/src/components/thread-pipeline.tsx` (lines 854-894) — adjust source labels (no more `tier-config` vs `role-config` vs `global-config` distinction; just `tier | role | plan`)
- `packages/monitor-ui/src/lib/reducer.ts` (lines 35-61) — drop `agentRuntime` field, keep `harness`, add `harnessSource`

**Tests:**
- `test/agent-config.test.ts` (and similar) — full rewrite around new resolver
- `test/profile-payload.test.ts` — update to new payload shape
- `test/fixtures/` — update YAML fixtures
- Drop tests that exercise dead resolution paths (model class fallback chain, runtime-by-name registry lookup)

**Docs:**
- `docs/` — config schema doc, profile authoring guide, migration note

## Scope

### In scope
- Removing `MODEL_CLASSES`, `agents.models`, `agentRuntimes`, `defaultAgentRuntime`, `BUILTIN_TIER_DEFAULTS`, `MODEL_CLASS_DEFAULTS`, `AGENT_ROLE_MODEL_CLASS_OVERRIDES`, `MODEL_CLASS_TIER`, `agents.tiers[t].modelClass`, `agents.tiers[t].agentRuntime`, `agents.roles[r].modelClass`, `agents.roles[r].agentRuntime`.
- Rewriting `tierConfigSchema` as a self-contained recipe with lifted `superRefine` rules from `agentRuntimeEntrySchema`.
- Making `agents.tiers` required and supporting `tier?: string` reassignment on `agents.roles[r]`.
- Reassigning the 6 ex-override roles to new default tiers per the role tier reassignment table.
- Collapsing `resolveAgentConfig` into the new 6-step algorithm with `tier | role | plan` provenance.
- Rewriting the wizard (`profile-commands.ts`, `profile-payload.ts`) and updating the parallel Claude plugin skill if it exists.
- Updating `/api/profile/create` validator in `packages/monitor/src/server.ts` if it lives daemon-side.
- Adjusting monitor UI provenance labels and dropping `agentRuntime` from the reducer (keeping `harness`, adding `harnessSource`).
- Producing a clear validation error for legacy configs (no auto-migration).
- Updating test fixtures, sample profiles, and `docs/` examples in the same PR.
- No backward compatibility layer (per `feedback_no_backward_compat`).

### Out of scope
- Adding new tier names (e.g., `architecture`, `lightweight`); users can add tiers in their own configs but the engine ships with the existing 4.
- Cost/budget tracking, retries, compaction settings (`pi.compaction`, `pi.retry`, `maxBudgetUsd`); only the model/runtime/effort axis is being restructured.
- Auto-migration tool; a clear validation error is sufficient.

## Acceptance Criteria

- `pnpm type-check` passes (Zod schema ↔ TS type drift catches mistakes).
- `pnpm test` passes for all resolver, wizard, and schema tests; tests that exercised dead resolution paths (model class fallback chain, runtime-by-name registry lookup) are dropped.
- A hand-written profile with two tiers using different harnesses is accepted; running the `eforge_config` MCP tool confirms validation.
- A hand-written profile with a per-role override is correctly resolved: tracing through `resolveAgentConfig` (or running a small build) shows the role uses the override.
- Spinning up `eforge_daemon` and enqueueing a small build with the new config shows monitor stage hover rendering `harness`, `model`, `effort`, `tier` and their `*Source` provenance correctly.
- Loading a legacy config (with `agentRuntimes` / `agents.models` / `defaultAgentRuntime`) emits an actionable validation error pointing at the new shape and `docs/config-migration.md`.
- Running the new wizard end-to-end via `/eforge:profile:new` produces a fresh profile YAML that is well-formed and parses.
- `buildProfileCreatePayload` returns `{ name, scope, agents: { tiers: { ... } } }` with no `agentRuntimes`, no `models`, and no `defaultAgentRuntime`.
- `agents.tiers` is required and the schema rejects configs where any tier referenced by `AGENT_ROLE_TIERS` is missing a recipe.
- Every declared tier specifies `harness`, `model`, and `effort`; the schema rejects tiers missing any of these.
- `effortSource` resolves to one of `tier | role | plan` (three values, not five).
- The 6 ex-`AGENT_ROLE_MODEL_CLASS_OVERRIDES` roles (merge-conflict-resolver, doc-updater, gap-closer, dependency-detector, prd-validator, staleness-assessor) are reassigned in `AGENT_ROLE_TIERS` per the role tier reassignment table.
- Monitor UI no longer shows `tier-config` / `role-config` / `global-config` distinctions; it shows `tier | role | plan`.
- Monitor UI reducer no longer carries `agentRuntime`; it carries `harness` and `harnessSource`.
- Test fixtures, sample profiles, and `docs/` examples (config schema doc, profile authoring guide, migration note) are updated in the same PR.
