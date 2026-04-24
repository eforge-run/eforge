---
id: plan-01-schema-resolver
name: Config Schema + Resolver (Non-Breaking Additions)
depends_on: []
branch: per-agent-runtime-configuration-harness-model/schema-resolver
agents:
  builder:
    effort: high
    rationale: Zod schema cross-field refinements and resolver precedence logic have
      non-trivial interactions; per-role provider-ness validation moves from
      schema-time to resolve-time and needs careful wiring.
  reviewer:
    effort: high
    rationale: Schema changes are the foundation for every downstream plan; reviewer
      must catch subtle refinement gaps (e.g. cross-kind sub-blocks, dangling
      refs, provenance in error messages).
---

# Config Schema + Resolver (Non-Breaking Additions)

## Architecture Context

This is step 1-2 of the PRD's 9-step ordered implementation. It adds the new `agentRuntimes` + `defaultAgentRuntime` + `agents.roles.*.agentRuntime` schema shape and the new resolver (`resolveAgentRuntimeForRole`) without removing the legacy scalar `backend:` / top-level `pi:` / top-level `claudeSdk:` shape. The two shapes **coexist** in this plan so the tree stays green and subsequent plans can migrate call sites incrementally.

Reference files (from exploration):
- `packages/engine/src/config.ts` — `backendSchema` at ~L113; top-level `pi` / `claudeSdk` at ~L189-190; profile loader at ~L748-1073.
- `packages/engine/src/pipeline/agent-config.ts` — `resolveAgentConfig` at ~L274 currently takes `backend?: 'claude-sdk' | 'pi'`.
- `MODEL_CLASS_DEFAULTS` at ~L74-85 is keyed by harness kind; `AGENT_MODEL_CLASSES` at ~L47-71 is per-role and unchanged.
- `EforgeConfig` type is exported from `config.ts`.

## Implementation

### Overview

Add schema + types for the new shape, add the new resolver function, rewire `resolveAgentConfig` to derive harness kind internally from the role's agentRuntime, and add new fields to `ResolvedAgentConfig`. Keep the legacy scalar `backend` shape accepted by the schema so existing configs and tests still parse. The 14 existing callers of `resolveAgentConfig` (count per PRD) are updated to drop the harness-kind argument; in this plan, `resolveAgentRuntimeForRole` is allowed to fall back to the legacy `config.backend` scalar when no `agentRuntimes` are declared, so no behavior changes for existing configs yet.

### Key Decisions

1. **Coexistence, not cutover.** Legacy `backend:` scalar remains valid in this plan; it is only rejected later (plan-04). This is the only way to keep builds green across the 14 call-site rewrites.
2. **`resolveAgentRuntimeForRole` handles both shapes.** When `config.agentRuntimes` is absent/empty, it synthesizes a single entry named after the legacy `config.backend` value (e.g. `"claude-sdk"`) so every role resolves cleanly. When `agentRuntimes` is present, it uses the PRD-specified precedence: plan-entry override (wired in plan-04) > role > `defaultAgentRuntime`.
3. **Provider-ness validation moves to resolve time.** Schema no longer fails on `{ id: 'claude-opus-4-7' }` globally; it fails only when a role resolves to `harness: pi` while the role's `ModelRef` lacks `provider`. Error messages include provenance: which role, which resolved `agentRuntime`, where the `ModelRef` came from (`agents.model` / `agents.models.*` / `agents.roles.*.model`).
4. **`ResolvedAgentConfig` gains `agentRuntimeName: string` and `harness: 'claude-sdk' | 'pi'`.** These are read by events/monitor in plan-04 but are added here so callers compile against the new shape immediately.

## Scope

### In Scope
- `harnessSchema = z.enum(['claude-sdk', 'pi'])` added as an alias/new name alongside existing `backendSchema` (keep both exported from `config.ts` for this plan; `backendSchema` removed in plan-04).
- `agentRuntimeEntrySchema` with `superRefine` rejecting cross-kind sub-blocks (`harness: pi` + `claudeSdk: {...}` and vice versa).
- Top-level `agentRuntimes: z.record(z.string(), agentRuntimeEntrySchema).optional()` and `defaultAgentRuntime: z.string().optional()`.
- `agents.roles.*` gains `agentRuntime: z.string().optional()`.
- Cross-field refinements: `defaultAgentRuntime` must reference an existing `agentRuntimes` entry; every `agents.roles.*.agentRuntime` must reference an existing entry; when `agentRuntimes` is present, `defaultAgentRuntime` is required.
- Move global `ModelRef` provider-ness check from schema-time to resolve-time; per-role validation in the resolver.
- New `resolveAgentRuntimeForRole(role, config, planEntry?)` in `packages/engine/src/pipeline/agent-config.ts`. Plan-entry plumbing param is accepted but unused in this plan (wired in plan-04).
- `resolveAgentConfig(role, config, planEntry?)` drops its third `backend` parameter; derives harness via the new resolver. All 14 caller sites in the repo updated (identified in `eforge.ts`, `gap-closer.ts`, `compile-stages.ts`, `build-stages.ts`, `agent-config.ts`).
- `ResolvedAgentConfig` gains `agentRuntimeName: string` and `harness: 'claude-sdk' | 'pi'`.
- Legacy-fallback behavior in the resolver: if `config.agentRuntimes` is undefined or empty, synthesize a single implicit entry keyed by the legacy `config.backend` scalar.
- Unit tests covering precedence, dangling-ref errors, and the legacy-fallback path.

