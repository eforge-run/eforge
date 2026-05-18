# @eforge-build/extension-sdk

Type-first API surface for eforge TypeScript extensions. Write extensions that observe or influence eforge lifecycle behavior with full TypeScript inference.

## Install

```sh
npm install @eforge-build/extension-sdk
# or
pnpm add @eforge-build/extension-sdk
```

## Quick start

Start with the CLI scaffold for a local, gitignored extension:

```sh
eforge extension new build-notifier
$EDITOR .eforge/extensions/build-notifier.ts
eforge extension validate build-notifier
eforge extension test build-notifier --fixture events.json
# or replay the latest recorded run:
eforge extension test build-notifier --run latest
eforge extension reload
```

By default this uses the `event-logger` template in `.eforge/extensions/` and refuses to overwrite an existing file unless `--force` is passed. Use `--template blank` for a minimal module. Use `--scope project` for `eforge/extensions/` or `--scope user` for your user config directory.

An extension is a TypeScript module with a default-export factory:

```ts
// .eforge/extensions/build-notifier.ts
import type { EforgeExtensionAPI } from "@eforge-build/extension-sdk";

export default function extension(eforge: EforgeExtensionAPI) {
  eforge.onEvent("plan:build:failed", async (event, ctx) => {
    ctx.logger.warn(`Build failed: ${event.planId}`);
  });
}
```

Use `defineEforgeExtension` when you want factory parameter inference:

```ts
import { defineEforgeExtension } from "@eforge-build/extension-sdk";

export default defineEforgeExtension((eforge) => {
  eforge.onEvent("plan:build:*", async (event, ctx) => {
    ctx.logger.info(`Build event: ${event.type}`);
  });
});
```

## Runtime loading

The eforge daemon discovers and loads native extensions from three scopes:

| Scope | Directory | Trust default | Purpose |
|-------|-----------|---------------|---------|
| User | `~/.config/eforge/extensions/` | trusted | Personal, cross-project |
| Project/team | `eforge/extensions/` | untrusted unless a matching local trust record exists | Shared, committed |
| Project-local | `.eforge/extensions/` | trusted | Local experiments |

Precedence is `project-local > project-team > user`. Supported entrypoints are `.ts`, `.mts`, `.js`, and `.mjs` files or directories with `index.*` / supported `package.json` entrypoints. TypeScript loads through `jiti`; JavaScript uses dynamic import. Extensions run in the eforge daemon/worker Node process without a sandbox. Project/team extensions require an explicit per-extension local trust record in `.eforge/extension-trust.json` — created by `eforge extension trust <name>` — before loading; any content change invalidates the stored hash and blocks the extension until re-trusted. Trust/untrust commands only discover and hash project/team candidates and update `.eforge/extension-trust.json`; they do not import the module or execute its factory. Later validate, test, reload, or build operations may load and execute trusted extension code.

Loader-time registration capture is available today: the daemon calls each default-export factory and records registrations for provenance, validation, CLI/API/MCP/Pi tooling, and diagnostics. Runtime dispatch and replay testing are available for `onEvent`; `onAgentRun` prompt-context augmentation, per-run extension tool injection, per-run tool availability tuning, `registerProfileRouter` pre-build dispatch, and the shipped policy-gate subset (`beforeQueueDispatch`, `beforePlanMerge`, `beforeFinalMerge`) are wired. Input sources, reviewer perspectives, validation providers, `beforeEnqueue`, `beforeValidation`, approval workflow/state, and `modify` decisions remain deferred.

## Registration methods

| Method | Description | Loader-time capture | Runtime execution |
|--------|-------------|---------------------|-------------------|
| `onEvent(pattern, handler)` | Subscribe to typed events (glob patterns) | Yes | Yes |
| `onAgentRun(handler)` | Append prompt context, inject extension tools, and tune tool availability scoped by role/tier/phase | Yes | Yes |
| `registerTool(tool)` | Register a custom agent tool for loader/list provenance and validation | Yes | Provenance only; inject per run via `onAgentRun` |
| `beforeQueueDispatch(handler)` | Policy gate before queued PRD dispatch | Yes | Yes (blocking policy gate) |
| `beforePlanMerge(handler)` | Policy gate before plan worktree is merged into the integration branch | Yes | Yes (blocking policy gate) |
| `beforeFinalMerge(handler)` | Policy gate before final feature merge | Yes | Yes (blocking policy gate) |
| `registerProfileRouter(spec)` | Select agent runtime profile per build (canonical: `selectBuildProfile`) | Yes | Yes (pre-build dispatch) |
| `registerInputSource(adapter)` | Produce PRD/build-source artifacts | Yes | Deferred |
| `registerReviewerPerspective(spec)` | Add custom review perspective | Yes | Deferred |
| `registerValidationProvider(spec)` | Add custom validation step | Yes | Deferred |

