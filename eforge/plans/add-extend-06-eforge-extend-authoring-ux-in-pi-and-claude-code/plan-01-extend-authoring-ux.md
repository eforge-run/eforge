---
id: plan-01-extend-authoring-ux
name: Add /eforge:extend authoring skills and wiring
branch: add-extend-06-eforge-extend-authoring-ux-in-pi-and-claude-code/plan-01-extend-authoring-ux
agents:
  builder:
    effort: high
    rationale: The implementation is not architecturally broad, but the paired skill
      bodies must encode nuanced extension runtime/deferred capability guidance
      while remaining parity-normalized across plugin and Pi surfaces.
  reviewer:
    effort: high
    rationale: Review needs to verify parity, generated docs, tests, plugin
      versioning, and security/trust wording for unsandboxed TypeScript
      extensions.
---

# Add /eforge:extend authoring skills and wiring

## Architecture Context

This plan adds a consumer-facing authoring workflow over the existing native extension tooling. The extension runtime, SDK, daemon API, CLI, MCP proxy, and Pi `eforge_extension` tool already expose the needed actions (`new`, `validate`, `test`, `reload`, plus inspection actions). The new UX must be implemented as paired conversational skills, not as a daemon/runtime feature.

Important project constraints:

- Keep `eforge-plugin/` and `packages/pi-eforge/` in sync for user-facing behavior.
- Bump `eforge-plugin/.claude-plugin/plugin.json` for any plugin change.
- Do not bump `packages/pi-eforge/package.json`.
- Keep provider SDK imports out of non-harness packages; this plan does not need provider SDK imports.
- Use existing `eforge_extension` MCP/Pi tooling; do not add new daemon routes or extension runtime APIs.
- Generated tools reference files under `web/content/reference/tools.md` and `web/public/reference/tools.md` are produced by `pnpm docs:generate`.

## Implementation

### Overview

Create a new `/eforge:extend` conversational skill in both consumer integrations. Register it in the Claude Code plugin manifest, add a Pi command alias that forwards to `/skill:eforge-extend`, extend the explicit skill parity lists, update user-facing docs that enumerate skills, regenerate generated reference docs, and add static wiring tests for the new workflow.

### Key Decisions

1. **Skill-based authoring workflow** — Add paired skills rather than daemon or runtime commands. Extension authoring requires reading docs/examples, classifying intent, editing code, validating, optionally replay-testing, and summarizing results.
2. **Parity-first skill text** — Author one narrative and translate only platform-specific tool names (`mcp__eforge__eforge_extension` in the Claude Code plugin, `eforge_extension` in Pi). `scripts/check-skill-parity.mjs` normalization must pass without broad skip blocks.
3. **Docs/examples reading before scaffolding** — The skills must direct agents to read `docs/extensions.md`, `docs/extensions-api.md`, `examples/extensions/README.md`, and relevant `examples/extensions/*.ts` files before scaffolding or editing.
4. **Explicit capability classification** — The skills must distinguish runtime-supported APIs (`onEvent`, `onAgentRun`, per-run extension tool injection via `onAgentRun`, and `registerProfileRouter`) from runtime-deferred registration families (`beforePlanMerge`, `registerInputSource`, `registerReviewerPerspective`, `registerValidationProvider`). `registerTool` alone is provenance capture; runtime tool injection requires returning the tool from `onAgentRun`.
5. **Project-local default** — New experimental extensions default to `scope: "local"` (`.eforge/extensions/`) unless the user explicitly requests user-wide or project/team behavior.
6. **Scaffold-first flow** — The workflow uses `eforge_extension` action `new` with a generated kebab-case name and `event-logger` for event-oriented requests or `blank` for non-event/complex requests, then edits the returned file path with normal file tools.
7. **Validate before reload** — The workflow validates after editing and reloads only after validation returns `valid: true`. Event replay testing is optional because matching event handlers execute code in the daemon process.
8. **Visible trust and secret handling** — The final skill summary must mention that extensions are unsandboxed, project/team scope requires explicit trust, and tokens/webhooks/secrets belong in environment variables rather than committed source.

## Scope

### In Scope