### Out of Scope
- Removing `backendSchema`, scalar `backend:`, top-level `pi:` / `claudeSdk:` (plan-04).
- `AgentRuntimeRegistry`, `singletonRegistry` (plan-02).
- Engine / pipeline / stage-callsite wiring for `ctx.agentRuntimes` (plan-02).
- Plan-file `agentRuntime?` field and event-field changes (plan-04).
- Profile directory/MCP/HTTP renames (plan-05).
- Monitor UI updates (plan-04).

## Files

### Create
- `packages/engine/test/agent-config.resolution.test.ts` — unit tests for `resolveAgentRuntimeForRole` (plan > role > default precedence once plan-04 wires plan input; in this plan the test exercises role > default + dangling refs), plus per-role provider-ness validation at resolve time.
- `packages/engine/test/agent-config.mixed-harness.test.ts` — config with planner on `claude-sdk` and builder on `pi`; each role resolves to the correct class-defaults entry in `MODEL_CLASS_DEFAULTS`.
- `packages/engine/test/config.agent-runtimes.schema.test.ts` — Zod schema tests: cross-kind sub-block rejection, `defaultAgentRuntime` required when `agentRuntimes` present, dangling `agentRuntime` refs on roles rejected, `defaultAgentRuntime` pointing at missing entry rejected.

### Modify
- `packages/engine/src/config.ts` — add `harnessSchema`, `agentRuntimeEntrySchema`, top-level `agentRuntimes` and `defaultAgentRuntime`, per-role `agentRuntime`, cross-field refinements. Remove schema-time provider-ness check from global `agents.model` / `agents.models.*` (move to resolve-time). Keep `backendSchema`, scalar `backend:`, top-level `pi:` / `claudeSdk:` accepted for now. Export `EforgeConfig` with the new optional fields.
- `packages/engine/src/pipeline/agent-config.ts` — add `resolveAgentRuntimeForRole`; change `resolveAgentConfig` signature to `(role, config, planEntry?)` (drops harness-kind param); add `agentRuntimeName` + `harness` to `ResolvedAgentConfig`; add per-role provider-ness validation with provenance error messages; add legacy-fallback path when `agentRuntimes` is absent.
- `packages/engine/src/eforge.ts` — update 7 `resolveAgentConfig` call sites to drop the harness-kind argument (PRD L377, 412, 595, 629, 688, 727, 884 plus one in `create()`).
- `packages/engine/src/agents/gap-closer.ts` — update 1 `resolveAgentConfig` call site.
- `packages/engine/src/pipeline/stages/compile-stages.ts` — update all `resolveAgentConfig` call sites (16 occurrences via grep).
- `packages/engine/src/pipeline/stages/build-stages.ts` — update all `resolveAgentConfig` call sites (14 occurrences via grep).

## Verification

- [ ] `pnpm type-check` passes.
- [ ] `pnpm test` passes; new tests in `agent-config.resolution.test.ts`, `agent-config.mixed-harness.test.ts`, `config.agent-runtimes.schema.test.ts` all green.
- [ ] `pnpm build` produces `packages/eforge/dist/cli.js`.
- [ ] Loading a legacy config that declares only `backend: claude-sdk` (no `agentRuntimes`) resolves every role to `{ agentRuntimeName: 'claude-sdk', harness: 'claude-sdk' }` via the fallback path.
- [ ] Loading a config with `agentRuntimes: { opus: { harness: 'claude-sdk' }, pi-openrouter: { harness: 'pi', pi: {...} } }` and `defaultAgentRuntime: opus` + `agents.roles.builder.agentRuntime: pi-openrouter` resolves planner to `{ agentRuntimeName: 'opus', harness: 'claude-sdk' }` and builder to `{ agentRuntimeName: 'pi-openrouter', harness: 'pi' }`.
- [ ] Config with `agentRuntimes: { a: { harness: 'pi', claudeSdk: {...} } }` fails Zod parsing with a message naming the offending entry and the cross-kind conflict.
- [ ] Config with `agents.roles.builder.agentRuntime: 'ghost'` (not declared in `agentRuntimes`) fails Zod parsing with a message naming the role and the dangling reference.
- [ ] Config where `agents.model: { id: 'claude-opus-4-7' }` (no provider) with `harness: pi` resolved for some role fails at resolve time with a message that names the role, the resolved `agentRuntimeName`, and `agents.model` as the ref's provenance.
- [ ] `ResolvedAgentConfig` exposes `agentRuntimeName: string` and `harness: 'claude-sdk' | 'pi'` and both are populated at every call site.
