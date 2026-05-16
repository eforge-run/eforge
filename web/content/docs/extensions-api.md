---
title: Extensions API Reference
description: Type-level reference for the @eforge-build/extension-sdk package.
---

# Extensions API Reference

This document is the type-level reference for `@eforge-build/extension-sdk`. For conceptual background, scope model, management commands (`eforge extension list/show/validate/test/new/reload`), and example walkthroughs, see [Extensions](/docs/extensions).

## Entrypoint

An extension is a TypeScript module with a default-export factory function:

```ts
import type { EforgeExtensionAPI } from "@eforge-build/extension-sdk";

export default function extension(eforge: EforgeExtensionAPI): void | Promise<void> {
  // register handlers on eforge
}
```

The factory is called once when the extension is loaded. All registrations must happen synchronously during the factory call (or within the awaited `Promise<void>` if the factory is async). Registrations made after the factory resolves are not guaranteed to take effect.

### `defineEforgeExtension(factory)`

A no-op identity helper for TypeScript inference. Useful when you want parameter inference without explicitly importing `EforgeExtensionAPI`:

```ts
import { defineEforgeExtension } from "@eforge-build/extension-sdk";

export default defineEforgeExtension((eforge) => {
  // eforge is inferred as EforgeExtensionAPI
});
```

**Type:** `(factory: EforgeExtensionFactory) => EforgeExtensionFactory`

**Runtime cost:** none (returns the factory unchanged).

---

## `EforgeExtensionAPI` methods

### `onEvent(pattern, handler)`

Subscribe to one or more event types using a glob pattern. The handler fires after the event is emitted; it does not block or influence the pipeline.

```ts
eforge.onEvent("plan:build:failed", async (event, ctx) => {
  ctx.logger.warn(`Build failed for plan ${event.planId}`);
});

eforge.onEvent("plan:build:*", async (event, ctx) => {
  ctx.logger.info(`Build lifecycle: ${event.type}`);
});
```

**Signature:**

```ts
onEvent<TType extends EforgeEvent["type"]>(
  pattern: TType,
  handler: EventHookHandler<TType>,
): void

onEvent(
  pattern: EventPattern,
  handler: (event: EforgeEvent, ctx: EventHookContext) => void | Promise<void>,
): void
```

**Handler type:**

```ts
type EventHookHandler<T extends EforgeEvent["type"]> = (
  event: EventOfType<T>,
  ctx: EventHookContext,
) => void | Promise<void>
```

The `event` parameter is narrowed to `EventOfType<T>` when the pattern is an exact event type string. For glob patterns (containing `*`), the event type is `EforgeEvent`.

**Runtime status:** registration is captured at load time and matching events are dispatched at runtime. Dispatch is non-blocking with respect to the engine pipeline: handlers cannot alter, block, or stop the triggering work. Handler failures and timeouts emit `extension:event-handler:*` diagnostics with extension name, pattern, triggering event type, and available `sessionId`/`runId` correlation fields; monitor recording sees those diagnostics before shell hooks run.

**Replay testing:** `eforge extension test` executes matching `onEvent` handlers against fixture or monitor DB events. It reports replay counts, matched hooks, emitted `extension:event-handler:*` diagnostics, and deferred non-event registration families. Replay testing does not execute `onAgentRun`, custom tools, policy gates, profile routers, input sources, reviewer perspectives, or validation providers.

---

### `onAgentRun(handler)`

Register a handler invoked before each agent run starts. The handler receives an `AgentRunContext` (which itself extends `EforgeExtensionContext`, so logger and exec are available on the same object) and may return a `promptAppend` fragment to inject additional context into the agent's prompt. Inspect `ctx.role`, `ctx.tier`, `ctx.phase`, and `ctx.stage` to scope behavior to specific agent roles or lifecycle positions.

```ts
eforge.onAgentRun(async (ctx) => {
  if (ctx.role !== "builder") return;
  return {
    promptAppend: "Check the design system before modifying UI components.",
  };
});
```

**Signature:**

```ts
onAgentRun(handler: AgentRunHandler): void
```

**Handler type:**

```ts
type AgentRunHandler = (
  ctx: AgentRunContext,
) => AgentRunAugmentation | undefined | void | Promise<AgentRunAugmentation | undefined | void>
```

