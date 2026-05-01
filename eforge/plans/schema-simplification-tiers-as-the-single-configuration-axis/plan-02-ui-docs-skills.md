---
id: plan-02-ui-docs-skills
name: Wizard, Monitor UI, Docs, and Skills
branch: schema-simplification-tiers-as-the-single-configuration-axis/ui-docs-skills
agents:
  builder:
    effort: high
    rationale: Wizard rewrite is non-trivial (collect tier recipes with
      copy-from-previous-tier and preset shortcuts), and the docs/skills updates
      need to stay consistent with the new schema vocabulary across many files.
  reviewer:
    effort: medium
    rationale: Mostly mechanical updates once the wizard flow is right; reviewer
      needs to confirm consistency between docs, skills, and the engine schema
      landed in plan-01.
---

# Wizard, Monitor UI, Docs, and Skills

## Architecture Context

Plan-01 landed the new tier-recipe schema in the engine and the daemon validator. The daemon now rejects payloads in the old shape, so any incoming `/api/profile/create` request from the wizard fails until the wizard is rewritten. Existing user-facing docs and skills still describe the old `agentRuntimes`/`defaultAgentRuntime`/`agents.models` vocabulary, which is now invalid.

This plan rewrites the wizard payload and conversation flow, updates the monitor UI provenance labels and reducer fields, and rewrites every doc and skill to use the tier-recipe vocabulary. It also adds `docs/config-migration.md`, which is referenced by the legacy validation error landed in plan-01.

Duck-typed code (the wizard's `ProfileCreatePayload`, the monitor UI reducer's event shape, the profile-badge component) does not import engine TypeScript directly, which is why these changes can land after plan-01 without breaking type-check there.

## Implementation

### Overview

Rewrite `buildProfileCreatePayload` to return `{ name, scope, agents: { tiers: { ... } } }`. Rewrite the `/eforge:profile:new` wizard flow to walk through each of the four built-in tiers (planning → implementation → review → evaluation) and prompt for harness, provider (if pi), model id, and effort. Offer "copy from <previous tier>" and three preset shortcuts (max / balanced / fast). Update the monitor UI reducer to drop `agentRuntime`, keep `harness`, and add `harnessSource`. Update the pipeline thread component to render `tier | role | plan` provenance instead of `tier-config | role-config | global-config | default`. Update profile-badge rendering. Rewrite all skills and docs.

### Key Decisions

1. **Wizard flow**: tier-by-tier. For each tier, ask harness → provider (pi only) → model → effort, OR offer "copy from <previous tier>", OR a preset shortcut. The four built-in tiers are walked in fixed order; users who want custom tier names edit the YAML directly.
2. **Preset shortcuts**: `max` → `claude-sdk + claude-opus-4-7 + high`, `balanced` → `claude-sdk + claude-sonnet-4-6 + medium`, `fast` → `claude-sdk + claude-haiku-4-5 + low`. These match the model IDs that lived in `MODEL_CLASS_DEFAULTS` before deletion.
3. **Payload shape**: `buildProfileCreatePayload` returns `{ name, scope, agents: { tiers: { planning: {...}, implementation: {...}, review: {...}, evaluation: {...} } } }`. No `agentRuntimes`, no `defaultAgentRuntime`, no `agents.models`.
4. **Monitor reducer**: drop the `agentRuntime` field on `AgentThread`; keep `harness` (string); add `harnessSource` (string). Reuse the existing `tier`/`tierSource` fields. Provenance values change from `tier-config|role-config|global-config|default` to `tier|role|plan`.
5. **Pipeline UI**: source label colors and grouping logic are simplified to three values. The legacy `effortSource === 'role-config' || effortSource === 'global-config'` collapse logic disappears.
6. **Migration doc**: a new `docs/config-migration.md` walks through rewriting a legacy profile to the new shape and is the destination linked from the validation error message landed in plan-01.

## Scope

