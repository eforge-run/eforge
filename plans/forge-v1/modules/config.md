# Config

## Architecture Reference

This module implements the **config** layer from the architecture — `forge.yaml` project configuration loading and Langfuse tracing setup (Wave 2, parallel with planner/builder/reviewer/orchestration).

Key constraints from architecture:
- Config lives in `src/engine/config.ts` — pure library code, no stdout
- `forge.yaml` is an optional per-project config file at the repo root
- Langfuse tracing wraps agent SDK `query()` calls with spans — one trace per invocation, spans per agent call
- Langfuse credentials come from env vars (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`) or `forge.yaml` — env vars take precedence
- No secrets stored in state files — config is read-only at startup
- Tracing is opt-in: if no Langfuse credentials are available, tracing is silently disabled

## Scope

### In Scope
- `ForgeConfig` type definition — typed representation of `forge.yaml`
- `forge.yaml` loader — find, read, parse, validate, merge with defaults
- Config resolution — merge file config with env vars (env vars win)
- Langfuse client initialization — create and configure `Langfuse` instance from resolved config
- Tracing helpers — `createTrace(runId, command)`, `createSpan(trace, agent, planId?)`, `flushTracing()`
- `TracingContext` type — passed into agents so they can create child spans without knowing Langfuse internals
- Graceful degradation — missing/invalid config or Langfuse credentials result in no-op tracing, not errors
- Add `langfuse` npm dependency

### Out of Scope
- Agent implementations that consume `TracingContext` — respective agent modules
- ForgeEngine wiring (creating traces, passing context) — forge-core module
- CLI argument parsing — cli module
- Event persistence / recording middleware — future (Phase 6)
- `forge.yaml` generation / `init` command — future

## Dependencies

| Module | Dependency Type | Notes |
|--------|-----------------|-------|
| foundation | Build-time | Uses `AgentRole` type from `events.ts` for span naming |

### External Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `yaml` | ^2.x | Parse `forge.yaml` (already added by foundation module) |
| `langfuse` | ^3.x | Langfuse JS SDK for tracing agent calls |

## Implementation Approach

### Overview

Two focused files: `config.ts` for configuration loading and `tracing.ts` for Langfuse integration. Config is loaded once at startup and produces a resolved `ForgeConfig`. Tracing wraps the Langfuse SDK behind a thin `TracingContext` interface so that agents and the orchestrator can instrument their work without direct Langfuse coupling. When tracing is disabled (no credentials), all tracing functions are no-ops.

### Key Decisions

1. **Separate `config.ts` and `tracing.ts`** — Config loading is pure data parsing; tracing is a runtime concern with SDK state. Keeping them separate follows single-responsibility and makes testing easier.
2. **`forge.yaml` is optional** — If missing, all defaults apply. The tool should work with zero configuration for simple use cases.
3. **Env vars override file config** — Standard 12-factor pattern. Enables CI/CD and per-environment overrides without touching `forge.yaml`.
4. **`TracingContext` is a plain interface, not a class** — Agents receive `{ trace, createSpan, endSpan }` functions. When tracing is disabled, these are no-op stubs. No conditional checks needed in agent code.
5. **Langfuse `flush()` on process exit** — Langfuse batches events. `flushTracing()` must be called before the process exits (in forge-core's finally block) to ensure all spans are sent.
6. **Config validation uses runtime checks, not a schema library** — `forge.yaml` is small and well-defined. Adding zod/ajv would be overkill. TypeScript narrowing + explicit checks are sufficient.
7. **`forge.yaml` search walks up from cwd** — Similar to how `.gitignore` or `tsconfig.json` resolution works. Finds the nearest `forge.yaml` in the directory tree up to the filesystem root.

### `forge.yaml` Schema

```yaml
# forge.yaml — project-level configuration for forge

# Langfuse tracing (optional — env vars override these)
langfuse:
  publicKey: "pk-lf-..."
  secretKey: "sk-lf-..."
  host: "https://cloud.langfuse.com"  # defaults to cloud

# Agent defaults
agents:
  maxTurns: 30             # max SDK query turns per agent call (default: 30)
  permissionMode: bypass   # "bypass" (default) or "default"

# Build defaults
build:
  parallelism: 4           # max concurrent plans (default: number of CPU cores)
  worktreeDir: null        # override sibling worktree directory (default: ../{project}-{set}-worktrees/)

# Plan defaults
plan:
  outputDir: "plans"       # where plan files are written (default: "plans")
```

### `ForgeConfig` Type

```typescript
interface ForgeConfig {
  langfuse: {
    enabled: boolean;
    publicKey?: string;
    secretKey?: string;
    host: string;
  };
  agents: {
    maxTurns: number;
    permissionMode: 'bypass' | 'default';
  };
  build: {
    parallelism: number;
    worktreeDir?: string;
  };
  plan: {
    outputDir: string;
  };
}
```

### `TracingContext` Interface

```typescript
interface TracingContext {
  /** Create a span for an agent call. Returns a SpanHandle for ending it. */
  createSpan(agent: AgentRole, metadata?: Record<string, unknown>): SpanHandle;
  /** Flush all pending traces to Langfuse. Call before process exit. */
  flush(): Promise<void>;
}

interface SpanHandle {
  /** Record input to the span (e.g., prompt text) */
  setInput(input: unknown): void;
  /** Record output from the span (e.g., event summary) */
  setOutput(output: unknown): void;
  /** Record token usage */
  setUsage(usage: { input: number; output: number; total: number }): void;
  /** End the span with success status */
  end(): void;
  /** End the span with error status */
  error(err: Error | string): void;
}
```

### Resolution Logic

```
1. Search for forge.yaml: cwd → parent → ... → filesystem root
2. If found, parse with yaml.parse() and validate structure
3. Apply defaults for missing fields
4. Override langfuse fields with env vars if set:
   - LANGFUSE_PUBLIC_KEY → langfuse.publicKey
   - LANGFUSE_SECRET_KEY → langfuse.secretKey
   - LANGFUSE_HOST → langfuse.host
5. Set langfuse.enabled = true only if both publicKey and secretKey are present
6. Return frozen ForgeConfig
```

## Files

### Create

- `src/engine/config.ts` — `ForgeConfig` type, `loadConfig(cwd?)`, `resolveConfig(fileConfig, env)`, `findConfigFile(startDir)`, `DEFAULT_CONFIG`
- `src/engine/tracing.ts` — `TracingContext`, `SpanHandle`, `createTracingContext(config, runId, command)`, `createNoopTracingContext()`. Wraps Langfuse SDK; exports no-op variant for when tracing is disabled.

### Modify

- `package.json` — Add `langfuse` to `dependencies`
- `src/engine/index.ts` — Add re-exports from `config.ts` and `tracing.ts` (barrel file created by foundation module)

## Testing Strategy

No test framework is configured yet. Verification will be done via type-checking and manual validation.

### Type Check
- `pnpm type-check` must pass with zero errors
- `ForgeConfig` type must be compatible with all config access patterns in architecture spec

### Manual Validation
- Call `loadConfig()` with no `forge.yaml` present — returns `DEFAULT_CONFIG` with tracing disabled
- Call `loadConfig()` with a sample `forge.yaml` — returns merged config with correct overrides
- Call `loadConfig()` with `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` env vars set — env vars override file values, tracing enabled
- Call `loadConfig()` with only one Langfuse key set — tracing remains disabled
- Call `findConfigFile()` from a nested directory — walks up and finds `forge.yaml` in an ancestor
- Call `createTracingContext()` with tracing disabled — returns no-op context where `createSpan()` returns inert `SpanHandle`
- Call `createTracingContext()` with valid Langfuse config — returns live context (verify with Langfuse dashboard or mock)

### Build
- `pnpm build` must succeed — tsup bundles all new files

## Verification Criteria

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm build` produces `dist/cli.js` without errors
- [ ] `ForgeConfig` type covers all fields from the `forge.yaml` schema (langfuse, agents, build, plan)
- [ ] `DEFAULT_CONFIG` provides sensible defaults for all fields (tracing disabled, maxTurns 30, parallelism from CPU cores, outputDir "plans")
- [ ] `findConfigFile()` walks up directory tree from `cwd` and returns path to nearest `forge.yaml`, or `null` if none found
- [ ] `loadConfig()` returns `DEFAULT_CONFIG` when no `forge.yaml` exists
- [ ] `loadConfig()` correctly parses a valid `forge.yaml` and merges with defaults
- [ ] `loadConfig()` ignores malformed `forge.yaml` gracefully (logs warning, returns defaults)
- [ ] Environment variables (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`) override corresponding `forge.yaml` values
- [ ] `langfuse.enabled` is `true` only when both `publicKey` and `secretKey` are present (from either source)
- [ ] `createTracingContext()` returns a live `TracingContext` when Langfuse is enabled
- [ ] `createTracingContext()` returns a no-op `TracingContext` when Langfuse is disabled
- [ ] No-op `TracingContext.createSpan()` returns a `SpanHandle` whose methods are safe to call (no errors, no side effects)
- [ ] Live `TracingContext.createSpan()` creates a Langfuse span with correct `agent` name and optional `planId` metadata
- [ ] `SpanHandle.setInput()`, `setOutput()`, `setUsage()` record data on the Langfuse span
- [ ] `SpanHandle.end()` finalizes the span with success status
- [ ] `SpanHandle.error()` finalizes the span with error status and message
- [ ] `TracingContext.flush()` calls `langfuse.flushAsync()` to ensure all pending events are sent
- [ ] All exports available via `src/engine/index.ts` barrel
- [ ] `langfuse` package added to `dependencies` in `package.json`
