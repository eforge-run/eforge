---
title: Redesign `/eforge:init` around multi-runtime profiles
created: 2026-04-28
---

# Redesign `/eforge:init` around multi-runtime profiles

## Problem / Motivation

The current `/eforge:init` flow is broken in two ways:

**Bug (immediate):** `eforge_init` in `packages/eforge/src/cli/mcp-proxy.ts` calls `elicitInput()` three times (harness, provider, max model), but the `/eforge:init` skill (`eforge-plugin/skills/init/init.md` Step 1.5) already asks the user for those values via natural conversation before invoking the tool. Result: the user is prompted twice — once via the skill, then again via the tool's elicitation form (which renders the same model list and feels "stale" because the user just answered). The Pi extension version (`packages/pi-eforge/extensions/eforge/index.ts` lines 977–1198) does **not** elicit; it accepts `provider`/`maxModel` as parameters. The Claude Code MCP proxy was incompletely refactored to that pattern.

**Design gap:** The flow still treats setup as picking a single harness + single model. Profiles are now richer: a profile YAML can declare multiple `agentRuntimes` entries and assign each model tier (or role) to a different runtime — e.g., `claude-sdk` for `max`-tier reasoning, `pi`/openrouter for cheaper `fast`-tier work. The init experience should make that first-class rather than reserving it for `/eforge:profile-new` or hand-edited YAML.

## Goal

The skill drives all elicitation (Claude can present choices in conversation); `eforge_init` becomes a pure persister; users can pick a quick single-harness setup or a mix-and-match per-tier setup.

## Approach

### Skill flow (`eforge-plugin/skills/init/init.md`)

**Step 1 — postMergeCommands**: unchanged. Detect from `package.json`/lockfiles (or `Cargo.toml`/`go.mod`/`Makefile`), propose, accept corrections.

**Step 2 — Setup mode**: ask the user:
> Quick setup (one harness, one model used for every tier) or mix-and-match (pick a different harness/provider/model per tier)?

No default. Both options remain visible.

