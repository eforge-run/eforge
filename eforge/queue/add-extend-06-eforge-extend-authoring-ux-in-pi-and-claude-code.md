---
title: Add EXTEND_06 `/eforge:extend` authoring UX in Pi and Claude Code
created: 2026-05-16
profile: pi-codex-5-5
---

# Add EXTEND_06 `/eforge:extend` authoring UX in Pi and Claude Code

## Problem / Motivation

eforge has native extension tooling (`eforge_extension` MCP/Pi tool and CLI/API surface) and extension docs/examples, but users do not yet have an assisted `/eforge:extend` workflow in either consumer integration.

Affected users are Pi and Claude Code users who want to author eforge TypeScript extensions from a natural-language request without manually discovering docs, scopes, templates, validation commands, and reload behavior.

EXTEND_06 is the next epic in the TypeScript extensibility roadmap. Dependencies for extension SDK, loader/runtime, management MVP, docs/examples, and validation/replay tooling are represented as completed/available context: docs and code show `eforge_extension` supports `new`, `validate`, `test`, and `reload`, and docs/examples describe supported runtime capabilities.

Important constraint: the authoring UX must not imply runtime support for deferred extension families. Current docs state policy gates, input sources, reviewer perspectives, and validation providers are registration-captured but runtime-deferred. The skill should disclose that clearly when user intent maps to those APIs.

### Evidence and context

- `docs/prd/typescript-extensibility.md` defines EXTEND_06 as the assisted `/eforge:extend` authoring UX, after extension management/validation/replay tooling. It says both `packages/pi-eforge/` and `eforge-plugin/` should expose an assisted command/skill that classifies the desired extension, reads bundled docs/examples, chooses scope, scaffolds, validates, optionally tests, reloads/restarts, and summarizes installed behavior.
- Schaake OS epic `73d322fc-d803-4ff8-a092-a561c4aaa635` is in progress, high priority, and acceptance criteria require Pi `/eforge:extend`, an equivalent Claude Code plugin skill, reading docs/examples before authoring, project-local default scope for experiments, scaffold/validate/optional-test/reload, and parity between consumer surfaces.
- `AGENTS.md` requires consumer-facing changes to keep `eforge-plugin/` and `packages/pi-eforge/` in sync, to bump `eforge-plugin/.claude-plugin/plugin.json` when changing the plugin, and to avoid bumping `packages/pi-eforge/package.json`.
- `docs/roadmap.md` lists Native TypeScript extensions, including `/eforge:extend`, as the active extensibility roadmap item.
- `docs/extensions.md`, `docs/extensions-api.md`, `examples/extensions/README.md`, and `packages/extension-sdk/README.md` show current runtime support: event hooks, agent-run prompt/tool augmentation, custom tool injection via `onAgentRun`, and profile routers are runtime-supported; policy gates/input/reviewer/validation provider registrations are loader-captured but runtime-deferred.
- `packages/pi-eforge/extensions/eforge/index.ts` already exposes the `eforge_extension` Pi tool with `list/show/validate/test/new/reload`, and command aliases map `/eforge:*` to `/skill:eforge-*` for existing skills.
- `packages/eforge/src/cli/mcp-proxy.ts` already exposes matching `eforge_extension` MCP tooling for Claude Code.
- `eforge-plugin/.claude-plugin/plugin.json` currently lists build/status/config/update/restart/init/profile/profile-new/plan/playbook/recover commands, but not extend.
- `packages/pi-eforge/skills/` and `eforge-plugin/skills/` hold paired skill files. `scripts/check-skill-parity.mjs` and `packages/docs-gen/src/generators/tools.ts` contain explicit skill-pair lists that must be extended.
- `test/extension-tooling-wiring.test.ts` already guards MCP/Pi `eforge_extension` tool parity. `test/profile-wiring.test.ts`, `test/skills-docs-wiring.test.ts`, and `test/reference-content.test.ts` show existing patterns for manifest, skill, and docs wiring tests.

Classification: this is a **feature / focused** change with high confidence. It adds a new user-facing authoring workflow across existing consumer integrations without changing extension runtime architecture.

## Goal

