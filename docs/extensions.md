# Extensions

Native eforge extensions are TypeScript or JavaScript modules loaded by the eforge daemon/worker Node process. They are the typed, programmatic counterpart to shell hooks: extension factories can register event hooks, agent-run augmenters, policy gates, profile routers, input sources, reviewer perspectives, validation providers, and custom tools with full TypeScript inference.

Extensions are **not sandboxed**. A loaded extension executes in the same Node process as eforge and has the same filesystem, environment, and network access as the daemon. Only enable extensions from sources you trust.

## What native extensions are (and are not)

Native eforge extensions are distinct from other extensibility mechanisms:

| Mechanism | Language/shape | Runtime owner | Purpose |
|-----------|----------------|---------------|---------|
| Native eforge extensions | TypeScript/JavaScript modules in `extensions/` | eforge daemon/worker | Typed lifecycle registrations and future runtime capabilities |
| Claude Code plugins | Claude Code plugin package | Claude Code host | Slash commands, MCP proxy wiring, Claude Code UX |
| Pi extensions | Pi extension package | Pi host | Native Pi commands, tools, and overlays |
| Shell hooks | YAML + shell command | eforge hook runner | Fire-and-forget notifications/integrations |
| Playbooks/session plans | Markdown input artifacts | `@eforge-build/input` then engine queue | Reusable build sources and planning artifacts |
| Profile toolbelts | YAML MCP server bundles | agent runtime registry | Declarative project MCP server selection |

Toolbelts answer "which project MCP servers should this tier expose?" Extensions answer "what should eforge do when something happens?" Extensions should not redefine toolbelts or act as a hidden profile/config layer.

## Configuration

Native extension loading is controlled by the top-level `extensions` block in `eforge/config.yaml`, `~/.config/eforge/config.yaml`, or `.eforge/config.yaml`:

```yaml
extensions:
  enabled: true                  # default: true
  eventHookTimeoutMs: 5000       # default: 5000; positive integer milliseconds
  # agentContextHookTimeoutMs: 5000  # default: inherits eventHookTimeoutMs; positive integer milliseconds
  # include: [build-notifier]    # optional allowlist by extension name
  # exclude: [experimental]      # optional denylist by extension name
  # paths:                       # optional explicit extension modules/directories
  #   - ./tools/eforge-audit.ts
  trustProjectExtensions: false  # default: false
```

Fields:

| Field | Default | Meaning |
|-------|---------|---------|
| `extensions.enabled` | `true` | Enables native extension loading at runtime. When `false`, extension directories and `paths` are not loaded; management commands may still report discovered candidates with `enabled: false` for visibility. |
| `extensions.include` | unset | Optional allowlist for auto-discovered extension names. If set, only listed auto-discovered names are considered. |
| `extensions.eventHookTimeoutMs` | `5000` | Timeout in milliseconds for each native `onEvent` handler invocation. Must be a positive integer. |
| `extensions.agentContextHookTimeoutMs` | inherits `eventHookTimeoutMs` | Timeout in milliseconds for each `onAgentRun` handler invocation. Must be a positive integer when set. Defaults to `extensions.eventHookTimeoutMs` when omitted. |
| `extensions.exclude` | unset | Optional denylist for auto-discovered extension names. Applied after `include`. |
| `extensions.paths` | unset | Additional explicit extension file or directory paths. Relative paths resolve from the current project root. Explicit paths are validated even when outside standard extension directories. |
| `extensions.trustProjectExtensions` | `false` | Trust gate for checked-in project/team extensions under `eforge/extensions/`. User and project-local extensions are trusted when loading is enabled. |

The trust flag is intentionally restricted: checked-in `eforge/config.yaml` cannot silently turn on trust for checked-in extensions. Set `extensions.trustProjectExtensions: true` in user config (`~/.config/eforge/config.yaml`) or project-local config (`.eforge/config.yaml`) when you intentionally trust this project's committed extensions.

## Discovery scopes and precedence

Auto-discovery scans three directories:

