---
title: Extensions API Reference
description: Type-level reference for the @eforge-build/extension-sdk package.
---

# Extensions API Reference

This document is the type-level reference for `@eforge-build/extension-sdk`. For conceptual background, scope model, management commands (`eforge extension list/show/validate/new/reload`), and example walkthroughs, see [Extensions](/docs/extensions).

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

---

### `onAgentRun(handler)`

Register a handler invoked before each agent run starts. The handler receives an `AgentRunContext` (which itself extends `EforgeExtensionContext`, so logger and exec are available on the same object) and may return additional prompt context, custom tools, or tool allow/deny lists. Inspect `ctx.role` inside the handler to scope behavior to a particular agent role.

```ts
eforge.onAgentRun(async (ctx) => {
  if (ctx.role !== "builder") return;
  return {
    promptAppend: "Check the design system before modifying UI components.",
    tools: [myCustomTool],
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
}
```

**`AgentRunAugmentation`:**

```ts
interface AgentRunAugmentation {
  promptAppend?: string;
  tools?: ExtensionTool[];
  allowedTools?: string[];
  disallowedTools?: string[];
}
```

**Runtime status:** registration is captured at load time; agent augmentation execution is deferred.

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

Register a function that selects an agent runtime profile for each build. Called before each plan's build phase begins.

**Signature:**

```ts
registerProfileRouter(spec: ProfileRouterSpec): void
```

**`ProfileRouterSpec`:**

```ts
interface ProfileRouterSpec {
  name: string;
  resolve: (
    ctx: AgentRunContext,
  ) => ProfileRouterResult | null | undefined | Promise<ProfileRouterResult | null | undefined>;
}

interface ProfileRouterResult {
  profile: string;
}
```

Return `null` or `undefined` from `resolve` to defer to the next registered router (or the default profile).

**Runtime status:** registration is captured at load time; profile routing execution is deferred.

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

The daemon can discover, trust-check, import, and execute extension factories. During factory execution it records registrations for all SDK methods below and exposes counts through `eforge extension` CLI commands and extension daemon APIs. Runtime dispatch is available for `onEvent`; blocking and non-event capability execution are intentionally deferred for later phases.

| Capability | Type contract | Loader-time registration capture | Runtime execution today |
|-----------|---------------|----------------------------------|-------------------------|
| `onEvent` | Yes | Yes | Yes |
| `onAgentRun` | Yes | Yes | Deferred |
| `registerTool` / `ExtensionTool` | Yes | Yes | Deferred |
| `beforePlanMerge` policy gate | Yes | Yes | Deferred |
| `registerProfileRouter` | Yes | Yes | Deferred |
| `registerInputSource` | Yes | Yes | Deferred |
| `registerReviewerPerspective` | Yes | Yes | Deferred |
| `registerValidationProvider` | Yes | Yes | Deferred |

Loaded extensions therefore appear in provenance and validation output today, including registration summaries and diagnostics. Event hook examples run at runtime and receive correlated events. Agent augmentation, custom tool injection/execution, blocking policy enforcement, profile routing, input-source execution, reviewer perspective execution, and validation-provider execution are future runtime work.

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

Toolbelt filtering applies only to project MCP servers declared in `.mcp.json`. It does not filter engine-internal tools, harness built-ins, or extension-contributed custom tools. Extensions that use `onAgentRun` to add tools bypass toolbelt filtering by design - these are trusted extension-contributed capabilities, not MCP-discovered ones.

Extensions may read profile and toolbelt metadata (via context fields added in future epics) to make decisions such as profile routing. Extensions must not write profile marker files or redefine toolbelt declarations.
