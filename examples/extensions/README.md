# Extension examples

These examples demonstrate the `@eforge-build/extension-sdk` API. Each example is type-checked as part of the root validation pipeline.

## Examples

### `minimal-event-logger.ts`

Subscribes to `plan:build:failed` events and logs through the extension context logger. Demonstrates:

- Default-export factory style
- Typed event subscription with `onEvent`
- `EventOfType<T>` narrowing to access event-specific fields

### `protected-paths.ts`

Uses `eforge.beforePlanMerge` to block merges that touch a protected path. Demonstrates:

- Policy gate registration
- `PolicyDecision` discriminated union (`allow` / `block`)

> **Runtime note:** `beforePlanMerge` is a type-level contract in this release. The policy gate runtime wires up in a subsequent epic (EXTEND_03). The example is labelled accordingly.

## Validation

Examples are type-checked through the vitest pipeline. From the repo root:

```sh
pnpm -r build        # build all workspace packages (including extension-sdk)
pnpm -r type-check   # type-check all packages; examples are covered via test/extension-sdk-example.test.ts
pnpm test            # run all tests, including the SDK surface and pattern parity tests
```

There is no separate build step for the examples directory. The vitest test at `test/extension-sdk-example.test.ts` imports the example files, which forces TypeScript to type-check them as part of the test run.