Add an assisted `/eforge:extend` authoring workflow for both Pi and Claude Code that helps users classify, scaffold, edit, validate, optionally test, reload, and summarize TypeScript extensions using the existing `eforge_extension` tooling and canonical docs/examples.

## Approach

Implement `/eforge:extend` as paired conversational skills, not a new daemon/runtime command.

### Key design decisions

1. **Use paired conversational skills, not a new daemon/runtime command.**
   - Implement `/eforge:extend` as a skill in both consumer integrations, with Pi registering a command alias that forwards to `/skill:eforge-extend`.
   - Rationale: extension authoring requires agent reasoning, code reading, and file editing. Existing `/eforge:plan` and `/eforge:playbook create/edit` patterns already use skills for conversational workflows.

2. **Keep the skill workflow parity-first.**
   - Author the Pi and Claude Code skill bodies with matching narrative and update `scripts/check-skill-parity.mjs`.
   - Rationale: `AGENTS.md` requires consumer-facing parity. Existing parity script normalizes MCP names and `/eforge:*` references, so one workflow can serve both surfaces with minimal platform-specific differences.

3. **Make docs/examples reading an explicit first-class workflow step.**
   - The skill must instruct agents to read `docs/extensions.md`, `docs/extensions-api.md`, `examples/extensions/README.md`, and relevant example files before scaffolding or editing.
   - Rationale: the epic acceptance criteria require this, and extension API support varies by capability family.

4. **Classify requested behavior before scaffolding.**
   - The skill flow should map user intent to supported capability families:
     - Runtime-supported: `onEvent`, `onAgentRun` prompt context, extension-contributed tools, and profile routers.
     - Runtime-deferred unless current docs say otherwise: policy/input/reviewer/validation APIs.
   - Rationale: prevents generated extensions from promising behavior that will only be loader-captured.

5. **Default to project-local scope.**
   - Use `eforge_extension { action: "new", scope: "local" }` unless the user explicitly asks for user-wide or team-shared behavior.
   - Rationale: docs identify project-local `.eforge/extensions/` as trusted and recommended for experiments. Project/team extensions require explicit trust and should not be the default.

6. **Scaffold first, then edit.**
   - Call `eforge_extension new` with a generated kebab-case name and likely template:
     - `event-logger` for event-oriented extensions.
     - `blank` for non-event/complex extensions.
   - Then edit the created file.
   - Rationale: reuses daemon-owned path/scope/template behavior and avoids hard-coded filesystem assumptions.

7. **Validate, optionally test, then reload.**
   - Validation is mandatory after editing.
   - Event replay testing is optional and should be offered or run when safe/appropriate.
   - Reload only after validation succeeds.
   - Rationale: `eforge extension test` executes matching event handlers and may have side effects; docs warn it is code execution. Reloading invalid code would degrade daemon extension state.

8. **Security/trust must be visible in the final UX.**
   - The skill summary should remind users that extensions are unsandboxed, project/team scope needs trust, and secrets/webhooks should come from env vars rather than committed code.
   - Rationale: docs emphasize arbitrary TypeScript execution and trust constraints.

9. **Do not add a native Pi overlay in this epic.**
   - A Pi command alias is enough for `/eforge:extend`; rich overlay can be a future enhancement.
   - Rationale: acceptance asks for an authoring workflow, not a custom TUI. Avoid broadening scope beyond parity with Claude Code.

### Expected code impact

- `eforge-plugin/skills/extend/extend.md`
  - New Claude Code skill.
  - Existing plugin skills live under `eforge-plugin/skills/<name>/<name>.md`; `eforge-plugin/skills/plan/plan.md` and `playbook/playbook.md` provide structured workflow patterns.

- `packages/pi-eforge/skills/eforge-extend/SKILL.md`
  - New Pi skill.
  - Existing Pi skills live under `packages/pi-eforge/skills/eforge-*/SKILL.md`; conversational skills like plan/playbook do not set `disable-model-invocation: true` because they require agent reasoning.

- `eforge-plugin/.claude-plugin/plugin.json`
  - Add `./skills/extend/extend.md`.
  - Bump the plugin version.
  - `AGENTS.md` explicitly requires a plugin version bump for plugin changes.
  - Do **not** bump `packages/pi-eforge/package.json`.

