---
id: plan-01-engine-schema
name: Engine Schema, Resolver, Registry, and Internal Consumers
branch: schema-simplification-tiers-as-the-single-configuration-axis/engine-schema
agents:
  builder:
    effort: xhigh
    rationale: Schema rewrite ripples to ~25 files across engine, harnesses,
      pipeline, CLI, and daemon validator. The change deletes named registry
      indirection (agentRuntimes/defaultAgentRuntime) and the ModelClass axis
      simultaneously; every consumer of resolveAgentConfig and
      AgentRuntimeRegistry needs surgical updates that must all compile
      together. Requires careful, deep reasoning.
  reviewer:
    effort: high
    rationale: "Cross-file consistency check is critical: a single missed call site
      (e.g. an unfixed reference to ModelClass or agentRuntimeName) will only
      show up in CI as a type-check failure. Reviewer must verify completeness
      across the full file list."
  evaluator:
    effort: high
    rationale: Evaluator must judge whether reviewer fixes are strict improvements
      without re-introducing legacy symbols.
  tester:
    effort: high
    rationale: Test files are being rewritten around the new resolver (3-step
      provenance instead of 5-step). Tester must distinguish dropped-by-design
      tests (model class fallback chain, runtime-by-name registry) from
      regressions.
---

# Engine Schema, Resolver, Registry, and Internal Consumers

## Architecture Context

Today the eforge agent configuration carries three overlapping enums (`AgentTier`, `ModelClass`, harness) and runtime is keyed on a different axis than model. Resolution flows through a 6-tier precedence chain with model-class fallback walks. The wizard hides this asymmetry and silently drops the `fast` selection.

This plan collapses configuration to a single axis: **each tier is a self-contained recipe of `harness + model + effort` (plus optional fields)**. There is no engine-supplied default, no model class, and no named agent-runtime registry. Roles inherit from their tier and may splice individual fields (or reassign tier wholesale via `tier: <name>`). Per the `feedback_no_backward_compat` rule, the old shape is removed cleanly with no compat layer.

This plan owns the engine-side TypeScript and the daemon validator — every type-visible consumer of the old shape. After this plan merges, `pnpm type-check` and `pnpm test` pass against the new shape. Plan-02 owns the wizard payload, monitor UI labels, docs, and skills.

## Implementation

### Overview

Rewrite the Zod schema, the resolver, the registry, and every engine consumer to use tier-recipe shape. Update the daemon's `/api/profile/create` validator. Rewrite engine-side tests to exercise the new resolution algorithm. Update the top-level sample config (`eforge/config.yaml`) to the new shape so the project itself self-validates after the refactor.

### Key Decisions

1. **Schema**: `tierConfigSchema` becomes a self-contained recipe with the lifted `superRefine` rules from the deleted `agentRuntimeEntrySchema` (harness/pi/claudeSdk consistency). `agents.tiers` becomes required. The four built-in tier names are still `planning | implementation | review | evaluation`, but the schema accepts arbitrary names so users can declare additional tiers.
2. **Required fields per tier**: every declared tier MUST specify `harness`, `model`, and `effort`. The schema rejects tiers missing any of these. There is no engine-supplied fallback.
3. **Per-role overrides**: same field set as tiers (all optional), plus `tier?: string` for tier reassignment. No `modelClass`, no `agentRuntime`.
4. **Plan-file overrides**: same shape as per-role. Plan-file `agents.<role>.agentRuntime` parsing is removed.
5. **Resolver shape**: `resolveAgentConfig` collapses to 6 steps (determine tier → take recipe → role splice → plan splice → clamp/coerce → stamp provenance). `effortSource`, `thinkingSource`, `harnessSource`, `modelSource` resolve to `tier | role | plan` (three values, not five).
6. **Role tier reassignment**: the 6 ex-`AGENT_ROLE_MODEL_CLASS_OVERRIDES` roles move in `AGENT_ROLE_TIERS` per the table below. With class gone they need a tier whose recipe matches their previous (tier × class) cell.
7. **Registry**: `agent-runtime-registry.ts` no longer looks up by entry name. It maps role → harness instance via the resolved tier's `harness` field. Pi instances are still memoized by `(harness, provider)` key so two tiers with `harness: pi, pi.provider: anthropic` share one instance.
8. **Legacy detection**: `parseRawConfig` / `configYamlSchema` emit an actionable error pointing at the new shape and `docs/config-migration.md` when any of `agentRuntimes`, `defaultAgentRuntime`, or `agents.models` is present. No auto-migration.
9. **Sample config**: `eforge/config.yaml` is rewritten to the new shape so the repo's own config validates against the post-refactor schema and CI passes.

