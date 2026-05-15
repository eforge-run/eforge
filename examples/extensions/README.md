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

### `profile-router.ts`

Implements a Claude → Codex → local fallback profile selection strategy using `registerProfileRouter`. Demonstrates:

- `selectBuildProfile` as the canonical router method (preferred over the deprecated `resolve`)
- Consulting `ctx.usage.profile(name)` to check `cooldownActive` and `nearLimit` before selecting
- Returning `{ profile, reason, confidence }` with human-readable rationale
- Returning `null` to defer when no candidate is suitable (fail-open)
- Env-var-driven configuration (`EFORGE_PROFILE_PRIMARY`, `EFORGE_PROFILE_SECONDARY`, `EFORGE_PROFILE_LOCAL`) so users can experiment without editing code

Default profile names are `claude-sdk-4-7` (primary), `pi-codex-5-5` (secondary), and `pi-deepseek-qwen` (local fallback). All three can be overridden via environment variables.

**Selection logic:**
1. If the primary profile is available (exists in scope, no cooldown, not near-limit), select it with `confidence: 'high'`.
2. Else if the secondary profile is available, select it with `confidence: 'medium'`.
3. Else if the local fallback profile exists in any scope (no quota check), select it with `confidence: 'low'`.
4. If none of the three are available, return `null` — other routers or the default profile take over.

**Usage data:** `ctx.usage.profile(name)` returns `{ dataSource: 'none' }` when the daemon has no event history for the profile (e.g. first run or CLI mode). In that case `cooldownActive` and `nearLimit` are undefined, so the profile is treated as available.

**No active-profile mutation:** this router never calls `setActiveProfile` or writes any marker file. Routing is dispatch-time only and does not persist outside the enqueued PRD's frontmatter.

> **Runtime note:** `registerProfileRouter` is fully wired — routers run before each PRD build in the queue. The runtime dispatches routers in registration order, fail-open.

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
