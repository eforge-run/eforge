# @eforge-build/extension-sdk

Type-first API surface for eforge TypeScript extensions. Write extensions that observe or influence eforge lifecycle behavior with full TypeScript inference.

## Install

```sh
npm install @eforge-build/extension-sdk
# or
pnpm add @eforge-build/extension-sdk
```

## Quick start

An extension is a TypeScript module with a default-export factory:

```ts
// eforge/extensions/build-notifier.ts
import type { EforgeExtensionAPI } from "@eforge-build/extension-sdk";

export default function extension(eforge: EforgeExtensionAPI) {
  eforge.onEvent("plan:build:failed", async (event, ctx) => {
    ctx.logger.warn(`Build failed: ${event.planId}`);
  });
}
```

Use `defineEforgeExtension` for named-export style with parameter inference:

```ts
import { defineEforgeExtension } from "@eforge-build/extension-sdk";

export default defineEforgeExtension((eforge) => {
  eforge.onEvent("plan:build:*", async (event, ctx) => {
    ctx.logger.info(`Build event: ${event.type}`);
  });
});
```

## Extension scopes

| Scope | Directory | Purpose |
|-------|-----------|---------|
| User | `~/.config/eforge/extensions/` | Personal, cross-project |
| Project/team | `eforge/extensions/` | Shared, committed |
| Project-local | `.eforge/extensions/` | Local experiments |

## Registration methods

| Method | Description | Runtime status |
|--------|-------------|----------------|
| `onEvent(pattern, handler)` | Subscribe to typed events (glob patterns) | EXTEND_02 |
| `onAgentRun(handler)` | Augment agent runs with tools and prompt context (scope by `ctx.role`) | EXTEND_02 |
| `beforePlanMerge(handler)` | Policy gate before plan branch is merged | EXTEND_03 |
| `registerProfileRouter(spec)` | Select agent runtime profile per build | EXTEND_03 |
| `registerInputSource(adapter)` | Produce PRD/build-source artifacts | EXTEND_04 |
| `registerReviewerPerspective(spec)` | Add custom review perspective | EXTEND_04 |
| `registerValidationProvider(spec)` | Add custom validation step | EXTEND_04 |

All capabilities have full TypeScript type contracts in EXTEND_01. Runtime dispatch lands in subsequent epics.

## Policy decisions

Policy gate handlers return a discriminated union:

```ts
// allow
return { decision: "allow" };

// block
return { decision: "block", reason: "Do not merge .env changes" };

// require human approval (future)
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

eforge.onAgentRun(async (ctx) => {
  if (ctx.role !== "builder") return;
  return { tools: [myTool] };
});
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

Public exports are stability-promised within a major version. The runtime loading, daemon integration, and CLI management commands ship in subsequent epics; the type surface defined here is the stable contract they will implement against.