**`AgentRunContext`** (extends `EforgeExtensionContext`):

```ts
interface AgentRunContext extends EforgeExtensionContext {
  role: AgentRole;
  tier: string;
  profile: string;
  planId?: string;
  changedFiles?: string[];
  // Lifecycle context (populated for pipeline runs):
  phase?: string;   // 'compile' | 'build' | 'standalone'
  stage?: string;   // e.g. 'implement', 'review', 'planner', 'module-planner'
  // Runtime metadata (read-only):
  harness?: 'claude-sdk' | 'pi';
  toolbelt?: string | null;
  toolbeltSource?: 'tier' | 'role' | 'plan' | 'default';
  projectMcpSelection?: 'all' | 'none' | 'toolbelt';
}
```

**`AgentRunAugmentation`:**

```ts
interface AgentRunAugmentation {
  promptAppend?: string;
  /** @deprecated Not applied at runtime in EXTEND_08A — emits unsupported diagnostic. Tracked for EXTEND_08B. */
  tools?: ExtensionTool[];
  /** @deprecated Not applied at runtime in EXTEND_08A — emits unsupported diagnostic. Tracked for EXTEND_08B. */
  allowedTools?: string[];
  /** @deprecated Not applied at runtime in EXTEND_08A — emits unsupported diagnostic. Tracked for EXTEND_08B. */
  disallowedTools?: string[];
}
```

**Prompt composition:** returned `promptAppend` fragments are appended *after* any config-level `promptAppend` already resolved by the engine, wrapped in a per-extension provenance section:

```
## Native extension context

### <extension-name>
<fragment>
```

Multiple extensions append in registration order. Each handler runs with a configurable timeout (see `extensions.agentContextHookTimeoutMs`).

**Fail-open behavior:** a handler that throws an error emits an `extension:agent-context:failed` event; a handler that exceeds the timeout emits an `extension:agent-context:timeout` event. In both cases the agent run proceeds with the unmodified prompt. Diagnostic events carry metadata (extension name, role, tier, phase, stage, fragment count) but never the prompt fragment text.

**Unsupported fields:** returning `tools`, `allowedTools`, or `disallowedTools` emits an `extension:agent-context:unsupported` diagnostic listing the rejected field names. Those fields are otherwise ignored and the prompt is not modified. This is not an error condition — it is a forward-compatibility signal for EXTEND_08B.

**Runtime status:** Yes (promptAppend only — `tools`/`allowedTools`/`disallowedTools` deferred to EXTEND_08B).

---

### `registerTool(tool)`

Register a custom agent tool independently of an `onAgentRun` return value. This is useful for extensions that want their tool contribution to appear in loader-time provenance even before agent-run execution is active.

```ts
import { Type, defineExtensionTool } from "@eforge-build/extension-sdk";

const lookupComponent = defineExtensionTool({
  name: "lookup-component",
  description: "Looks up a design-system component by name",
  inputSchema: Type.Object({
    name: Type.String(),
  }),
  handler: async ({ name }) => `Component: ${name}`,
});

eforge.registerTool(lookupComponent);
```

**Signature:**

```ts
registerTool(tool: ExtensionTool): void
```

**Runtime status:** registration is captured at load time; agent tool injection and execution are deferred.

---

### `beforePlanMerge(handler)`

Policy gate that fires before a plan's worktree is merged into the main branch. Return `{ decision: 'block', reason }` to prevent the merge.

```ts
eforge.beforePlanMerge(async (ctx) => {
  if (ctx.diff.files.some((f) => f.path === ".env")) {
    return { decision: "block", reason: "Do not merge .env changes" };
  }
  return { decision: "allow" };
});
```

**Signature:**

```ts
beforePlanMerge(handler: PolicyGateHandler): void
```

**Handler type:**

```ts
type PolicyGateHandler = (
  ctx: PolicyGateContext,
) => PolicyDecision | Promise<PolicyDecision>
```

**`PolicyGateContext`** (extends `EforgeExtensionContext`):

```ts
interface PolicyGateContext extends EforgeExtensionContext {
  planId: string;
  diff: ExtensionDiff;
}

interface ExtensionDiff {
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
  }>;
}
```

