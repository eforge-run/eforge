---
title: Extensions
description: TypeScript extensions that observe and influence eforge lifecycle behavior.
---

# Extensions

Extensions are TypeScript modules that observe or influence eforge lifecycle behavior. They are the typed, programmatic counterpart to shell hooks: where hooks fire shell commands on events, extensions can subscribe to typed events, augment agent runs, enforce policy gates, route profiles, and contribute custom tools - all with full TypeScript inference.

This is different from shell hooks, which are fire-and-forget and cannot influence the pipeline. Extensions registered as policy gates can block or require approval; extensions registered as agent-run augmenters can contribute tools and prompt context. See [Relationship to shell hooks](#relationship-to-shell-hooks-playbooks-and-toolbelts) for a full boundary comparison.

## Scopes

Extensions follow the same three-tier scope model as profiles and playbooks:

| Scope | Directory | Purpose |
|-------|-----------|---------|
| User | `~/.config/eforge/extensions/` | Personal extensions reusable across projects |
| Project/team | `eforge/extensions/` | Shared, committed team extensions |
| Project-local | `.eforge/extensions/` | Local experiments and personal project overrides |

Precedence order: `project-local > project-team > user`

Project-local is the recommended starting point for new extensions. Use `eforge/extensions/` (committed) once an extension has been validated and is intended for the whole team.

## Minimal example

An extension is a TypeScript module with a default-export factory function that receives the eforge extension API:

```ts
// eforge/extensions/build-notifier.ts
import type { EforgeExtensionAPI } from "@eforge-build/extension-sdk";

export default function extension(eforge: EforgeExtensionAPI) {
  eforge.onEvent("plan:build:failed", async (event, ctx) => {
    ctx.logger.warn(`Plan failed: ${event.planId}`);
  });
}
```

The factory receives an `EforgeExtensionAPI` instance. Call registration methods on it during the factory invocation. You can also use the `defineEforgeExtension` helper for named-export style with parameter inference:

```ts
import { defineEforgeExtension } from "@eforge-build/extension-sdk";

export default defineEforgeExtension((eforge) => {
  eforge.onEvent("plan:build:*", async (event, ctx) => {
    ctx.logger.info(`Build event: ${event.type}`);
  });
});
```

`defineEforgeExtension` is a no-op identity helper; it exists solely so TypeScript can infer the factory parameter type without an explicit import of `EforgeExtensionAPI`.

## Schema language

The SDK uses [TypeBox](https://github.com/sinclairzx81/typebox) as its schema language. TypeBox types are used when defining custom tool input schemas:

```ts
import { defineExtensionTool, Type } from "@eforge-build/extension-sdk";

const myTool = defineExtensionTool({
  name: "my-tool",
  description: "Does something useful",
  inputSchema: Type.Object({
    path: Type.String(),
    verbose: Type.Optional(Type.Boolean()),
  }),
  handler: async ({ path, verbose }) => {
    return `processed: ${path}`;
  },
});
```

Zod does not appear anywhere in the SDK's public surface. If you use Zod in your extension's internal implementation, you are responsible for any type adaption at the boundary.

## Event patterns

Event subscriptions accept glob-style patterns using `*` as a wildcard. The `*` wildcard matches any characters including `:`, so it can span segments:

| Pattern | Matches |
|---------|---------|
| `plan:build:failed` | Exact match only |
| `plan:build:*` | `plan:build:start`, `plan:build:complete`, `plan:build:failed`, etc. |
| `*:complete` | `planning:complete`, `plan:build:complete`, `expedition:wave:complete`, etc. |
| `*` | Every event |

These semantics are identical to shell hook patterns in `eforge/config.yaml`. Extensions and shell hooks share one mental model for event targeting. See `docs/hooks.md` for the full event type list.

You can also use the SDK's pattern helpers directly:

```ts
import { matchesEventPattern, compileEventPattern } from "@eforge-build/extension-sdk";

matchesEventPattern("plan:build:*", "plan:build:failed"); // true
matchesEventPattern("*:complete", "expedition:wave:complete"); // true
```

## Relationship to shell hooks, playbooks, and toolbelts

Each mechanism has a distinct role:

| Mechanism | Language | Can block pipeline | Can augment agents |
|-----------|----------|-------------------|-------------------|
| Shell hooks | Bash | No (fire-and-forget) | No |
| Playbooks | Markdown | No | Indirectly (prompt context) |
| Profile toolbelts | YAML (declarative) | No | Indirectly (MCP tools) |
| Extensions | TypeScript | Yes (policy gates) | Yes (agent run augmentation) |

**Toolbelts vs extensions:** Toolbelts are declarative MCP capability bundles selected by agent runtime profiles. They answer "which MCP servers should this tier expose?" Extensions are imperative TypeScript modules. They answer "what should eforge do when something happens?" Extensions may inspect profile metadata when making decisions (e.g. routing to a specific profile), but they should not redefine toolbelts or become a hidden profile/config layer.

Extension-contributed custom tools and toolbelt-selected MCP tools remain distinct categories in the effective tool surface:

```
engine-internal tools
+ profile/toolbelt-selected project MCP tools
+ extension-contributed custom tools
- explicit allowed/disallowed filters
```

## Runtime support today

The `@eforge-build/extension-sdk` package is the type contract for the extension API. The table below shows what ships in this release (EXTEND_01) versus what is planned in future epics:

| Capability | Type contract | Runtime today | Planned epic |
|-----------|--------------|---------------|--------------|
| `onEvent` - typed event subscriptions | Yes | EXTEND_02 | EXTEND_02 |
| `onAgentRun` - agent augmentation | Yes | No | EXTEND_02 |
| `beforePlanMerge` - policy gate | Yes | No | EXTEND_03 |
| `registerProfileRouter` | Yes | No | EXTEND_03 |
| `registerInputSource` | Yes | No | EXTEND_04 |
| `registerReviewerPerspective` | Yes | No | EXTEND_04 |
| `registerValidationProvider` | Yes | No | EXTEND_04 |

In EXTEND_01, the SDK package exists and is type-checkable. Writing extensions now lets you verify your types and example logic. Runtime loading, daemon integration, and the `/eforge:extend` skill ship in subsequent epics.

## Trust and security

Extension loading is not yet implemented. When runtime loading ships, extensions will require explicit trust (via `eforge extension trust <name>` or equivalent) before they run. Extensions are TypeScript modules executed in the same Node.js process as the daemon - they are not sandboxed. Only load extensions from sources you trust.

## API reference

For full type signatures and method documentation, see [Extensions API Reference](/docs/extensions-api).