### In Scope
- Rewrite `packages/pi-eforge/extensions/eforge/profile-payload.ts`: replace `ProfileCreateInput`, `ModelClassSelection`, and `ProfileCreatePayload` with tier-recipe shapes. Drop `runtimeName` derivation; drop the `agentRuntimes` map entirely. Export `buildProfileCreatePayload({ name, scope, tiers: { planning, implementation, review, evaluation } })`.
- Rewrite `packages/pi-eforge/extensions/eforge/profile-commands.ts` (`handleProfileNewCommand` lines 310-511 and the `buildYamlPreview` helper at the top of the file): walk planning → implementation → review → evaluation. Each step offers (a) preset shortcut, (b) copy from previous tier, (c) custom (harness → provider → model → effort).
- Update `packages/pi-eforge/extensions/eforge/index.ts` and `config-command.ts` if they reference deleted symbols.
- Update `packages/monitor-ui/src/lib/reducer.ts` (lines 35-61): drop `agentRuntime` from `AgentThread`; keep `harness`; add `harnessSource: string` (provenance for harness, mirroring `tierSource`). Update event-mapping logic to populate these fields from the new `agent:start` shape.
- Update `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` (lines 854-894): render `tier | role | plan` for `effortSource`, `thinkingSource`, `tierSource`, `harnessSource`, `modelSource`. Drop the `role-config || global-config` collapse logic. Drop `tier-config` references. Render harness + harness provenance.
- Update `packages/monitor-ui/src/components/profile/profile-badge.tsx`: render the new tier-recipe shape (no `agentRuntimes` map, no `defaultAgentRuntime`).
- Rewrite `eforge-plugin/skills/profile-new/profile-new.md`, `profile/profile.md`, `init/init.md`, `config/config.md` to use the tier-recipe vocabulary. Replace every `agentRuntimes`/`defaultAgentRuntime`/`agents.models` example with the equivalent tier-recipe YAML. Update preset descriptions to reference the three preset shortcuts (max/balanced/fast) and clarify they are starting points, not enums.
- Rewrite `packages/pi-eforge/skills/eforge-profile-new/SKILL.md`, `eforge-profile/SKILL.md`, `eforge-config/SKILL.md`, `eforge-init/SKILL.md` with the same vocabulary changes.
- Rewrite `docs/config.md`: the agents section drops `models`, `tiers.<t>.modelClass`, `tiers.<t>.agentRuntime`, `roles.<r>.modelClass`, `roles.<r>.agentRuntime`, `agentRuntimes`, `defaultAgentRuntime`. Add documentation for the new tier-recipe shape and `roles.<r>.tier` reassignment.
- Create `docs/config-migration.md`: side-by-side legacy → new examples for a single-runtime profile, a multi-runtime profile (mixed harnesses), and a profile with per-tier model class overrides. Worked example walks through rewriting one of the more complex pre-refactor profiles.
- Update `README.md`: adjust the configuration example near any "Quick Start" / "Configuration" section to use the tier-recipe shape.
- Rewrite `test/profile-payload.test.ts` around the new `buildProfileCreatePayload` shape: assert tier-recipe output, no `agentRuntimes` map, no `defaultAgentRuntime`. Drop tests for de-duplication by runtime name, tests for `agents.tiers.implementation.agentRuntime` override emission, and tests asserting `fast` is declared in `agentRuntimes`.
- Update `test/profile-wiring.test.ts` if its skill-registration assertions reference the legacy payload shape.
- Update `test/monitor-reducer.test.ts` to drop `agentRuntime` field assertions and add `harness`/`harnessSource` assertions.
- Update any test fixture YAML files referenced by tests in this plan's file list (no profile fixtures were found in `test/fixtures/` during exploration, but verify before running).

