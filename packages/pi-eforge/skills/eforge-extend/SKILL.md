---
name: eforge-extend
description: Author eforge TypeScript extensions from a natural-language request using the existing extension tooling and docs/examples
---

# /eforge:extend

Author eforge TypeScript extensions from a natural-language request using the existing extension tooling, docs, and examples. The workflow is conversational: classify the requested behavior, scaffold with `eforge_extension`, edit the returned file with normal file tools, validate, optionally replay-test, reload, and summarize trust/security notes.

## Workflow

### Step 1: Argument intake

- If `$ARGUMENTS` is missing or empty, ask what eforge behavior the user wants to add and stop until they answer.
- Generate a kebab-case extension name from the request.
- Ask for a name only when the generated name is ambiguous or conflicts with an existing extension.

### Step 2: Required context read

Before scaffolding or editing, read these required eforge docs. Prefer the repository-local paths below when they exist; in an installed consumer project where they are not present, use the same documents from https://eforge.build/docs/extensions, https://eforge.build/docs/extensions-api, and https://github.com/eforge-build/eforge/tree/main/examples/extensions.

- `docs/extensions.md`
- `docs/extensions-api.md`
- `examples/extensions/README.md`

Then read relevant examples based on the classified capability:

- `examples/extensions/minimal-event-logger.ts` for event hooks.
- `examples/extensions/slack-webhook-notifier.ts` for webhook/notification hooks.
- `examples/extensions/agent-context.ts` for prompt context.
- `examples/extensions/agent-tools.ts` for custom agent tools.
- `examples/extensions/profile-router.ts` for profile selection.
- `examples/extensions/protected-paths.ts` when explaining deferred policy gates.

### Step 3: Capability classification

Classify the requested behavior before choosing a template or editing code.

Runtime-supported capability families:

- `onEvent` event subscriptions and event replay.
- `onAgentRun` prompt context, per-run tools, and per-run allowed/disallowed tuning.
- `defineExtensionTool` + `registerTool` + returning `tools` from `onAgentRun` for runtime custom tool injection. `registerTool` alone is provenance capture; runtime tool injection requires returning the tool from `onAgentRun`.
- `registerProfileRouter` pre-build profile selection.

Runtime-deferred capability families:

- `beforePlanMerge` policy gates.
- `registerInputSource` input sources.
- `registerReviewerPerspective` reviewer perspectives.
- `registerValidationProvider` validation providers.

If user intent maps to deferred APIs, state that eforge can load/capture the registration for provenance and validation, but it will not execute at runtime yet. Ask whether to omit that portion or include it as a clearly labeled future-facing registration. Avoid promising that deferred capability families will block, fetch, review, or validate builds at runtime.

### Step 4: Scope selection

- Default to `scope: "local"` for experiments and project-local personal behavior; this targets `.eforge/extensions/`.
- Use `scope: "user"` only for explicit cross-project personal extensions.
- Use `scope: "project"` only for explicit team-shared extensions, and warn that `eforge/extensions/` is skipped unless trusted via user or project-local config.

### Step 5: Scaffold

- Optionally call `eforge_extension` with `action: "list"` first to inspect existing extensions and shadowing.
- Call `eforge_extension` with `action: "new"`, the generated `name`, selected `scope`, and selected `template`:
  - `event-logger` for event-driven requests.
  - `blank` for non-event or complex mixed requests.
- Use the returned `path` for file reads and edits; do not hard-code scope paths when the tool returns a path.

### Step 6: Edit

- Read the scaffolded file at the returned `path`.
- Apply TypeScript edits using the required docs and examples as the source of truth.
- Use environment variables for secrets, tokens, webhook URLs, and other credentials; do not commit secrets into source.
- Preserve deferred-runtime caveats in code comments when including future-facing registrations.

### Step 7: Validate

- Before validation, warn that extension loading is unsandboxed in the daemon process; review the code first and do not validate code with unexpected top-level filesystem, network, or environment side effects.
- Show the user a brief side-effect review and ask for explicit confirmation before calling validate; do not proceed if they decline.
- After editing and confirmation, call `eforge_extension` with `action: "validate"` by `name` or returned `path`.
- If validation returns `valid: false`, summarize diagnostics, fix the file, and validate again.
- Do not call `reload` after failed validation.

### Step 8: Optional test

- Offer event replay testing after validation.
- Use `eforge_extension` with `action: "test"` by `name` or `path`, plus `fixture`, `run`, or `event` when the user supplies an event source.
- Warn that replay executes matching `onEvent` handlers in the daemon process and can trigger filesystem, network, or environment side effects.
- Ask for explicit confirmation before running the replay test, even after validation succeeds.
- If no safe event source exists, the user declines confirmation, or the extension has side effects, skip testing and record the reason in the final summary.

### Step 9: Reload

- Before reload, warn that reload activates unsandboxed extension code in the daemon process.
- Ask for explicit confirmation before reload.
- Call `eforge_extension` with `action: "reload"` only after validation succeeds and after the user confirms that warning.
- Summarize watcher fields from the response when present: `wasRunning`, `restarted`, `running`, and `message`.

### Step 10: Final summary

Report:

- Extension name, scope, returned path, selected template, and capability families used.
- Validation result, optional test result or skipped-test reason, and reload result.
- Any deferred-runtime caveats that apply to the generated extension.
- Security/trust notes: extensions are unsandboxed code execution, project/team scope requires explicit trust, and secrets belong in environment variables rather than committed source.
- Follow-up commands: validate, test with fixture/run, reload, and where to edit the file.