**Step 3a — Quick path**:
1. Ask harness: `claude-sdk` or `pi`. **No default — user must pick.**
2. If `pi`: call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }`; ask user to pick a provider.
3. Call `mcp__eforge__eforge_models` with `{ action: "list", harness: "<chosen>", provider: "<chosen>?" }`; show top 10 newest-first; ask user to pick the max model.
4. Assemble:
   ```yaml
   agentRuntimes:
     main: { harness: <chosen>, pi?: { provider: <chosen> } }
   defaultAgentRuntime: main
   agents:
     models:
       max:      { id: <picked> }
       balanced: { id: <picked> }
       fast:     { id: <picked> }
   ```

**Step 3b — Mix-and-match path** (smart cascade):
1. Walk tiers in order: `max` → `balanced` → `fast`.
2. For each tier:
   - Ask harness. **Default = previous tier's harness** (max has no default).
   - If `pi`: ask provider. Default = previous tier's provider when same harness.
   - Ask model. Default = previous tier's model when harness+provider unchanged; otherwise show the top-10 list with newest-first as the default.
3. Deduplicate runtimes by `(harness, provider)` tuple; name them `claude-sdk`, `pi-<provider>`, etc. Assign each tier to its runtime via `agents.tiers.<tier>.agentRuntime`. Pick `defaultAgentRuntime` as the runtime that backs `max` (planners/reviewers default to max).
4. Assemble e.g.:
   ```yaml
   agentRuntimes:
     claude-sdk:    { harness: claude-sdk }
     pi-openrouter: { harness: pi, pi: { provider: openrouter } }
   defaultAgentRuntime: claude-sdk
   agents:
     models:
       max:      { id: claude-opus-4-7 }
       balanced: { id: claude-sonnet-4-6 }
       fast:     { id: zai-glm-4-6 }
     tiers:
       max:      { agentRuntime: claude-sdk }
       balanced: { agentRuntime: claude-sdk }
       fast:     { agentRuntime: pi-openrouter }
   ```

**Step 4 — Profile name**: auto-derive (see "Name derivation" below) and show the user; let them override with a single follow-up confirmation.

**Step 5 — Persist**: call `mcp__eforge__eforge_init` with the assembled structure. Tool writes the profile, activates it, writes `eforge/config.yaml` with `postMergeCommands`.

**Step 6 — Migrate** (`--migrate`): unchanged path; tool handles legacy extraction.

**Step 7 — Report**: show profile name, path, and quick next-step pointers (`/eforge:profile`, `/eforge:profile-new`, `/eforge:config --edit`).

#### Name derivation

- Single runtime, single model id across all tiers: `<model-id>` (e.g. `claude-opus-4-7`) — drop provider noise for the common case.
- Single runtime, model varies across tiers: `<harness>` or `<harness>-<provider>` (e.g. `claude-sdk`, `pi-anthropic`).
- Multiple runtimes: `mixed-<maxRuntime>` (e.g. `mixed-claude-sdk`).
- Sanitize via existing `sanitizeProfileName` in `@eforge-build/client` where applicable; fall back to manual joining when the existing helper does not fit.

### Tool API (`eforge_init` in MCP proxy)

Replace the in-tool elicitation with a structured `profile` parameter:

```ts
schema: {
  force?: boolean,
  postMergeCommands?: string[],
  migrate?: boolean,
  profile?: {
    name?: string,                     // auto-derived if omitted
    agentRuntimes: Record<string, {
      harness: 'claude-sdk' | 'pi',
      pi?: { provider: string },
    }>,
    defaultAgentRuntime: string,
    models?: {
      max?:      { id: string },
      balanced?: { id: string },
      fast?:     { id: string },
    },
    tiers?: {                          // optional per-tier runtime assignment
      max?:      { agentRuntime: string },
      balanced?: { agentRuntime: string },
      fast?:     { agentRuntime: string },
    },
  },
}
```

Behavior:
- Remove all three `elicitInput()` calls (lines ~685–789 in `packages/eforge/src/cli/mcp-proxy.ts`).
- When `profile` is omitted (legacy callers), fall back to a minimal default profile — but log a deprecation note in the response. The skill always passes `profile`.
- `migrate: true` path is unchanged.
- Validate: `defaultAgentRuntime` must exist in `agentRuntimes`; every `tiers.<tier>.agentRuntime` must exist in `agentRuntimes`. (The engine schema already enforces this; rely on `createAgentRuntimeProfile` to surface errors.)

### Engine helper (`packages/engine/src/config.ts`)

Today `createAgentRuntimeProfile` always emits `agentRuntimes: { main: <single-entry> }`. Generalize so it accepts the richer input. Two reasonable shapes:

- **Option A (preferred)**: extend `createAgentRuntimeProfile` to accept either `{ harness, pi?, agents? }` (legacy single-runtime) **or** `{ agentRuntimes, defaultAgentRuntime, agents? }` (multi-runtime). Detect by presence of `agentRuntimes` and branch.
- **Option B**: add a sibling `createMultiRuntimeProfile()`; keep the existing helper untouched. Clearer but more API surface.

Use Option A (single helper, fewer call-sites). Existing callers that pass `{ harness, ... }` keep working unchanged.

Also expose a small util — `deriveProfileName(spec)` — colocated in `config.ts` or `client/profile.ts` for skill/tool reuse, so the tool can fill in `profile.name` when the skill omits it.

### Daemon HTTP route

`POST /api/profile/create` already accepts `name`/`harness`/`pi`/`agents`. Extend the route handler in `packages/monitor/src/server.ts` (around line 1178) to also accept `agentRuntimes` + `defaultAgentRuntime` and forward to the generalized `createAgentRuntimeProfile`. Bump `DAEMON_API_VERSION` in `packages/client/src/api-version.ts` (breaking field addition is non-breaking for existing clients, but the new field is a new capability — bump for clarity).

### Pi extension parity (`packages/pi-eforge/`)

Per AGENTS.md ("keep eforge-plugin and pi-eforge in sync"):
- `packages/pi-eforge/extensions/eforge/index.ts` — `eforge_init` already takes `provider`/`maxModel` params and skips elicitation (good). Extend it to accept the same `profile` structure as the MCP proxy. Pi flow is constrained to `harness: pi`, but provider/model can still vary per tier (e.g. anthropic for max, openrouter for fast).
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — mirror the two-track flow. For the Pi skill, "harness" is always `pi`; the mix-and-match path varies provider+model per tier instead.

### Reused utilities

- `sanitizeProfileName` (`@eforge-build/client`, re-exported from `packages/engine/src/config.ts:1527`) — for single-runtime name derivation.
- `parseRawConfigLegacy` — for `--migrate` path (unchanged).
- `mergePartialConfigs` / `eforgeConfigSchema` (`packages/engine/src/config.ts`) — already used by `createAgentRuntimeProfile` for round-trip validation.
- `daemonRequest` / `API_ROUTES.profileCreate` (`@eforge-build/client`) — keep as the transport.

## Scope

### In scope

**Critical files:**

| File | Change |
|------|--------|
| `eforge-plugin/skills/init/init.md` | Rewrite Workflow: drop Step 1.5; add Steps 2/3a/3b/4 (two-track + cascade); update Step 5 to pass `profile` param. |
| `packages/eforge/src/cli/mcp-proxy.ts` | Replace `eforge_init` elicitation with `profile` schema param; call generalized helper. |
| `packages/pi-eforge/extensions/eforge/index.ts` | Same `profile` schema param; harness pinned to `pi`; per-tier provider/model. |
| `packages/pi-eforge/skills/eforge-init/SKILL.md` | Mirror two-track flow (Pi-only: vary provider/model per tier). |
| `packages/engine/src/config.ts` | Generalize `createAgentRuntimeProfile` to multi-runtime; add `deriveProfileName` helper. |
| `packages/monitor/src/server.ts` | Accept multi-runtime body in `POST /api/profile/create`. |
| `packages/client/src/api-version.ts` | Bump `DAEMON_API_VERSION`. |
| `eforge-plugin/.claude-plugin/plugin.json` | Bump plugin version (per AGENTS.md). |
| `test/profile-wiring.test.ts` | Add quick-path / mix-path / name-derivation cases. |

**Tests:**
- `test/profile-wiring.test.ts` — current init test references `eforge_init` indirectly. Add cases for:
  - Quick path: single runtime, max=balanced=fast model.
  - Mix path: two runtimes, tiers split across them.
  - Name auto-derivation: each of the three branches (single-model, single-runtime/varied-models, multi-runtime).
- New unit test for the generalized `createAgentRuntimeProfile`: feed a multi-runtime spec, assert the YAML structure round-trips.

### Out of scope

- The `--migrate` path is unchanged (legacy extraction handled by the tool).
- Existing callers passing `{ harness, ... }` to `createAgentRuntimeProfile` keep working unchanged.
- Step 1 (postMergeCommands detection) is unchanged.

## Acceptance Criteria

1. **Unit/integration tests**: `pnpm test` — confirm new `createAgentRuntimeProfile` cases pass and existing single-runtime callers still work.
2. **Type check**: `pnpm type-check` passes.
3. **Manual via Claude Code**:
   - In a throwaway scratch dir, run `/eforge:init`.
   - Quick path: pick `claude-sdk` + `claude-opus-4-7`. Verify the resulting `eforge/profiles/<name>.yaml` has one runtime and `models.max=balanced=fast`.
   - Mix path: pick `claude-sdk` for max, `pi`/openrouter for fast. Verify the YAML has two `agentRuntimes` and `agents.tiers.fast.agentRuntime: pi-openrouter`.
   - Confirm only one prompt per question (no duplicate elicitation form pops up).
4. **Manual via Pi**:
   - `pi-eforge eforge init` in a scratch dir; mirror the same two-track verification.
5. **Migrate path**: `/eforge:init --migrate` against a fixture pre-overhaul `config.yaml`; confirm legacy fields move to a single-entry profile.
6. **Daemon restart**: rebuild and restart the daemon (use the `eforge-daemon-restart` skill) so MCP tools pick up the new `eforge_init` schema before the manual passes.
7. All three `elicitInput()` calls (lines ~685–789 in `packages/eforge/src/cli/mcp-proxy.ts`) are removed.
8. The skill drives all elicitation; `eforge_init` is a pure persister.
9. `defaultAgentRuntime` validation: must exist in `agentRuntimes`; every `tiers.<tier>.agentRuntime` must exist in `agentRuntimes`.
10. When `profile` is omitted (legacy callers), the tool falls back to a minimal default profile and logs a deprecation note in the response.
11. `DAEMON_API_VERSION` is bumped in `packages/client/src/api-version.ts`.
12. Plugin version is bumped in `eforge-plugin/.claude-plugin/plugin.json`.
13. `eforge-plugin/` and `packages/pi-eforge/` remain in sync with the same `profile` structure exposed in both.
