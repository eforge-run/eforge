---
id: plan-06-config
name: Config
depends_on: [plan-01-foundation]
branch: forge-v1/config
---

# Config

## Architecture Context

This module implements the **config** layer — `forge.yaml` project configuration loading and Langfuse tracing setup. Wave 2 (parallel with planner, builder, reviewer, orchestration).

Key constraints:
- Config lives in `src/engine/config.ts` — pure library code, no stdout
- `forge.yaml` is optional — defaults apply when missing
- Langfuse credentials from env vars or `forge.yaml` — env vars take precedence
- No secrets in state files
- Tracing is opt-in: disabled silently when no credentials

### `forge.yaml` Schema

```yaml
langfuse:
  publicKey: "pk-lf-..."
  secretKey: "sk-lf-..."
  host: "https://cloud.langfuse.com"

agents:
  maxTurns: 30
  permissionMode: bypass

build:
  parallelism: 4
  worktreeDir: null

plan:
  outputDir: "plans"
```

### ForgeConfig Type

```typescript
interface ForgeConfig {
  langfuse: { enabled: boolean; publicKey?: string; secretKey?: string; host: string };
  agents: { maxTurns: number; permissionMode: 'bypass' | 'default' };
  build: { parallelism: number; worktreeDir?: string };
  plan: { outputDir: string };
}
```

### TracingContext Interface

```typescript
interface TracingContext {
  createSpan(agent: AgentRole, metadata?: Record<string, unknown>): SpanHandle;
  flush(): Promise<void>;
}

interface SpanHandle {
  setInput(input: unknown): void;
  setOutput(output: unknown): void;
  setUsage(usage: { input: number; output: number; total: number }): void;
  end(): void;
  error(err: Error | string): void;
}
```

## Implementation

### Key Decisions

1. **Separate `config.ts` and `tracing.ts`** — config is pure data; tracing is runtime with SDK state.
2. **`forge.yaml` is optional** — zero config for simple use cases.
3. **Env vars override file config** — 12-factor pattern for CI/CD.
4. **`TracingContext` is a plain interface** — agents receive functions, no conditional checks needed. No-op stubs when disabled.
5. **Langfuse `flush()` on process exit** — called in forge-core's finally block.
6. **Runtime validation, no schema library** — config is small, TypeScript narrowing sufficient.
7. **Config search walks up from cwd** — like `tsconfig.json` resolution.

### Resolution Logic

1. Search for forge.yaml: cwd → parent → ... → root
2. Parse and validate
3. Apply defaults for missing fields
4. Override langfuse with env vars (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`)
5. Set `langfuse.enabled = true` only when both keys present
6. Return frozen `ForgeConfig`

## Scope

### In Scope
- `ForgeConfig` type, `DEFAULT_CONFIG`
- `loadConfig(cwd?)` — find, read, parse, validate, merge
- `findConfigFile(startDir)` — walk up directory tree
- `resolveConfig(fileConfig, env)` — merge env vars
- `TracingContext`, `SpanHandle` interfaces
- `createTracingContext(config, runId, command)` — live Langfuse or no-op
- `createNoopTracingContext()` — safe no-op stubs
- Add `langfuse` npm dependency

### Out of Scope
- Agent consumption of TracingContext — agent modules
- ForgeEngine wiring — forge-core
- CLI argument parsing — cli module

## Files

### Create

- `src/engine/config.ts` — `ForgeConfig`, `loadConfig()`, `resolveConfig()`, `findConfigFile()`, `DEFAULT_CONFIG`
- `src/engine/tracing.ts` — `TracingContext`, `SpanHandle`, `createTracingContext()`, `createNoopTracingContext()`

### Modify

- `package.json` — Add `langfuse` to `dependencies`
- `src/engine/index.ts` — Add re-exports from `config.ts` and `tracing.ts`

## Verification

- [ ] `pnpm run type-check` passes with zero errors
- [ ] `pnpm run build` produces `dist/cli.js` without errors
- [ ] `ForgeConfig` covers all forge.yaml fields (langfuse, agents, build, plan)
- [ ] `DEFAULT_CONFIG` has sensible defaults (tracing disabled, maxTurns 30, parallelism from CPU cores, outputDir "plans")
- [ ] `findConfigFile()` walks up directory tree, returns path or null
- [ ] `loadConfig()` returns `DEFAULT_CONFIG` when no forge.yaml exists
- [ ] `loadConfig()` correctly parses valid forge.yaml and merges with defaults
- [ ] `loadConfig()` handles malformed forge.yaml gracefully (logs warning, returns defaults)
- [ ] Env vars override forge.yaml values
- [ ] `langfuse.enabled` true only when both keys present
- [ ] `createTracingContext()` returns live context when enabled
- [ ] `createTracingContext()` returns no-op context when disabled
- [ ] No-op `createSpan()` returns safe SpanHandle (no errors, no side effects)
- [ ] Live `createSpan()` creates Langfuse span with agent name and metadata
- [ ] `SpanHandle.end()` finalizes with success, `error()` with error status
- [ ] `TracingContext.flush()` calls `langfuse.flushAsync()`
- [ ] All exports via `src/engine/index.ts` barrel
- [ ] `langfuse` package added to `dependencies`