**Runtime status:** registration is captured at load time; policy-gate execution is deferred.

---

### `registerProfileRouter(spec)`

Register a function that selects an agent runtime profile for each build dispatched from the queue. Called before a queued PRD build begins.

**Signature:**

```ts
registerProfileRouter(spec: ProfileRouterSpec): void
```

**`ProfileRouterSpec`:**

```ts
interface ProfileRouterSpec {
  name: string;
  /** Canonical method — receives full build/queue context. */
  selectBuildProfile?: (
    ctx: ProfileRouterContext,
  ) => ProfileRouterResult | null | undefined | Promise<ProfileRouterResult | null | undefined>;
  /**
   * @deprecated Use `selectBuildProfile` instead.
   * Receives limited agent-run context rather than build/queue context.
   */
  resolve?: (
    ctx: AgentRunContext,
  ) => ProfileRouterResult | null | undefined | Promise<ProfileRouterResult | null | undefined>;
}

interface ProfileRouterResult {
  profile: string;
  reason?: string;
  confidence?: 'low' | 'medium' | 'high';
}
```

At least one of `selectBuildProfile` or `resolve` must be provided. The `selectBuildProfile` method is canonical and receives `ProfileRouterContext` with PRD id, title, body, priority, dependencies, available profiles, and usage statistics.

Return `null` or `undefined` from the handler to defer to the next registered router (or the default profile if no router selects one). The optional `reason` and `confidence` fields flow into the `queue:profile:selected` wire event.

**Runtime status:** `Yes (pre-build dispatch)`. Routers are invoked sequentially in registration order before each queued PRD build, with per-router timeouts controlled by `extensions.profileRouterTimeoutMs` (defaulting to `extensions.eventHookTimeoutMs`) and fail-open semantics. When a PRD's `frontmatter.profile` is already set, routing is skipped entirely. A router that throws emits `queue:profile:router-failed` and the next router is consulted; a timeout emits `queue:profile:router-timeout`; a returned profile that cannot be loaded emits `queue:profile:invalid-selection`. Returning `null` or `undefined` defers to the next router (first-valid-wins). The `queue:profile:selected` event records provenance when a valid profile is chosen. `ctx.usage.profile(name)` returns best-effort data from daemon event history — use it for heuristic decisions, not hard quota enforcement.

---

### `registerInputSource(adapter)`

Register a custom input source that produces PRD/build-source artifacts for the queue.

**Signature:**

```ts
registerInputSource(adapter: InputSourceAdapter): void
```

**`InputSourceAdapter`:**

```ts
interface InputSourceAdapter {
  /** Unique adapter name (e.g. `my-ext:linear`). */
  name: string;
  /** Human-readable description of where this source retrieves input from. */
  description: string;
  /** Fetch the raw input artifact for `id`, or `null` if not found. */
  fetch: (id: string) => Promise<string | null>;
}
```

**Runtime status:** registration is captured at load time; input-source execution is deferred.

---

### `registerReviewerPerspective(spec)`

Register a custom review perspective. The spec is evaluated during the review phase alongside built-in perspectives.

**Signature:**

```ts
registerReviewerPerspective(spec: ReviewerPerspectiveSpec): void
```

**`ReviewerPerspectiveSpec`:**

```ts
interface ReviewerPerspectiveSpec {
  /** Unique perspective key (matched against `REVIEW_PERSPECTIVES` in the engine). */
  key: string;
  /** Human-readable label shown in review output. */
  label: string;
  /** Prompt fragment injected into the reviewer agent's context when active. */
  promptFragment: string;
}
```

**Runtime status:** registration is captured at load time; reviewer-perspective execution is deferred.

---

### `registerValidationProvider(spec)`

Register a custom validation step that runs after build completion.

**Signature:**

```ts
registerValidationProvider(spec: ValidationProviderSpec): void
```

**`ValidationProviderSpec`:**

```ts
interface ValidationProviderSpec {
  /** Unique provider name. */
  name: string;
  /** Human-readable description of what this provider validates. */
  description: string;
  /**
   * Validate the build output for the plan at `planOutputDir`.
   *
   * Return `null` or `undefined` to signal success. Return a `string` message
   * to signal failure — the message is surfaced in build output.
   */
  validate: (
    planOutputDir: string,
  ) => Promise<string | null | undefined> | string | null | undefined;
}
```