- Create the Claude Code plugin skill at `eforge-plugin/skills/extend/extend.md`.
- Create the Pi skill at `packages/pi-eforge/skills/eforge-extend/SKILL.md`.
- Register the plugin skill in `eforge-plugin/.claude-plugin/plugin.json` and bump the plugin patch version from the current version.
- Add a Pi `/eforge:extend` command alias in `packages/pi-eforge/extensions/eforge/index.ts` using the existing `skillCommands` forwarding loop.
- Add `{ plugin: "extend", pi: "eforge-extend" }` to `scripts/check-skill-parity.mjs` and `packages/docs-gen/src/generators/tools.ts`.
- Update `packages/pi-eforge/README.md` to list `/eforge:extend` among provided skills/commands.
- Regenerate generated tools reference files so the Skill surfaces table includes `extend` / `eforge-extend`.
- Add a focused static test file for skill, manifest, command alias, docs-generator, parity-list, generated-reference, and workflow-content wiring.

### Out of Scope

- New extension runtime hooks or SDK APIs.
- Runtime enforcement for deferred extension families: policy gates, input sources, reviewer perspectives, or validation providers.
- `enable`, `disable`, `promote`, or `demote` extension management workflows.
- A native Pi overlay for extension authoring.
- New daemon routes, client helpers, MCP tools, or Pi tools.
- A `packages/pi-eforge/package.json` version bump.
- Roadmap pruning; the broader Native TypeScript extensions roadmap item remains active because deferred runtime families still exist.

## Files

### Create

- `eforge-plugin/skills/extend/extend.md` — Claude Code `/eforge:extend` skill.
- `packages/pi-eforge/skills/eforge-extend/SKILL.md` — Pi `eforge-extend` skill.
- `test/extension-authoring-skill.test.ts` — Static tests for the new authoring skill and wiring.

### Modify

- `eforge-plugin/.claude-plugin/plugin.json` — Add `./skills/extend/extend.md` to `commands` and bump the plugin patch version.
- `packages/pi-eforge/extensions/eforge/index.ts` — Add `eforge:extend` to `skillCommands` with `skill: "eforge-extend"`.
- `scripts/check-skill-parity.mjs` — Add the `extend` / `eforge-extend` pair and update the pair-count comment.
- `packages/docs-gen/src/generators/tools.ts` — Add the same pair to `SKILL_PAIRS_CONFIG`.
- `packages/pi-eforge/README.md` — List `/eforge:extend` as an assisted extension-authoring skill.
- `web/content/reference/tools.md` — Regenerate via `pnpm docs:generate`; Skill surfaces table gains `extend`.
- `web/public/reference/tools.md` — Regenerate via `pnpm docs:generate`; mirrors the generated content reference.
- `test/extension-tooling-wiring.test.ts` — Modify only if the new focused test reveals stale extension-authoring assertions that conflict with the shipped `/eforge:extend` surface.

## Skill Content Requirements

Both skill bodies must describe the same workflow after parity normalization.

### Frontmatter

Claude Code plugin skill:

```yaml
---
description: Author eforge TypeScript extensions from a natural-language request using the existing extension tooling and docs/examples
argument-hint: "[extension request]"
---
```

Pi skill:

```yaml
---
name: eforge-extend
description: Author eforge TypeScript extensions from a natural-language request using the existing extension tooling and docs/examples
---
```

Do not set `disable-model-invocation: true`; the skill requires conversational reasoning and file editing.

### Workflow sections to include

1. **Argument intake**
   - If the request is missing, ask what eforge behavior the user wants to add.
   - Generate a kebab-case extension name from the request and ask only when the name is ambiguous or conflicts with an existing extension.

2. **Required context read**
   - Before scaffolding or editing, read:
     - `docs/extensions.md`
     - `docs/extensions-api.md`
     - `examples/extensions/README.md`
   - Read relevant examples based on the classified capability:
     - `examples/extensions/minimal-event-logger.ts` for event hooks.
     - `examples/extensions/slack-webhook-notifier.ts` for webhook/notification hooks.
     - `examples/extensions/agent-context.ts` for prompt context.
     - `examples/extensions/agent-tools.ts` for custom agent tools.
     - `examples/extensions/profile-router.ts` for profile selection.
     - `examples/extensions/protected-paths.ts` when explaining deferred policy gates.

3. **Capability classification**
   - Runtime-supported:
     - `onEvent` event subscriptions and event replay.
     - `onAgentRun` prompt context, per-run tools, and per-run allowed/disallowed tuning.
     - `defineExtensionTool` + `registerTool` + returning `tools` from `onAgentRun` for runtime custom tool injection.
     - `registerProfileRouter` pre-build profile selection.
   - Runtime-deferred:
     - `beforePlanMerge` policy gates.
     - `registerInputSource` input sources.
     - `registerReviewerPerspective` reviewer perspectives.
     - `registerValidationProvider` validation providers.
   - If user intent maps to deferred APIs, state that eforge can load/capture the registration for provenance and validation, but it will not execute at runtime yet. Ask whether to omit that portion or include it as a clearly labeled future-facing registration.