| Scope | Directory | Trust default | Purpose |
|-------|-----------|---------------|---------|
| User | `~/.config/eforge/extensions/` | trusted | Personal extensions reusable across projects |
| Project/team | `eforge/extensions/` | untrusted unless `extensions.trustProjectExtensions: true` | Shared, committed team extensions |
| Project-local | `.eforge/extensions/` | trusted | Local experiments and personal project overrides |

Precedence for same-name auto-discovered extensions is:

```text
project-local > project-team > user
```

The highest-precedence candidate wins; lower-precedence candidates with the same name are reported as `shadowed`. Project-local is the recommended starting point for new extensions. Promote an extension to `eforge/extensions/` only once it is intended for the team and document that users must opt in to trusting project extensions.

CLI scaffold scopes map to discovery directories as follows: local -> `.eforge/extensions/`, project -> `eforge/extensions/`, and user -> `~/.config/eforge/extensions/` by default (`$XDG_CONFIG_HOME/eforge/extensions/` when configured).

## Supported layouts

Auto-discovered and explicit extension paths support file and directory layouts.

### File layout

```text
eforge/extensions/build-notifier.ts
eforge/extensions/build-notifier.mts
eforge/extensions/build-notifier.js
eforge/extensions/build-notifier.mjs
```

The extension name is the filename without the known extension.

### Directory layout

```text
eforge/extensions/build-notifier/index.ts
eforge/extensions/build-notifier/index.mts
eforge/extensions/build-notifier/index.js
eforge/extensions/build-notifier/index.mjs
```

A directory may also provide `package.json` with a supported root `exports`, `exports["."].import`, `exports["."].default`, or `main` entrypoint pointing at `.ts`, `.mts`, `.js`, or `.mjs`. The extension name is the directory name.

Unsupported files or directories are skipped during auto-discovery with a warning diagnostic. Unsupported explicit paths are errors.

## Loader strategy

The loader chooses a strategy from the resolved entrypoint format:

| Format | Strategy |
|--------|----------|
| `.js`, `.mjs` | native dynamic `import()` |
| `.ts`, `.mts` | `jiti` runtime loader |

The module must default-export an extension factory function. The factory is called once at load time with an `EforgeExtensionAPI` recorder. Registration methods must be called during factory execution; registrations made later are not guaranteed to be captured.

```ts
import type { EforgeExtensionAPI } from "@eforge-build/extension-sdk";

export default function extension(eforge: EforgeExtensionAPI) {
  eforge.onEvent("plan:build:*", async (event, ctx) => {
    ctx.logger.info(`Build event: ${event.type}`);
  });
}
```

You can also use `defineEforgeExtension` for parameter inference.

## Statuses, diagnostics, and provenance

The daemon and CLI expose candidates, loaded extensions, diagnostics, shadows, and registration summaries through `eforge extension` commands and daemon API routes.

Statuses:

| Status | Meaning |
|--------|---------|
| `pending` | Candidate discovered and awaiting load. Usually transient in internal results. |
| `loaded` | Factory loaded successfully and registration capture completed. |
| `shadowed` | Auto-discovered candidate lost to a higher-precedence extension with the same name. |
| `skipped` | Candidate was intentionally skipped, most commonly because it is an untrusted project/team extension. |
| `excluded` | Candidate was filtered out by extension include/exclude configuration. |
| `error` | Discovery, validation, import, export, or factory execution failed. |

Diagnostics include severity (`warning` or `error`), stable code, message, and when available name/path/scope/source. Common diagnostics include unsupported layouts, duplicate explicit names, untrusted project extensions, invalid default exports, and factory errors.

Provenance fields identify where an extension came from:

- `scope`: `user`, `project-team`, `project-local`, or `external`
- `source`: `auto` or `explicit`
- `path` and `entrypoint`
- `format`, `layout`, and `strategy`
- `trust`: `trusted` or `untrusted`
- `shadows`: lower-precedence candidates hidden by this candidate
- `registrations`: counts captured by registration family

Use:

```bash
eforge extension list
eforge extension show build-notifier
eforge extension validate
eforge extension validate ./tools/eforge-audit.ts
eforge extension test [nameOrPath]
eforge extension test build-notifier --fixture events.json
eforge extension test ./tools/eforge-audit.ts --run latest --event plan:build:failed
eforge extension new <name>
eforge extension reload
```

`eforge extension test [nameOrPath]` validates the selected extension set and dry-runs matching `onEvent` hooks against replayed events. Omit `nameOrPath` to test configured extensions, pass a configured extension name to test one loaded extension, or pass an extension file/directory path for an ad-hoc test. Path detection matches `extension validate`: `./tools/eforge-audit.ts` is a path, while `build-notifier` is a configured extension name.

Replay sources:

- no source: static validation and registration summary only
- `--fixture <path>`: read project-local fixture events through the daemon
- `--run latest`: replay events from the latest monitor DB session
- `--run <sessionId-or-runId>`: replay events from a specific monitor session or run
- `--event <type>`: filter replay input to an exact event type before matching hooks
- `--json`: print the raw `ExtensionTestResponse`

Fixture files may contain one JSON event object, a JSON array of event objects, or JSONL with one event object per non-empty line. Every event is validated against the canonical eforge event schema before replay.

Non-JSON output is summary-first. It reports whether the test passed, the source (`none`, `fixture`, or `run`), replay counts (`inputEventCount`, `filteredEventCount`, `emittedEventCount`, and `diagnosticEventCount`), match count, emitted event-handler diagnostics, and deferred registration family counts. Zero matching hooks are valid when the response is otherwise valid; the CLI prints a clear zero-match message and exits 0. The process exits 1 only when the daemon response has `valid: false`.

`eforge extension new <name>` scaffolds a TypeScript extension. Defaults are `--scope local` (project-local `.eforge/extensions/`), `--template event-logger`, and no overwrite. Pass `--scope project` for committed team extensions, `--scope user` for personal cross-project extensions, `--template blank` for a minimal module, or `--force` to overwrite an existing scaffold target. Non-JSON output prints the created path, canonical daemon scope (`project-local`, `project-team`, or `user`), template, overwrite state, and next validation/reload steps.

`eforge extension reload` refreshes daemon extension discovery and restarts the runtime watcher when it is currently running. JSON output is the raw daemon response, including refreshed extension entries, diagnostics, registration totals, and watcher restart metadata. Non-JSON output summarizes watcher state and diagnostic counts.

List/show output includes `enabled`, a derived boolean for whether the entry is selected by the current extension config and is not shadowed or excluded. It is `false` when extensions are globally disabled, when include/exclude filters leave the entry out, or when a higher-precedence extension shadows it. A selected entry can still have `enabled: true` with status `skipped` or `error`; use status, trust, and diagnostics to see why it did not load.

Add `--json` to CLI commands for machine-readable provenance. The same data is exposed via `/api/extensions/list`, `/api/extensions/show`, `/api/extensions/validate`, `/api/extensions/new`, `/api/extensions/reload`, and `/api/extensions/test`.

`extension enable`, `extension disable`, `extension promote`, and `extension demote` workflows are deferred.

## Runtime support today

The runtime foundation is shipped: discovery, trust gating, loader strategy selection, factory execution, registration capture, diagnostics, status reporting, CLI/API/MCP/Pi inspection and management tooling, native `onEvent` dispatch, and `onAgentRun` prompt-context augmentation are available.

Event hooks run for real CLI, queue worker, and daemon watcher event streams. Dispatch is non-blocking with respect to the engine pipeline: handlers receive matching events but cannot alter or stop the triggering work. Handler failures and timeouts emit `extension:event-handler:*` diagnostics with the extension name, matched pattern, triggering event type, and available `sessionId`/`runId` correlation fields. Those diagnostics are recorded by the monitor before shell hooks run, so shell-hook matching has parity with normal engine and extension diagnostic events.

Event replay testing is also available through `eforge extension test`. Replay execution is a dry run for `onEvent` hooks only: it invokes matching event handlers against fixture or monitor DB events and records emitted handler diagnostics, but it does not execute custom tools, policy gates, profile routers, input sources, reviewer perspectives, validation providers, or agent-run hooks. Those non-event registrations are summarized as deferred registration families in the test result.

