# Extension examples

These examples demonstrate the `@eforge-build/extension-sdk` API. Each example is imported by `test/extension-sdk-example.test.ts` so TypeScript verifies its default export conforms to `EforgeExtensionFactory`.

## Examples

| Example | Primary API | Runtime status |
|---------|-------------|----------------|
| `minimal-event-logger.ts` | `onEvent('plan:build:failed', ...)` | Runtime-supported event dispatch and replay |
| `slack-webhook-notifier.ts` | `onEvent('plan:error:set', ...)` | Runtime-supported event dispatch and replay; webhook send is skipped unless `EFORGE_SLACK_WEBHOOK_URL` is set |
| `agent-context.ts` | `onAgentRun(...)` | Runtime-supported prompt-context augmentation |
| `agent-tools.ts` | `defineExtensionTool(...)`, `registerTool(...)`, `onAgentRun(...)` | Runtime-supported per-run extension tool injection and availability tuning |
| `profile-router.ts` | `registerProfileRouter(...)` | Runtime-supported pre-build dispatch; explicit `profile:` frontmatter wins; routers fail open |
| `protected-paths.ts` | `beforePlanMerge(...)`, `beforeFinalMerge(...)` | Runtime-supported policy enforcement for plan/final merge protected paths |

### `minimal-event-logger.ts`

Subscribes to `plan:build:failed` events and logs through the extension context logger. Demonstrates default-export factory style, typed `onEvent` subscription, and `EventOfType<T>` narrowing.

### `slack-webhook-notifier.ts`

Subscribes to `plan:error:set` lifecycle events and formats a Slack-compatible webhook payload. The example is safe by default:

- It reads the destination from `EFORGE_SLACK_WEBHOOK_URL`.
- It contains no real webhook URL or token.
- It logs and skips when the env var is unset, so import tests and replay tests do not require network credentials.

> **Replay note:** `eforge extension test` executes matching event hooks. If `EFORGE_SLACK_WEBHOOK_URL` is set, replaying matching `plan:error:set` events will send webhook requests.

### `agent-context.ts`

Appends role- and tier-scoped context to agent prompts at runtime using the `onAgentRun` hook. Demonstrates filtering by `ctx.role` and `ctx.tier`, returning `{ promptAppend: '...' }`, and including lifecycle metadata such as `ctx.phase`.

The returned fragment is appended after any config-level `promptAppend`, wrapped in a named provenance section (`## Native extension context / ### <extension-name>`). Handlers are fail-open: a throw or timeout emits a typed `extension:agent-context:*` diagnostic but does not abort the agent run.

> **Runtime note:** `promptAppend` is runtime-supported. Use `agent-tools.ts` for the supported custom-tool injection pattern.

### `agent-tools.ts`

Defines a TypeBox-backed tool with `defineExtensionTool`, registers it with `eforge.registerTool(...)` for loader-time provenance, and returns it from `eforge.onAgentRun(...)` only for builder runs. The prompt text uses `ctx.effectiveToolName(...)` so the agent sees the harness-visible tool name.

The example also includes a conservative `disallowedTools` entry to show that `allowedTools` and `disallowedTools` are per-run harness availability tuning, not toolbelt configuration. Toolbelts continue to select only project MCP servers declared in `.mcp.json`.

### `profile-router.ts`

Implements a Claude → Codex → local fallback profile selection strategy using `registerProfileRouter`. Demonstrates `selectBuildProfile`, `ctx.usage.profile(name)`, returning `{ profile, reason, confidence }`, returning `null` to defer, and env-var-driven configuration (`EFORGE_PROFILE_PRIMARY`, `EFORGE_PROFILE_SECONDARY`, `EFORGE_PROFILE_LOCAL`).

Default profile names are `claude-sdk-4-7` (primary), `pi-codex-5-5` (secondary), and `pi-deepseek-qwen` (local fallback). All three can be overridden via environment variables.

> **Runtime note:** `registerProfileRouter` is wired for pre-build dispatch. Routers run in registration order before a queued PRD build; explicit `profile:` frontmatter takes precedence and skips routers; failures/timeouts are fail-open.

### `protected-paths.ts`

Uses `eforge.beforePlanMerge` and `eforge.beforeFinalMerge` to block merges that touch a protected path. Demonstrates runtime-supported policy gate registration and the `PolicyDecision` discriminated union (`allow` / `block` / `require-approval`).

> **Runtime note:** `beforePlanMerge` and `beforeFinalMerge` are runtime-supported blocking policy gates. `require-approval` currently blocks because no approval workflow exists; `beforeEnqueue`, `beforeValidation`, approval UI/state, and `modify` decisions remain deferred.

## Validation

From the repo root, targeted validation for these examples is:

```sh
pnpm test -- test/extension-sdk-example.test.ts
pnpm test -- test/extension-tooling-wiring.test.ts
pnpm docs:check
```

To replay event-oriented examples manually, create a fixture containing a canonical eforge event and run:

```sh
eforge extension test ./examples/extensions/minimal-event-logger.ts --fixture events.json
eforge extension test ./examples/extensions/slack-webhook-notifier.ts --fixture events.json
```

There is no separate build step for the examples directory. The vitest test at `test/extension-sdk-example.test.ts` imports every `examples/extensions/*.ts` default export, which forces TypeScript to type-check them as part of the test run.
