---
id: plan-03-policy-gate-docs-examples-skills
name: Policy Gate Documentation, Examples, and Integration Skill Updates
branch: implement-blocking-policy-gates/plan-03-policy-gate-docs-examples-skills
agents:
  builder:
    effort: medium
    rationale: Mostly documentation/example updates plus generated docs drift, with
      a plugin version bump due skill changes.
  reviewer:
    effort: high
    rationale: Docs must avoid overpromising deferred gates and must stay consistent
      across public docs, SDK README, examples, Claude plugin, and Pi skill
      surfaces.
---

# Policy Gate Documentation, Examples, and Integration Skill Updates

## Architecture Context

Plans 1 and 2 make queue dispatch, plan merge, and final merge policy gates runtime-supported. Public docs and authoring skills currently describe policy enforcement as deferred. This plan updates source docs, examples, generated web/public mirrors, and the Claude/Pi authoring skill guidance to match the shipped MVP subset while retaining explicit deferred language for enqueue, validation, approval workflow, and mutation contracts.

Changing `eforge-plugin/` requires bumping `eforge-plugin/.claude-plugin/plugin.json`. Do not bump `packages/pi-eforge/package.json`.

## Implementation

### Overview

Document the runtime-supported policy-gate subset, config fields, failure semantics, events, and deferred capabilities. Update the protected-paths example to demonstrate active enforcement. Keep Claude Code plugin and Pi skill guidance in sync.

### Key Decisions

1. Docs state that `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge` execute at runtime.
2. Docs state that `require-approval` blocks in this MVP because no approval workflow exists.
3. Docs state `beforeEnqueue`, `beforeValidation`, approval UI/state, and `modify` decisions remain deferred.
4. Docs state extensions remain trusted unsandboxed code; read-only contexts and strict decision validation do not create a sandbox.
5. Generated web/public docs and config schema are updated by running the project docs generator after source docs/config schema changes.

## Scope

### In Scope

- Public docs for supported policy-gate APIs, contexts, events, timeout, and failure policy.
- Config docs/reference for `extensions.policyGateTimeoutMs` and `extensions.policyGateFailurePolicy`.
- SDK README support table and policy gate examples.
- Examples README and `protected-paths.ts` runtime notes.
- Claude Code `/eforge:extend` skill and Pi `eforge-extend` skill guidance.
- Plugin version bump for the Claude Code plugin.
- Docs/tooling tests updated to assert policy gates are no longer described as deferred for the shipped subset.

### Out of Scope

- Roadmap changes unless implementation reveals a shipped roadmap item unrelated to this source.
- New MCP tools, CLI commands, daemon routes, or monitor UI workflows.
- Pi package version bump.

## Files

### Create

None expected.

### Modify

- `docs/extensions.md` — update extension config snippet/table, runtime support table, event replay limitations, policy gate runtime section, examples paragraph, and deferred-capability wording.
- `docs/extensions-api.md` — add `beforeQueueDispatch` and `beforeFinalMerge` API sections, update `beforePlanMerge`, context types, `PolicyDecision`, event diagnostics, config, and runtime support table.
- `docs/config.md` — document policy gate timeout and failure policy defaults and valid values.
- `packages/extension-sdk/README.md` — update capability table and policy-gate usage examples.
- `examples/extensions/README.md` — mark protected paths as runtime-supported policy enforcement for plan/final merge as implemented; keep non-shipped gates marked deferred.
- `examples/extensions/protected-paths.ts` — remove deferred enforcement warning, keep `beforePlanMerge`, and add `beforeFinalMerge` reuse if it demonstrates the same protected path policy without duplicating logic excessively.
- `eforge-plugin/skills/extend/extend.md` — replace deferred-policy guidance with supported/deferred policy-gate subset guidance.
- `eforge-plugin/.claude-plugin/plugin.json` — bump plugin version by one patch because plugin skill content changed.
- `packages/pi-eforge/skills/eforge-extend/SKILL.md` — mirror the Claude skill policy-gate guidance changes.
- `test/extension-authoring-skill.test.ts` — require both skills to mention the new policy-gate methods and supported/deferred split.
- `test/extension-tooling-wiring.test.ts` — update docs/example assertions so shipped policy gates are runtime-supported and only out-of-scope gates remain deferred.
- Generated docs/mirrors from `pnpm docs:generate`, including `web/content/docs/extensions.md`, `web/public/docs/extensions.md`, `web/content/docs/extensions-api.md`, `web/public/docs/extensions-api.md`, `web/content/docs/configuration.md`, `web/public/docs/configuration.md`, `web/content/reference/config.md`, `web/public/reference/config.md`, and `web/public/schemas/config.schema.json`.

## Verification

- [ ] `pnpm test -- test/extension-authoring-skill.test.ts test/extension-tooling-wiring.test.ts test/extension-sdk-example.test.ts` exits 0.
- [ ] `pnpm docs:generate && pnpm docs:check` exits 0.
- [ ] Public docs contain support rows for `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge` with runtime support marked as active.
- [ ] Public docs contain deferred wording for `beforeEnqueue`, `beforeValidation`, approval workflow, and `modify` decisions.
- [ ] `examples/extensions/protected-paths.ts` contains no phrase saying plan-merge enforcement remains deferred.
- [ ] Claude plugin and Pi skill files contain matching guidance for supported policy gates and unsandboxed extension trust.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` patch version is greater than the previous `0.25.7` value.
- [ ] `packages/pi-eforge/package.json` version remains unchanged.