Agent-run hooks fire before each agent invocation. Handlers can inspect `ctx.role`, `ctx.tier`, `ctx.phase`, and `ctx.stage` to scope their contribution, then return `{ promptAppend: '...' }` to inject additional context. Fragments are appended after any config-level `promptAppend` already resolved by the engine, wrapped in a named provenance section identifying the contributing extension. Multiple extensions contribute in registration order. The runtime is fail-open: a handler that throws or exceeds `extensions.agentContextHookTimeoutMs` emits a typed diagnostic event but does not abort the agent run. Tool fields (`tools`, `allowedTools`, `disallowedTools`) in the return value emit an `extension:agent-context:unsupported` diagnostic and are otherwise ignored - tool injection is tracked for EXTEND_08B.

All other non-event extension capability execution is intentionally deferred for later phases. Loading an extension still records every registration family so provenance and validation output remain complete.

| Capability | Type contract | Loader-time registration capture | Runtime execution today |
|-----------|---------------|----------------------------------|-------------------------|
| `onEvent` - typed event subscriptions | Yes | Yes | Yes |
| `onAgentRun` - agent prompt-context augmentation | Yes | Yes | Yes (promptAppend only - tools/allowedTools/disallowedTools deferred to EXTEND_08B) |
| `registerTool` - custom agent tool | Yes | Yes | Deferred |
| `beforePlanMerge` - policy gate | Yes | Yes | Deferred |
| `registerProfileRouter` | Yes | Yes | Deferred |
| `registerInputSource` | Yes | Yes | Deferred |
| `registerReviewerPerspective` | Yes | Yes | Deferred |
| `registerValidationProvider` | Yes | Yes | Deferred |

Event-hook and agent-context-hook examples can be loaded, validated, and run at runtime. Blocking policy enforcement, custom tool execution, profile routing, custom input fetching, reviewer perspective execution, and validation provider execution are future runtime phases.

## Schema language

The SDK uses [TypeBox](https://github.com/sinclairzx81/typebox) as its schema language for custom tools:

```ts
import { defineExtensionTool, Type } from "@eforge-build/extension-sdk";

const myTool = defineExtensionTool({
  name: "my-tool",
  description: "Does something useful",
  inputSchema: Type.Object({ path: Type.String() }),
  handler: async ({ path }) => `processed: ${path}`,
});
```

Zod does not appear in the SDK public surface. If you use Zod internally, adapt it at the extension boundary.

## Event patterns

Event subscriptions accept glob-style patterns using `*` as a wildcard. The wildcard matches any characters including `:`:

| Pattern | Matches |
|---------|---------|
| `plan:build:failed` | Exact match only |
| `plan:build:*` | `plan:build:start`, `plan:build:complete`, `plan:build:failed`, etc. |
| `*:complete` | `planning:complete`, `plan:build:complete`, `expedition:wave:complete`, etc. |
| `*` | Every event |

Pattern semantics match shell hooks. See [`docs/hooks.md`](./hooks.md) for event types.

## Trust and security

- Extensions run in the eforge daemon/worker Node process without a sandbox.
- User (`~/.config/eforge/extensions/`) and project-local (`.eforge/extensions/`) extensions load when `extensions.enabled` is true.
- Project/team extensions (`eforge/extensions/`) are skipped unless `extensions.trustProjectExtensions: true` is set from user or project-local config.
- Explicit paths outside standard scopes are treated as `external` and trusted when enabled, so use them only for code you control.
- Do not load extensions from unreviewed repositories or package artifacts.
- Treat `eforge extension test` as code execution, not static analysis. The replay path is a dry run with respect to eforge engine state, but matching `onEvent` handlers still execute in the daemon process and can perform filesystem, environment, and network operations.

Hash-based trust prompts/stores are not shipped behavior in this slice.

## API reference

For full type signatures and method documentation, see [`docs/extensions-api.md`](./extensions-api.md).