**Runtime status:** registration is captured at load time; validation-provider execution is deferred.

---

## Context types

### `EforgeExtensionContext`

The base context passed to all handlers. Provides logging and command execution.

```ts
interface EforgeExtensionContext {
  logger: ExtensionLogger;
  exec: ExtensionExecApi;
}
```

**`ExtensionLogger`:**

```ts
interface ExtensionLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

**`ExtensionExecApi`:**

```ts
interface ExtensionExecApi {
  run(
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

### `EventHookContext`

Context for `onEvent` handlers. Extends `EforgeExtensionContext` and adds an `event` field carrying the raw `EforgeEvent` that triggered the hook (the same object as the handler's first argument, exposed here for convenience in shared helpers). Runtime event hooks receive the enriched event object, including available `sessionId` and `runId` correlation fields:

```ts
interface EventHookContext extends EforgeExtensionContext {
  event: EforgeEvent;
}
```

---

## Hook result types

### `PolicyDecision`

Returned by policy gate handlers. A discriminated union with three variants:

```ts
type PolicyDecision =
  | { decision: "allow" }
  | { decision: "block"; reason: string }
  | { decision: "require-approval"; reason: string };
```

- `allow` - the operation proceeds normally.
- `block` - the operation is rejected. `reason` is surfaced in logs and the monitor UI.
- `require-approval` - the operation pauses pending explicit operator approval (exact UX determined by the runtime epic). Reserved for future use; in the current policy-gate runtime, treat as equivalent to `block`.

A `modify` variant (mutating the diff inline) is intentionally absent. No policy gate in the current scope explicitly allows mutation; introducing it now would create ambiguous contracts. This is noted as a future extension point.

---

## Event types and `EventPattern` glob semantics

All event types are defined in `packages/client/src/events.schemas.ts` as the `EforgeEvent` discriminated union. The SDK re-exports `EforgeEvent`, `EforgeEventSchema`, `AgentRole`, and `safeParseEforgeEvent` from `@eforge-build/client`.

### `EventOfType<T>`

Extract a specific event variant by type string:

```ts
import type { EventOfType } from "@eforge-build/extension-sdk";

type FailedEvent = EventOfType<"plan:build:failed">;
// resolves to the exact discriminant variant from EforgeEvent
```

### Pattern semantics

`EventPattern` is a string type alias. Patterns use `*` as a wildcard that matches any characters including `:`. The semantics are identical to shell hook patterns in `eforge/config.yaml`.

| Pattern | Matches | Does not match |
|---------|---------|----------------|
| `plan:build:failed` | `plan:build:failed` | `plan:build:complete` |
| `plan:build:*` | `plan:build:start`, `plan:build:failed`, ... | `planning:complete` |
| `*:complete` | `plan:build:complete`, `expedition:wave:complete`, `planning:complete` | `plan:build:failed` |
| `*` | Every event type | - |
| `plan.build:start` | `plan.build:start` (literal dot) | `plan:build:start` |

The last row illustrates that `.` in a pattern is a literal dot, not a regex wildcard. Only `*` is special.

### Pattern helpers

```ts
import { compileEventPattern, matchesEventPattern } from "@eforge-build/extension-sdk";

// Compile a pattern once and reuse the RegExp
const re = compileEventPattern("plan:build:*");
re.test("plan:build:failed"); // true

// One-shot test
matchesEventPattern("*:complete", "wave:complete"); // true
```

`compileEventPattern` produces an anchored `RegExp` (`^...$`) using the same algorithm as `packages/engine/src/hooks.ts::compilePattern`. The SDK ports this algorithm internally so it stays engine-independent; behavioral parity is tested in `test/extension-sdk-example.test.ts`.

---

## TypeBox schema usage and `ExtensionTool`

The SDK uses TypeBox as its schema language. Import `Type`, `TSchema`, `TObject`, and `Static` directly from `@eforge-build/extension-sdk` - you do not need a separate `@sinclair/typebox` dependency to write tools.

### `ExtensionTool<TInput>`

```ts
interface ExtensionTool<TInput extends TObject = TObject> {
  name: string;
  description: string;
  inputSchema: TInput;
  handler: (input: Static<TInput>) => Promise<string> | string;
}
```

### `defineExtensionTool(tool)`

Identity helper for inference. Returns the tool unchanged at runtime:

```ts
import { defineExtensionTool, Type } from "@eforge-build/extension-sdk";

const lookupTool = defineExtensionTool({
  name: "lookup-component",
  description: "Looks up a design system component by name",
  inputSchema: Type.Object({
    name: Type.String({ description: "Component name" }),
  }),
  handler: async ({ name }) => {
    return `Component: ${name}`;
  },
});
```

`ExtensionTool` is a narrower public type than the engine's internal `CustomTool`. The loader captures `ExtensionTool` registrations at load time. Agent injection and execution are deferred; the public shape stays narrow so the engine's internal representation can evolve without breaking extension authors.

---

## Runtime support status

The daemon can discover, trust-check, import, and execute extension factories. During factory execution it records registrations for all SDK methods below and exposes counts through `eforge extension` CLI commands and extension daemon APIs. Runtime dispatch and replay testing are available for `onEvent`; `onAgentRun` prompt-context augmentation and `registerProfileRouter` pre-build dispatch are also wired. Replay invokes only matching event hooks and summarizes non-event registrations as deferred. Blocking policy enforcement, custom tool injection/execution, input-source execution, reviewer perspective execution, and validation-provider execution are intentionally deferred for later phases.

| Capability | Type contract | Loader-time registration capture | Runtime execution today |
|-----------|---------------|----------------------------------|-------------------------|
| `onEvent` | Yes | Yes | Yes |
| `onAgentRun` | Yes | Yes | Yes (promptAppend only — tools/allowedTools/disallowedTools deferred to EXTEND_08B)[^1] |
| `registerTool` / `ExtensionTool` | Yes | Yes | Deferred |
| `beforePlanMerge` policy gate | Yes | Yes | Deferred |
| `registerProfileRouter` | Yes | Yes | Yes (pre-build dispatch) |
| `registerInputSource` | Yes | Yes | Deferred |
| `registerReviewerPerspective` | Yes | Yes | Deferred |
| `registerValidationProvider` | Yes | Yes | Deferred |

[^1]: `onAgentRun` handlers that return `tools`, `allowedTools`, or `disallowedTools` emit an `extension:agent-context:unsupported` diagnostic. Those fields are not applied. Handlers are fail-open: errors and timeouts emit `extension:agent-context:failed` / `extension:agent-context:timeout` diagnostics and do not abort the agent run.

Loaded extensions appear in provenance and validation output, including registration summaries and diagnostics. Event-hook, agent-context-hook, and profile-router examples run at runtime. Event-hook examples can also be dry-run with `eforge extension test --fixture <path>` or `eforge extension test --run latest`. Custom tool injection/execution, blocking policy enforcement, input-source execution, reviewer perspective execution, and validation-provider execution are future runtime work.

---

## Toolbelt-vs-extension boundary

Profile toolbelts and extensions are complementary but intentionally separate:

| | Toolbelts | Extensions |
|-|-----------|-----------|
| **Language** | YAML (declarative) | TypeScript (imperative) |
| **Purpose** | "Which MCP servers does this tier get?" | "What should eforge do when X happens?" |
| **Can block pipeline** | No | Yes (policy gates) |
| **Can add custom tools** | Indirectly (MCP) | Yes (`ExtensionTool`) |
| **Scope model** | profiles/, user/project/local | extensions/, user/project/local |

Toolbelt filtering applies only to project MCP servers declared in `.mcp.json`. It does not filter engine-internal tools, harness built-ins, or future extension-contributed custom tools. In the current runtime, `registerTool` registrations and `onAgentRun` tool fields are captured for provenance only; they are not injected into agent runs or affected by toolbelt filtering.

Profile routers receive available profile names and best-effort usage summaries through `ProfileRouterContext`; agent-run hooks also receive read-only runtime metadata such as `profile`, `harness`, and toolbelt selection. Extensions must not write profile marker files or redefine toolbelt declarations.