4. **Scope selection**
   - Default to `scope: "local"` for experiments and project-local personal behavior.
   - Use `scope: "user"` only for explicit cross-project personal extensions.
   - Use `scope: "project"` only for explicit team-shared extensions, and warn that `eforge/extensions/` is skipped unless trusted via user or project-local config.

5. **Scaffold**
   - Optionally call `eforge_extension` action `list` first to inspect existing extensions and shadowing.
   - Call action `new` with a generated `name`, selected `scope`, and `template`:
     - `event-logger` for event-driven requests.
     - `blank` for non-event or complex mixed requests.
   - Use the returned `path` for file reads/edits; do not hard-code scope paths when the tool returns a path.

6. **Edit**
   - Read the scaffolded file.
   - Apply TypeScript edits using existing docs/examples as the source of truth.
   - Use environment variables for secrets and webhooks.
   - Avoid promising that deferred capability families will block, fetch, review, or validate builds at runtime.

7. **Validate**
   - Call action `validate` by `name` or returned `path` after editing.
   - If validation returns `valid: false`, summarize diagnostics and fix before reload.
   - Do not call `reload` after failed validation.

8. **Optional test**
   - Offer event replay testing after validation.
   - Use action `test` with `name` or `path`, plus `fixture`, `run`, or `event` when the user supplies an event source.
   - Warn that replay executes matching `onEvent` handlers in the daemon process and can trigger filesystem, network, or environment side effects.
   - If no safe event source exists or the extension has side effects, skip testing and record the reason in the final summary.

9. **Reload**
   - Call action `reload` only after validation succeeds.
   - Summarize watcher fields from the response (`wasRunning`, `restarted`, `running`, `message`) when present.

10. **Final summary**
    - Report extension name, scope, returned path, selected template, and capability families used.
    - Report validation result, optional test result or skipped-test reason, and reload result.
    - Include any deferred-runtime caveats that apply to the generated extension.
    - Include security/trust notes: unsandboxed code execution, trust requirement for project/team scope, and env-var storage for secrets.
    - Include follow-up commands: validate, test with fixture/run, reload, and where to edit the file.

## Testing Requirements

Add `test/extension-authoring-skill.test.ts` with static tests that read real repository files and avoid mocks.

Required assertions:

- `eforge-plugin/skills/extend/extend.md` exists and has YAML frontmatter with a non-empty `description` and `argument-hint`.
- `packages/pi-eforge/skills/eforge-extend/SKILL.md` exists, has `name: eforge-extend`, has a non-empty `description`, and does not contain `disable-model-invocation: true`.
- The plugin manifest includes `./skills/extend/extend.md`, references only existing files, and has a version greater than the pre-change version `0.25.6`.
- The Pi `skillCommands` block contains `"eforge:extend"` and `"eforge-extend"`, and the forwarding loop still sends `/skill:` messages.
- `scripts/check-skill-parity.mjs` includes the `extend` / `eforge-extend` pair.
- `packages/docs-gen/src/generators/tools.ts` includes the same pair.
- Both skills mention the required docs paths, required examples, runtime-supported capability names, runtime-deferred capability names, `scope: "local"`, `event-logger`, `blank`, `new`, `validate`, `test`, `reload`, unsandboxed execution, project/team trust, environment variables for secrets, and final summary fields.
- The Pi skill uses bare `eforge_extension` tool names and contains no `mcp__eforge__` prefix.
- The generated tools reference files contain the Skill surfaces row for `extend` / `eforge-extend` after `pnpm docs:generate`.

Run `node scripts/check-skill-parity.mjs` as part of implementation to ensure the two skill bodies match after normalization.

## Verification

- [ ] `node scripts/check-skill-parity.mjs` exits 0 and reports the new `extend ↔ eforge-extend` pair in sync.
- [ ] `pnpm test -- test/extension-authoring-skill.test.ts test/extension-tooling-wiring.test.ts` exits 0.
- [ ] `pnpm docs:generate` updates `web/content/reference/tools.md` and `web/public/reference/tools.md` with a Skill surfaces row for `extend` / `eforge-extend`.
- [ ] `pnpm docs:check` exits 0 after generated files are committed.
- [ ] `pnpm type-check` exits 0.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is greater than `0.25.6`.
- [ ] `packages/pi-eforge/package.json` version remains unchanged.
- [ ] No new daemon routes, client helpers, MCP tools, Pi tools, SDK APIs, or runtime hooks are added.