- `packages/pi-eforge/extensions/eforge/index.ts`
  - Add `eforge:extend` to the `skillCommands` alias list near existing `eforge:plan`, `eforge:status`, etc.
  - Evidence: current code maps command names to `/skill:eforge-*` by iterating `skillCommands`.

- `scripts/check-skill-parity.mjs`
  - Add `{ plugin: "extend", pi: "eforge-extend" }` to `SKILL_PAIRS` so the new skill is parity-checked.

- `packages/docs-gen/src/generators/tools.ts`
  - Add the same pair to `SKILL_PAIRS_CONFIG` so generated tool/skill reference includes `/eforge:extend`.

- `packages/pi-eforge/README.md`
  - Add `/eforge:extend` to the package capability list.

- Generated docs under `web/content/reference/tools.md` and `web/public/reference/tools.md` may update when `pnpm docs:generate` runs, because the docs generator consumes the skill-pair list.

- Tests:
  - Add a focused test file such as `test/extension-authoring-skill.test.ts` or extend an existing wiring test.
  - Cover skill file existence/frontmatter, manifest entry, Pi command alias, parity-list entries, workflow references to docs/examples and `eforge_extension` actions.

### Existing tooling to reuse

- `packages/pi-eforge/extensions/eforge/index.ts` and `packages/eforge/src/cli/mcp-proxy.ts` expose the `eforge_extension` tool with actions `list`, `show`, `validate`, `test`, `new`, and `reload`.
- `docs/extensions.md`, `docs/extensions-api.md`, `examples/extensions/README.md`, and `examples/extensions/*.ts` provide the canonical authoring sources the skills should instruct agents to read.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| A paired skill implementation is sufficient for EXTEND_06; no new daemon endpoint is needed. | Epic acceptance criteria focuses on Pi/Claude Code authoring UX. Existing `eforge_extension` tool already exposes `new`, `validate`, `test`, and `reload` in both MCP and Pi surfaces. | High | Low | Build can verify by authoring skills that call existing tools and running wiring tests. | If wrong, scope expands to daemon/client API work, but current code evidence suggests this is unnecessary. |
| Pi can expose `/eforge:extend` via the existing `skillCommands` alias mechanism. | `packages/pi-eforge/extensions/eforge/index.ts` currently registers aliases for `eforge:status`, `eforge:init`, `eforge:plan`, etc. by forwarding to `/skill:eforge-*`. | High | Low | Add the alias and test source contains `name: "eforge:extend"`/`skill: "eforge-extend"` or equivalent. | If wrong, a native command handler may be needed; still small. |
| Policy gates/input/reviewer/validation APIs should be treated as runtime-deferred in the authoring UX. | `docs/extensions.md`, `docs/extensions-api.md`, `examples/extensions/README.md`, and `packages/extension-sdk/README.md` explicitly state these registrations are captured but runtime execution is deferred, while event, agent, tools, and profile-router paths are runtime-supported. | High | Low | Re-read docs during implementation and keep skill text aligned. | If wrong due to newer runtime support, the skill may be overly conservative; update docs-driven capability table. |
| Existing parity tooling should be extended rather than replaced. | `scripts/check-skill-parity.mjs` and `packages/docs-gen/src/generators/tools.ts` both contain explicit skill-pair lists. | High | Low | Add the pair and run `node scripts/check-skill-parity.mjs` and docs generation/check. | If omitted, new skill may drift from plugin/Pi parity or docs reference may omit it. |
| Generated docs need to change after adding the skill pair. | `packages/docs-gen/src/generators/tools.ts` generates the skill surfaces table from `SKILL_PAIRS_CONFIG`. | Medium | Low | Run `pnpm docs:generate` and inspect changed files. | If not regenerated, `pnpm docs:check` may fail or public reference may omit `/eforge:extend`. |
| The plugin version should be bumped, but the Pi package version should not. | `AGENTS.md` states both rules explicitly. | High | Low | Inspect diffs before completion. | If violated, release/versioning conventions break. |

No low-confidence/high-impact assumptions remain. All material implementation assumptions are backed by direct file reads or project conventions and have low-cost validation paths.

