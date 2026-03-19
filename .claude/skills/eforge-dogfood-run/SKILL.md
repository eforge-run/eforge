---
description: Dogfood single run - rebuilds eforge from source, then runs the standard /eforge:run workflow using the local binary instead of npx.
argument-hint: "<source> [--queue] [--watch]"
---

# /eforge-dogfood-run

Thin wrapper around the plugin's `/eforge:run` skill for local development. Rebuilds eforge from source so self-modifications from prior builds take effect, then delegates to the standard run workflow using the local binary on PATH.

**Prerequisite**: Must be run from the eforge project root with `pnpm` available and `eforge` on PATH via `pnpm link --global`.

## Workflow

### Step 1: Build

Run a full build to pick up any source changes:

```bash
pnpm build
```

**On build failure**: Stop immediately. Show the build error and tell the user to fix it before retrying. Do not continue to Step 2.

**On success**: Report the build succeeded and continue.

### Step 2: Run

Read the plugin skill at `eforge-plugin/skills/run/run.md` and follow its complete workflow with these modifications:

- Use `eforge` (local binary on PATH) instead of `npx --yes eforge@latest` for all commands
- All arguments, flags, source validation, monitoring instructions, and error handling from the plugin skill apply unchanged

Pass through all arguments from this skill's invocation to the plugin workflow.
