# Extension examples

These examples demonstrate the `@eforge-build/extension-sdk` API. Each example is type-checked as part of the root validation pipeline.

## Examples

### `minimal-event-logger.ts`

Subscribes to `plan:build:failed` events and logs through the extension context logger. `onEvent` registrations are runtime-supported; handler errors and timeouts emit extension diagnostics. Demonstrates:

- Default-export factory style
- Typed event subscription with `onEvent`
- `EventOfType<T>` narrowing to access event-specific fields

### `agent-context.ts`

Appends role- and tier-scoped context to agent prompts at runtime using the `onAgentRun` hook. Demonstrates:

- Filtering by `ctx.role` and `ctx.tier` to scope contributions
- Returning `{ promptAppend: '...' }` to inject context before a specific agent run
- Surfacing `ctx.phase` in the appended fragment for lifecycle-aware augmentation (handlers can also filter on `ctx.stage`)

The returned fragment is appended after any config-level `promptAppend` already resolved by the engine, wrapped in a named provenance section (`## Native extension context / ### <extension-name>`). Handlers are fail-open: a throw or timeout emits a typed `extension:agent-context:*` diagnostic but does not abort the agent run.

> **Runtime note:** `promptAppend` is runtime-supported. Returning `tools`, `allowedTools`, or `disallowedTools` emits an `extension:agent-context:unsupported` diagnostic; tool injection is tracked for EXTEND_08B.

### `protected-paths.ts`

Uses `eforge.beforePlanMerge` to block merges that touch a protected path. Demonstrates:

- Policy gate registration
- `PolicyDecision` discriminated union (`allow` / `block`)

> **Runtime note:** `beforePlanMerge` is loaded and captured for provenance, but policy-gate enforcement remains deferred to a later runtime phase. The example is labelled accordingly.

## Validation

Examples are type-checked through the vitest pipeline. From the repo root:

```sh
pnpm -r build        # build all workspace packages (including extension-sdk)
pnpm -r type-check   # type-check all packages; examples are covered via test/extension-sdk-example.test.ts
pnpm test            # run all tests, including the SDK surface and pattern parity tests
```

There is no separate build step for the examples directory. The vitest test at `test/extension-sdk-example.test.ts` imports the example files, which forces TypeScript to type-check them as part of the test run.
