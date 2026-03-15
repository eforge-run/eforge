---
id: plan-01-twinkly-cuddling-lake
name: "Plan: Clean up plan files after successful build"
depends_on: []
branch: twinkly-cuddling-lake/main
---

# Plan: Clean up plan files after successful build

## Context

eforge commits plan files to `plans/{planSetName}/` during planning (required for worktree-based builds). After a successful build, these files remain permanently in the repo, cluttering it. This adds automatic cleanup: `git rm` the plan directory and commit the removal after a successful build. Cleanup is on by default, opt-out via config or CLI flag.

## Changes

### 1. `src/engine/events.ts` — Add cleanup events and BuildOptions field

Add to `EforgeEvent` union (after validation section, before user interaction):
```typescript
// Cleanup (post-build)
| { type: 'cleanup:start'; planSet: string }
| { type: 'cleanup:complete'; planSet: string }
```

Add `cleanup?: boolean` to `BuildOptions` interface.

### 2. `src/engine/config.ts` — Add `cleanupPlanFiles` config

- Add `cleanupPlanFiles: boolean` to `EforgeConfig['build']` type (line 25)
- Add `cleanupPlanFiles: true` to `DEFAULT_CONFIG.build` (line 43)
- Add parsing in `parseRawConfig()` build section (~line 157):
  ```typescript
  ...(typeof bd.cleanupPlanFiles === 'boolean' ? { cleanupPlanFiles: bd.cleanupPlanFiles } : {}),
  ```
- Add to `resolveConfig()` build section (~line 98):
  ```typescript
  cleanupPlanFiles: fileConfig.build?.cleanupPlanFiles ?? DEFAULT_CONFIG.build.cleanupPlanFiles,
  ```

### 3. `src/engine/eforge.ts` — Core cleanup logic

Add a private async generator function after the existing helpers (~line 788):

```typescript
async function* cleanupPlanFiles(cwd: string, planSet: string): AsyncGenerator<EforgeEvent> {
  yield { type: 'cleanup:start', planSet };
  const planDir = resolve(cwd, 'plans', planSet);
  await exec('git', ['rm', '-r', planDir], { cwd });

  // Remove empty plans/ directory
  const plansDir = resolve(cwd, 'plans');
  try {
    const remaining = await readdir(plansDir);
    if (remaining.length === 0) {
      await rm(plansDir, { recursive: true });
    }
  } catch { /* may already be gone */ }

  await exec('git', ['commit', '-m', `cleanup(${planSet}): remove plan files after successful build`], { cwd });

  // Clean up state file (gitignored)
  try { await rm(resolve(cwd, '.eforge', 'state.json')); } catch {}

  yield { type: 'cleanup:complete', planSet };
}
```

Add `readdir` and `rm` to `node:fs/promises` import (line 9).

In `build()` method, after the orchestrator event loop (after line 674), before the catch block:

```typescript
const shouldCleanup = options.cleanup ?? this.config.build.cleanupPlanFiles;
if (status === 'completed' && shouldCleanup) {
  try {
    yield* cleanupPlanFiles(cwd, planSet);
  } catch { /* non-fatal */ }
}
```

### 4. `src/cli/display.ts` — Render cleanup events

Add cases before the `default` exhaustive check (~line 420):

```typescript
case 'cleanup:start':
  startSpinner('cleanup', `Cleaning up plan files for ${chalk.cyan(event.planSet)}...`);
  break;
case 'cleanup:complete':
  succeedSpinner('cleanup', `Plan files removed for ${chalk.cyan(event.planSet)}`);
  break;
```

### 5. `src/cli/index.ts` — Wire `--no-cleanup` flag

Add `.option('--no-cleanup', 'Keep plan files after successful build')` to both `run` (line 179) and `build` (line 269) commands.

Add `cleanup?: boolean` to both action handler option types.

Pass through to `engine.build()`:
```typescript
engine.build(planSet, { ..., cleanup: options.cleanup, ... })
```

## Verification

1. `pnpm type-check` — confirms new events satisfy exhaustive switch
2. `pnpm test` — existing tests pass
3. Manual test: run `pnpm dev -- run <prd> --auto --verbose`, verify plan files are removed and cleanup commit exists in git log after successful completion
4. Manual test: run with `--no-cleanup`, verify plan files remain