### Role tier reassignment table

| Role | Today (tier × class) | New tier in `AGENT_ROLE_TIERS` |
|---|---|---|
| merge-conflict-resolver | implementation × max | `planning` |
| doc-updater | implementation × max | `planning` |
| gap-closer | implementation × max | `planning` |
| dependency-detector | review × balanced | `implementation` |
| prd-validator | review × balanced | `implementation` |
| staleness-assessor | review × balanced | `implementation` |

## Scope

### In Scope
- Delete `MODEL_CLASSES`, `modelClassSchema`, `ModelClass` type from `packages/engine/src/config.ts`.
- Delete `agents.models`, `agentRuntimes`, `defaultAgentRuntime`, `agentRuntimeEntrySchema`, the cross-field `superRefine` for runtime references.
- Delete `agents.tiers[t].modelClass`, `agents.tiers[t].agentRuntime`, `agents.roles[r].modelClass`, `agents.roles[r].agentRuntime` from the schema.
- Rewrite `tierConfigSchema` in `packages/engine/src/config.ts` as a self-contained recipe `{ harness, pi?, claudeSdk?, model, effort, thinking?, fallbackModel?, maxTurns?, allowedTools?, disallowedTools?, promptAppend? }` with the lifted `superRefine` rules.
- Make `agents.tiers` required in `eforgeConfigSchema`. Validate that every tier referenced by `AGENT_ROLE_TIERS` has a recipe declared.
- Allow `agents.roles.<role>.tier?: string` for tier reassignment.
- Rewrite `packages/engine/src/pipeline/agent-config.ts`: delete `BUILTIN_TIER_DEFAULTS`, `MODEL_CLASS_DEFAULTS`, `AGENT_ROLE_MODEL_CLASS_OVERRIDES`, `MODEL_CLASS_TIER`, and the legacy resolver helpers (`resolveSdkPassthrough` 6-tier walk, `resolveModel` ascending/descending fallback, `resolveAgentRuntimeForRole`). Replace with a 6-step `resolveAgentConfig` that takes the tier recipe, splices role and plan overrides, clamps effort, coerces thinking, and stamps `tier|role|plan` provenance.
- Update `AGENT_ROLE_TIERS` in `packages/engine/src/pipeline/agent-config.ts` (lines 25-58) to reassign the 6 roles per the table above.
- Rewrite `packages/engine/src/agent-runtime-registry.ts`: drop `nameForRole`, `byName`, the `agentRuntimes` lookup. Provide `forRole(role)` that returns an instance derived from the resolved tier's harness. Memoize Pi instances by `(harness, provider)` so multiple tiers sharing a provider share an instance.
- Update every engine consumer: `packages/engine/src/eforge.ts`, `plan.ts`, `playbook.ts`, `events.ts` (drop `agentRuntime` field on `agent:start`, add `harnessSource` if not already present; the resolved tier name and harness are the canonical identifiers), `harness.ts` (drop `agentRuntimeName` from `AgentRunOptions`), `harnesses/common.ts` (drop runtime-name parameter from `buildAgentStartEvent`), `harnesses/pi.ts`, `harnesses/claude-sdk.ts`, `agents/gap-closer.ts` (replace `modelClass` override with tier reassignment), `pipeline/types.ts` (registry shape change), `pipeline/stages/build-stages.ts`, `pipeline/stages/compile-stages.ts`, `prd-queue.ts` (only if it references the deleted symbols).
- Update `packages/engine/src/config.ts` `DEFAULT_CONFIG` to drop `agentRuntimes`/`defaultAgentRuntime` defaults; the engine no longer ships a default tier set, so `loadConfig` must throw a clear error when `agents.tiers` is absent.
- Update `packages/engine/src/config.ts` `mergePartialConfigs` to drop the `agentRuntimes` merge branch and the `defaultAgentRuntime` scalar branch.
- Update `packages/engine/src/config.ts` `parseRawConfig` legacy-detection: replace the `backend:`/`pi:`/`claudeSdk:` migration message with a new message covering `agentRuntimes`, `defaultAgentRuntime`, and `agents.models` per the PRD's validation error spec.
- Update `packages/engine/src/config.ts` `CreateProfileInput`, `createAgentRuntimeProfile`, and `deriveProfileName` to drop `agentRuntimes`/`defaultAgentRuntime`/`models` and accept the tier-recipe shape. Tests for these functions move with their callers.
- Update `packages/eforge/src/cli/mcp-proxy.ts`, `playbook.ts`, `debug-composer.ts` to drop references to deleted symbols.
- Update `packages/client/src/api/playbook.ts` if it references `agentRuntime`.
- Update `packages/monitor/src/server.ts` `/api/profile/create` validator to expect `{ name, scope, agents: { tiers: { ... } } }` (drop the legacy single-runtime and multi-runtime branches).
- Rewrite `eforge/config.yaml` (the project's own sample config) to the new shape so it validates against the post-refactor schema. This file is what the eforge build itself runs against.
- Rewrite engine-side tests: `test/agent-config.resolution.test.ts`, `test/agent-config.tier-resolution.test.ts`, `test/agent-config.mixed-harness.test.ts`, `test/agent-runtime-registry.test.ts`, `test/config.agent-runtimes.schema.test.ts`, `test/config.test.ts`, `test/config-backend-profile.test.ts`, `test/agent-wiring.test.ts`, `test/engine-wiring.test.ts`, `test/harness-rename.test.ts`, `packages/engine/test/plan-file.agent-config.test.ts`, `packages/engine/test/events.agent-start.test.ts`, `packages/engine/test/config.legacy-rejection.test.ts`. Drop tests that exercise dead paths (model class fallback chain, runtime-by-name registry lookup, dangling agentRuntime references).
- Add a focused legacy-rejection test asserting the new validation error message lists `agentRuntimes`, `agents.models`, `defaultAgentRuntime` and references `docs/config-migration.md`.

### Out of Scope
- Wizard rewrite (`packages/pi-eforge/extensions/eforge/profile-commands.ts`, `profile-payload.ts`) — plan-02.
- Monitor UI provenance label rewrites and reducer field changes — plan-02.
- `packages/monitor-ui/src/components/profile/profile-badge.tsx` rendering — plan-02.
- Skills (`eforge-plugin/skills/**/*.md`, `packages/pi-eforge/skills/**/SKILL.md`) — plan-02.
- `docs/config.md`, `docs/config-migration.md` — plan-02.
- `README.md` — plan-02.
- `CHANGELOG.md` — managed by release flow per `feedback_changelog_managed_by_release`.
- New tier names beyond the existing 4 — users may declare custom tiers but the engine ships with the existing 4.
- Cost/budget tracking, retries, compaction settings.

## Files

### Create
- `test/legacy-config-rejection.test.ts` — focused legacy-rejection coverage (only if not already covered by an existing test rewritten in place).

### Modify
- `packages/engine/src/config.ts` — delete `MODEL_CLASSES`, `modelClassSchema`, `ModelClass`, `agents.models`, `agentRuntimes`, `defaultAgentRuntime`, `agentRuntimeEntrySchema`, the cross-field `superRefine` (lines 260-309). Rewrite `tierConfigSchema` (the new self-contained recipe). Make `agents.tiers` required. Update `agents.roles` to drop `modelClass`/`agentRuntime` and add `tier?: string`. Update `EforgeConfig` interface, `DEFAULT_CONFIG`, `resolveConfig`, `mergePartialConfigs`, `parseRawConfig` legacy detection, `CreateProfileInput`, `createAgentRuntimeProfile`, `deriveProfileName`. Update `configYamlSchema` legacy hint to mention the new offending fields.
- `packages/engine/src/pipeline/agent-config.ts` — delete `BUILTIN_TIER_DEFAULTS`, `AGENT_ROLE_MODEL_CLASS_OVERRIDES`, `MODEL_CLASS_DEFAULTS`, `MODEL_CLASS_TIER`, `resolveSdkPassthrough` (legacy 6-tier walk), `resolveModel` (fallback walk), `resolveFallbackModel`, `resolveAgentRuntimeForRole`. Update `AGENT_ROLE_TIERS` per reassignment table. Rewrite `resolveAgentConfig` as the 6-step algorithm with `tier|role|plan` provenance.
- `packages/engine/src/agent-runtime-registry.ts` — drop `nameForRole`, `byName`, the `agentRuntimes` lookup, `wrapWithRuntimeName`. Provide `forRole(role)` that returns a harness instance based on the resolved tier's `harness` (Pi instances memoized by `(harness, provider)`). Drop the empty-`agentRuntimes` precondition.
- `packages/engine/src/eforge.ts` — update `EforgeEngineOptions`, instance fields, and every call site that referenced `agentRuntimes`/`defaultAgentRuntime`. Pass tier-derived registry through.
- `packages/engine/src/plan.ts` — drop `agentRuntime` from plan-file frontmatter parsing; `tier?: string` is the only reassignment knob.
- `packages/engine/src/playbook.ts` — drop `agentRuntime` field from frontmatter and parsed output.
- `packages/engine/src/events.ts` — `agent:start` event: drop `agentRuntime` field, ensure `harness`, `tier`, `tierSource`, `harnessSource` are present. Add `effortSource`/`thinkingSource` value union restricted to `'tier' | 'role' | 'plan'`.
- `packages/engine/src/harness.ts` — drop `agentRuntimeName` from `AgentRunOptions`.
- `packages/engine/src/harnesses/common.ts` — drop runtime-name parameter from `buildAgentStartEvent`; populate event from harness/tier instead.
- `packages/engine/src/harnesses/pi.ts` — drop `agentRuntimeName` references; emit `harness: 'pi'` directly.
- `packages/engine/src/harnesses/claude-sdk.ts` — drop `agentRuntimeName` references.
- `packages/engine/src/agents/gap-closer.ts` — replace any `modelClass` override with tier reassignment (the role moves to `planning` tier per the reassignment table).
- `packages/engine/src/pipeline/types.ts` — update `PipelineContext` registry shape.
- `packages/engine/src/pipeline/stages/build-stages.ts`, `compile-stages.ts` — drop references to `agentRuntime`/`modelClass` if any.
- `packages/engine/src/prd-queue.ts` — only if it references deleted symbols (no usage was found in exploration; verify).
- `packages/eforge/src/cli/mcp-proxy.ts` — drop schema references to deleted fields; expose the new tier-recipe schema.
- `packages/eforge/src/cli/playbook.ts` — drop `agentRuntime` serialization.
- `packages/eforge/src/cli/debug-composer.ts` — drop references to deleted symbols.
- `packages/client/src/api/playbook.ts` — drop `agentRuntime` field from API contract if present.
- `packages/monitor/src/server.ts` — `/api/profile/create` validator: expect `{ name, scope, agents: { tiers: Record<string, TierRecipe> } }`. Reject the two legacy branches (single-runtime `{ harness, pi }` and multi-runtime `{ agentRuntimes, defaultAgentRuntime }`).
- `eforge/config.yaml` — rewrite to the new tier-recipe shape so the repo self-validates. Use claude-sdk + claude-opus-4-7 + high for planning/review/evaluation; claude-sdk + claude-sonnet-4-6 + medium for implementation. Preserve existing `build.postMergeCommands`.
- `test/agent-config.resolution.test.ts` — rewrite around new resolver: tier > role > plan precedence, provenance values are `tier|role|plan`, missing-tier-recipe throws.
- `test/agent-config.tier-resolution.test.ts` — rewrite around tier reassignment via `agents.roles.<r>.tier`. Verify the 6 reassigned roles land in their new tiers.
- `test/agent-config.mixed-harness.test.ts` — rewrite around tiers using different harnesses (e.g., planning=claude-sdk, implementation=pi).
- `test/agent-runtime-registry.test.ts` — rewrite around role-to-harness dispatch via tier; drop tests for `byName`, `nameForRole`, lazy-load-on-empty, dangling-name errors.
- `test/config.agent-runtimes.schema.test.ts` — rename or repurpose to cover the new tier-recipe `superRefine`. Drop tests for `agentRuntimes` cross-field validation.
- `test/config.test.ts` — drop `agents.models`/`agentRuntimes` cases; add tier-recipe coverage.
- `test/config-backend-profile.test.ts` — rewrite around profile-tier-recipe scope merging.
- `test/agent-wiring.test.ts` — update to construct configs with tier recipes.
- `test/engine-wiring.test.ts` — same.
- `test/harness-rename.test.ts` — drop tests that depended on the legacy `agentRuntimes` rename path; keep only what still applies.
- `packages/engine/test/plan-file.agent-config.test.ts` — drop `agentRuntime` plan-frontmatter override; add `tier:` reassignment coverage.
- `packages/engine/test/events.agent-start.test.ts` — drop `agentRuntime` field assertions; add `harness`/`tier`/`harnessSource` assertions.
- `packages/engine/test/config.legacy-rejection.test.ts` — assert the new validation error lists `agentRuntimes`, `agents.models`, `defaultAgentRuntime` and references `docs/config-migration.md`.
- Other test files only as required to compile (e.g. `test/recovery.test.ts`, `test/playbook.test.ts`, `test/profile-wiring.test.ts`, `test/gap-closer.test.ts`, `test/watch-queue.test.ts`, `test/sharded-*` if they construct configs) — minimal mechanical updates to use the new shape. Tests covering wizard payload shape and monitor UI fields stay in plan-02.

## Verification

- [ ] `pnpm type-check` exits with status 0.
- [ ] `pnpm test` exits with status 0 and no test in this plan's file list is skipped.
- [ ] `grep -R "MODEL_CLASSES\|modelClassSchema\|ModelClass\|AGENT_ROLE_MODEL_CLASS_OVERRIDES\|BUILTIN_TIER_DEFAULTS\|MODEL_CLASS_DEFAULTS\|MODEL_CLASS_TIER\|defaultAgentRuntime\|agentRuntimes\b" packages/engine packages/eforge packages/monitor packages/client` returns zero matches (excluding deletion comments).
- [ ] `grep -R "agentRuntimeName\|nameForRole\|byName" packages/engine` returns zero matches.
- [ ] `eforgeConfigSchema.parse({ agents: { tiers: {} } })` throws with a message naming each missing tier from `AGENT_ROLE_TIERS`.
- [ ] `eforgeConfigSchema.parse({ agents: { tiers: { planning: { harness: 'claude-sdk' } } } })` throws on missing `model` and `effort`.
- [ ] A config with `agentRuntimes:` triggers the legacy validation error and the error message includes the strings `agentRuntimes`, `agents.models`, `defaultAgentRuntime`, and `docs/config-migration.md`.
- [ ] `resolveAgentConfig(role, config, planEntry)` returns a result whose `effortSource`, `thinkingSource`, `tierSource`, `harnessSource`, `modelSource` are each one of the literal strings `'tier'`, `'role'`, or `'plan'` (no other values appear).
- [ ] `AGENT_ROLE_TIERS['merge-conflict-resolver']`, `['doc-updater']`, `['gap-closer']` each equal `'planning'`.
- [ ] `AGENT_ROLE_TIERS['dependency-detector']`, `['prd-validator']`, `['staleness-assessor']` each equal `'implementation'`.
- [ ] A config with two tiers using different harnesses (e.g. `planning: { harness: 'claude-sdk', ... }`, `implementation: { harness: 'pi', pi: { provider: 'anthropic' }, ... }`) parses without error and `forRole('builder')` returns a Pi-backed harness while `forRole('planner')` returns a claude-sdk-backed harness.
- [ ] `eforge/config.yaml` parses against the new schema; running `pnpm build` in this worktree succeeds.
- [ ] `agent:start` event payload contains the keys `harness`, `tier`, `tierSource`, `harnessSource` and does not contain the key `agentRuntime`.
- [ ] No file under `packages/engine/`, `packages/eforge/`, `packages/monitor/`, `packages/client/` imports `ModelClass`, `agentRuntimeEntrySchema`, or `MODEL_CLASS_DEFAULTS`.