### Out of Scope
- Engine schema, resolver, registry, or any internal engine consumer (owned by plan-01).
- New tier names beyond the four built-ins (the engine ships with planning/implementation/review/evaluation; user-defined tier names work but the wizard doesn't prompt for them).
- Cost/budget/retry/compaction settings.
- `CHANGELOG.md` (release-flow owned).
- Auto-migration tool.

## Files

### Create
- `docs/config-migration.md` — legacy → tier-recipe migration guide referenced by the validation error landed in plan-01. Includes worked examples for single-runtime, multi-runtime, and per-tier-modelClass-override profiles.

### Modify
- `packages/pi-eforge/extensions/eforge/profile-payload.ts` — rewrite types and `buildProfileCreatePayload` to emit tier recipes; drop `runtimeName`, `ModelClassSelection`, `agentRuntimes`/`defaultAgentRuntime` fields.
- `packages/pi-eforge/extensions/eforge/profile-commands.ts` — rewrite `handleProfileNewCommand` (lines 310-511) and `buildYamlPreview` to walk tiers in order with preset shortcuts and copy-from-previous-tier.
- `packages/pi-eforge/extensions/eforge/index.ts`, `config-command.ts` — drop references to deleted symbols (only as needed).
- `packages/monitor-ui/src/lib/reducer.ts` — drop `agentRuntime`, add `harnessSource`. Adjust event-mapping logic.
- `packages/monitor-ui/src/components/pipeline/thread-pipeline.tsx` — render three-value provenance (`tier|role|plan`); drop `tier-config`/`role-config`/`global-config` references.
- `packages/monitor-ui/src/components/profile/profile-badge.tsx` — render tier-recipe shape.
- `eforge-plugin/skills/profile-new/profile-new.md` — vocabulary rewrite.
- `eforge-plugin/skills/profile/profile.md` — vocabulary rewrite.
- `eforge-plugin/skills/init/init.md` — vocabulary rewrite.
- `eforge-plugin/skills/config/config.md` — vocabulary rewrite.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — vocabulary rewrite mirroring `eforge-plugin/skills/profile-new/profile-new.md`.
- `packages/pi-eforge/skills/eforge-profile/SKILL.md` — vocabulary rewrite.
- `packages/pi-eforge/skills/eforge-config/SKILL.md` — vocabulary rewrite.
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — vocabulary rewrite.
- `docs/config.md` — agents section rewrite.
- `README.md` — configuration example update.
- `test/profile-payload.test.ts` — rewrite around new `buildProfileCreatePayload` shape.
- `test/profile-wiring.test.ts` — update only if it references the legacy payload shape.
- `test/monitor-reducer.test.ts` — drop `agentRuntime` assertions, add `harness`/`harnessSource` assertions.

## Verification

- [ ] `pnpm type-check` exits with status 0.
- [ ] `pnpm test` exits with status 0.
- [ ] `buildProfileCreatePayload({ name, scope, tiers: { ... } })` returns an object whose top-level keys are exactly `name`, `scope`, `agents`, with `agents` containing only `tiers` (no `agentRuntimes`, no `defaultAgentRuntime`, no `agents.models`).
- [ ] Running `/eforge:profile:new <name>` end-to-end (manual or via test driver) walks planning → implementation → review → evaluation and writes a YAML file that parses against the engine schema.
- [ ] `grep -R "agentRuntimes\|defaultAgentRuntime\|agents.models\|tier-config\|role-config\|global-config" packages/pi-eforge packages/monitor-ui eforge-plugin/skills docs README.md` returns zero matches outside `docs/config-migration.md`.
- [ ] `docs/config-migration.md` exists and contains at least one worked example for each of: single-runtime legacy profile, multi-runtime legacy profile, per-tier-modelClass legacy profile.
- [ ] The validation error string from plan-01 (`See docs/config-migration.md`) matches the actual file path created in this plan.
- [ ] The monitor UI reducer no longer carries the field `agentRuntime`; it carries `harness` and `harnessSource`.
- [ ] The pipeline component renders source labels using exactly the strings `tier`, `role`, or `plan` for `effortSource`, `thinkingSource`, `tierSource`, `harnessSource`, `modelSource`.
- [ ] No skill or doc file under `eforge-plugin/skills/`, `packages/pi-eforge/skills/`, or `docs/` references `agentRuntimes`, `defaultAgentRuntime`, or `agents.models` outside `docs/config-migration.md`.