All capabilities have full TypeScript type contracts. Loading, registration capture, `onEvent` dispatch, `onAgentRun` prompt-context augmentation, per-run extension tool injection, tool availability tuning, `registerProfileRouter` pre-build dispatch, and `beforeQueueDispatch` / `beforePlanMerge` / `beforeFinalMerge` policy gates are wired; custom input fetching, reviewer perspective execution, validation provider execution, `beforeEnqueue`, `beforeValidation`, approval workflow/state, and `modify` decisions land in subsequent runtime phases.

`registerProfileRouter` routers run before each queued PRD build. Per-router timeout is controlled by `extensions.profileRouterTimeoutMs`, which defaults to `extensions.eventHookTimeoutMs`. Routers are invoked sequentially in registration order using `selectBuildProfile` (preferred) or the deprecated `resolve` method. A `null`/`undefined` result defers to the next router. Routers that throw or time out emit `queue:profile:*` diagnostics and the next router is consulted (fail-open). An explicit `profile:` field in the PRD's frontmatter takes absolute precedence — no routers are invoked. See [`examples/extensions/profile-router.ts`](../../examples/extensions/profile-router.ts) for a three-tier fallback example.

`onEvent` handlers are non-blocking with respect to the engine pipeline. Handler failures and timeouts emit `extension:event-handler:*` diagnostics with extension name, pattern, triggering event type, and available `sessionId`/`runId` correlation fields. Use `eforge extension test <name-or-path> --fixture <path>` or `eforge extension test <name-or-path> --run latest` to dry-run matching event hooks and inspect replay counts, matches, emitted diagnostics, and non-event registration summaries.

`onAgentRun` handlers run before each agent invocation and may return `{ promptAppend, tools, allowedTools, disallowedTools }` to inject role- or phase-scoped context, expose extension tools for that run, and tune the harness allow/deny lists. Each prompt fragment is wrapped in a named provenance section appended to the resolved prompt. Handlers are fail-open: a throw or timeout emits a typed `extension:agent-context:*` diagnostic but does not abort the agent run. `registerTool` records loader-time provenance; returning `tools` from `onAgentRun` is the per-run injection path.

## Policy decisions

Policy gates are runtime-supported for `beforeQueueDispatch`, `beforePlanMerge`, and `beforeFinalMerge`. Handlers receive read-only context snapshots, but extensions are still trusted, unsandboxed code running in the daemon/worker process. Policy gate failures, invalid decisions, and timeouts follow `extensions.policyGateFailurePolicy` (`fail-closed` by default, or `fail-open`).

Policy gate handlers return a discriminated union:

```ts
// allow
return { decision: "allow" };

// block
return { decision: "block", reason: "Do not merge .env changes" };

// require human approval (currently blocks because no approval workflow exists)
return { decision: "require-approval", reason: "Sensitive path changed" };
```

## Custom tools

Contribute tools to agent runs using TypeBox schemas:

```ts
import { defineExtensionTool, Type } from "@eforge-build/extension-sdk";

const myTool = defineExtensionTool({
  name: "my-tool",
  description: "Does something useful",
  inputSchema: Type.Object({
    path: Type.String(),
  }),
  handler: async ({ path }) => `processed: ${path}`,
});

// `registerTool` captures the tool at load time for provenance and validation.
eforge.registerTool(myTool);

// `onAgentRun` injects the tool only for selected runs.
eforge.onAgentRun(async (ctx) => {
  if (ctx.role !== "builder") return;
  const toolName = ctx.effectiveToolName(myTool.name);
  return {
    tools: [myTool],
    disallowedTools: ["dangerous_shell_escape"],
    promptAppend: `Use ${toolName} when you need this extension-provided helper.`,
  };
});

// `allowedTools` and `disallowedTools` tune per-run harness availability.
// They are not toolbelt configuration; toolbelts select project MCP servers from `.mcp.json`.
```

## Event patterns

Patterns use `*` as a wildcard (matches any characters including `:`):

```ts
eforge.onEvent("plan:build:*", handler);   // all build phase events
eforge.onEvent("*:complete", handler);     // all completion events
eforge.onEvent("*", handler);              // every event
```

Pattern semantics match shell hooks in `eforge/config.yaml`.

## Dependencies

- `@eforge-build/client` - canonical event types and TypeBox schemas
- `@sinclair/typebox` - schema language for tool definitions

## Documentation

- [Extensions guide](https://eforge.build/docs/extensions) - conceptual overview, scopes, and examples
- [Extensions API reference](https://eforge.build/docs/extensions-api) - full type signatures

Local docs: [`docs/extensions.md`](../../docs/extensions.md) and [`docs/extensions-api.md`](../../docs/extensions-api.md).

## Stability

Public exports are stability-promised within a major version. Runtime loading, daemon integration, CLI/API/MCP/Pi inspection, diagnostics, registration capture, `onEvent` execution/replay testing, `onAgentRun` prompt-context augmentation, per-run extension tool injection, per-run tool availability tuning, `registerProfileRouter` pre-build dispatch, and the shipped policy-gate subset are available. Runtime execution of deferred capability families will build on this stable contract.