### Recommended eforge profile

Recommended profile: **Excursion**.

Rationale: this is a cohesive multi-file consumer-integration feature. It touches both integration packages, parity scripts, docs generation, and tests, but a single planner can enumerate the file changes and dependencies without delegating separate module planners. It is not trivial enough for Errand because parity, docs generation, plugin versioning, and deferred-runtime caveats need careful handling. It does not require Expedition because it does not alter daemon/runtime architecture or require independently planned subprojects.

## Scope

### In scope

- Add a Claude Code plugin skill for `/eforge:extend` under `eforge-plugin/skills/extend/extend.md`.
- Add a Pi skill for `/eforge:extend` under `packages/pi-eforge/skills/eforge-extend/SKILL.md`.
- Register the Claude Code skill in `eforge-plugin/.claude-plugin/plugin.json` and bump the plugin version per `AGENTS.md`.
- Register a Pi `/eforge:extend` command alias in `packages/pi-eforge/extensions/eforge/index.ts` that forwards to `/skill:eforge-extend`, matching existing command-alias patterns.
- Update skill parity lists in `scripts/check-skill-parity.mjs` and `packages/docs-gen/src/generators/tools.ts`.
- Update user-facing package/reference docs that enumerate available skills, at minimum `packages/pi-eforge/README.md`; generated tools reference after docs generation.
- Add tests that verify both skills exist, the plugin manifest includes the new command, the Pi command alias exists, parity lists include the new pair, and the skill workflow requires docs/examples reading plus scaffold/validate/test/reload behavior.

### Out of scope

- Adding new extension runtime hooks or changing extension SDK APIs.
- Implementing `enable`, `disable`, `promote`, or `demote` extension workflows, which current docs explicitly defer.
- Implementing runtime enforcement for policy gates/input sources/reviewer perspectives/validation providers.
- Building a native interactive Pi overlay for extension authoring. A command alias to the conversational skill is sufficient for this epic; richer UI can follow later.
- Changing daemon/client `eforge_extension` API behavior, unless tests reveal a small compatibility issue.

Natural boundary: this is a consumer-integration authoring workflow over existing extension management tools, not an engine/runtime change.

## Acceptance Criteria

- `/eforge:extend` is available in Pi via `packages/pi-eforge` and forwards to the new `eforge-extend` skill.
- `/eforge:extend` is available in the Claude Code plugin via `eforge-plugin/.claude-plugin/plugin.json` and the new `eforge-plugin/skills/extend/extend.md` skill.
- The Pi and Claude Code skill bodies remain parity-checked by `scripts/check-skill-parity.mjs`, with only legitimate platform-specific frontmatter/skip differences.
- The skill workflow instructs the agent to read `docs/extensions.md`, `docs/extensions-api.md`, `examples/extensions/README.md`, and relevant `examples/extensions/*.ts` before authoring.
- The workflow defaults new experimental extensions to project-local scope (`scope: local` -> `.eforge/extensions/`) unless the user explicitly wants user or project/team scope.
- The workflow scaffolds via `eforge_extension` action `new`, edits generated files with normal file tools, validates via `eforge_extension` action `validate`, optionally dry-runs event hooks via action `test`, and reloads via action `reload` after successful validation.
- The workflow distinguishes runtime-supported APIs from deferred registrations and warns users when a requested behavior cannot currently execute at runtime.
- The final user summary reports the extension name, scope/path, validation/test/reload result, any skipped optional test reason, security/trust notes, and follow-up modification instructions.
- Tests cover manifest/command/skill wiring and key workflow requirements. Existing extension tooling parity tests continue to pass.
- `pnpm docs:generate`/`pnpm docs:check` are accounted for if generated tools reference content changes.

### Validation commands

```bash
node scripts/check-skill-parity.mjs
pnpm test -- test/extension-authoring-skill.test.ts test/extension-tooling-wiring.test.ts
pnpm docs:generate
pnpm docs:check
pnpm type-check
```

Use `pnpm docs:generate` followed by `pnpm docs:check` if generated reference docs change. Use `pnpm type-check` if TypeScript command alias changes are non-trivial.
