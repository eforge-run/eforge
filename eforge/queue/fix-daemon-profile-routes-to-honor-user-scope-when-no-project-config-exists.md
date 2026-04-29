---
title: Fix daemon profile routes to honor user-scope when no project config exists
created: 2026-04-29
---

# Fix daemon profile routes to honor user-scope when no project config exists

## Problem / Motivation

In a fresh project (no `eforge/config.yaml`), `/eforge:init` Step 1.5 calls `mcp__eforge__eforge_profile { action: "list", scope: "user" }`, expecting to surface existing user-scope profiles from `~/.config/eforge/profiles/`. Instead the user is told "no existing user-scope profiles available" and the flow falls through to Quick setup, even when user profiles exist.

**Root cause:** In `packages/monitor/src/server.ts:1064-1068`, the `profileList` route handler calls `getConfigDir(cwd)`, and when it returns `null` (no project config), the route short-circuits with `{ profiles: [], active: null, source: 'none' }` — never scanning `userProfilesDir()`. The same early-return pattern exists in the `profileShow` route at `server.ts:1098-1101`.

## Goal

Both routes (`profileList` and `profileShow`) should return user-scope data when the caller asks for it (or asks for `all`), regardless of whether a project config exists.

## Approach

- Add a `listUserProfiles()` helper exported from `packages/engine/src/config.ts` (or make `listProfiles` accept `configDir: string | null`) that scans only `userProfilesDir()`. Reuse the existing `scanDir` logic.
- In the `profileList` route handler in `packages/monitor/src/server.ts`: when `configDir` is null, branch on `scopeParam`.
  - For `'project'`, keep the empty response.
  - For `'user'`, `'all'`, or unset, scan user-scope profiles, resolve `active` from `readMarkerName(userMarkerPath())` only (validating the marker points at an existing user profile), and return `source: 'user-local'` if active resolves, else `'none'`.
- In the `profileShow` route handler: same pattern. When `configDir` is null, resolve from the user marker only, then `loadProfile`-style lookup against user scope, and return harness/profile/scope as today.
- `userMarkerPath()` and `userProfilesDir()` are currently file-private to `config.ts` — export the minimum needed (or expose via a single new public helper that encapsulates the no-configDir resolution).
- Add tests in `test/` covering:
  - User-scope listing in a directory with no `eforge/config.yaml` returns the user profiles.
  - `profileShow` resolves the user-marker active profile in the same condition.
  - `scope=project` with no config still returns empty.
  - The existing project+user behavior is unchanged when a project config does exist.

## Scope

**In scope:**
- The two route handlers in `packages/monitor/src/server.ts`.
- Helpers/exports in `packages/engine/src/config.ts`.
- Vitest coverage.

**Out of scope:**
- Changing the `/eforge:init` skill itself (the skill's MCP call is already correct).
- Changing `getConfigDir` semantics.
- Project-scope behavior.
- The `profileUse`/`profileCreate`/`profileDelete` routes — they reasonably require a project context for the project-scope cases, and user-scope create/use/delete already work because they pass scope explicitly to engine helpers that don't need configDir for user-only ops. Leave them alone unless the same null-configDir bug is found there too, in which case fix consistently.

## Acceptance Criteria

- In a directory with no `eforge/config.yaml`, calling `mcp__eforge__eforge_profile { action: "list", scope: "user" }` returns the user-scope profiles from `~/.config/eforge/profiles/` with `source: "user-local"` (or `"none"` when no marker), not an empty list.
- Same call with `scope: "all"` returns user profiles in that case.
- `scope: "project"` in a directory with no project config returns `{ profiles: [], active: null, source: 'none' }`.
- `mcp__eforge__eforge_profile { action: "show" }` in the same condition returns the user-marker active profile (when one exists), not `{ active: null }`.
- After the fix, in a fresh project with `~/.config/eforge/profiles/claude-sdk-4-7.yaml` and `~/.config/eforge/profiles/pi-codex-5-5.yaml` present, `/eforge:init` Step 1.5 lists both profiles instead of saying "no existing user-scope profiles available".
- New vitest cases pass; existing profile route tests still pass.
