---
title: Hardening 11: Sunset Legacy `eforge.yaml` and `monitor.lock` Paths
created: 2026-04-23
---

# Hardening 11: Sunset Legacy `eforge.yaml` and `monitor.lock` Paths

## Problem / Motivation

The config migration from `eforge.yaml` (legacy, repo-root) to `eforge/config.yaml` (in the `eforge/` subdirectory) is still in-flight. Dual-path fallbacks live in multiple places:

- `packages/engine/src/config.ts:269-300` - walks upward looking for `eforge/config.yaml`, falls back to `eforge.yaml` in the start dir.
- `packages/client/src/lockfile.ts:19-21, 40-42` - reads `daemon.lock`, falls back to legacy `monitor.lock`.
- `packages/eforge/src/cli/mcp-proxy.ts:627-661` - handles a migration branch in the `eforge_init` tool.
- CLI messages reference both paths (`packages/eforge/src/cli/index.ts:112, 627`).

Two code paths mean two failure modes, two sets of tests, and perpetual documentation drift. The migration has been "in progress" long enough that continued support is now a tax.

This PRD is breaking: users with a legacy `eforge.yaml` who haven't run `eforge init --migrate` will need to do so before the next release. Schedule accordingly.

**Metadata:**
- `title`: "Hardening 11: sunset legacy eforge.yaml and monitor.lock paths"
- `scope`: excursion
- `depends_on`: [2026-04-22-hardening-10-plugin-pi-parity]

## Goal

- `eforge/config.yaml` is the only supported location.
- `daemon.lock` is the only supported lockfile name.
- Legacy detection produces a single clear error directing users to `eforge init --migrate`.
- All fallback code and dual-path branches removed.
- Major version bump + CHANGELOG note under the release process.

## Approach

### 1. Decide the release vehicle

Because this breaks users with legacy `eforge.yaml`, this PRD ships as part of a major version bump (or at least a minor with a prominent migration note). Confirm the release train before landing.

### 2. Remove the engine fallback

In `packages/engine/src/config.ts` (around lines 269-300), delete the `eforge.yaml` fallback. If legacy detection is desired, keep one check - if the walker finds `eforge.yaml` but NOT `eforge/config.yaml` nearby, throw a specific error:

```ts
throw new Error(
  `Detected legacy eforge.yaml at ${legacyPath} but no eforge/config.yaml. ` +
  `Run 'eforge init --migrate' to convert. See CHANGELOG for details.`
);
```

No more automatic fallback. The `--migrate` flag is mandatory, not optional.

### 3. Remove the lockfile fallback

In `packages/client/src/lockfile.ts:19-42`, delete the `monitor.lock` fallback. Only `daemon.lock` is read. If the daemon writes a `monitor.lock` anywhere, update it to write `daemon.lock` only (verify during implementation - the fallback suggests it might have been renamed already).

### 4. Keep `eforge init --migrate` working

The migration path in `packages/eforge/src/cli/mcp-proxy.ts:627-661` (and any corresponding CLI command) must still function. It now becomes the only route for users with legacy setups. Verify it:

- Reads `eforge.yaml`
- Writes `eforge/config.yaml`
- Moves or deletes the legacy file (offer a `--keep-legacy` flag if paranoid)
- Prints a success message

### 5. Update CLI error paths

In `packages/eforge/src/cli/index.ts` (lines 112, 627 etc.), simplify the migration-guidance messages now that the legacy path is dead. Any operation that can't find `eforge/config.yaml` should print:

```
No eforge/config.yaml found. Run 'eforge init' to create one (or 'eforge init --migrate' if upgrading from eforge.yaml).
```

### 6. Documentation

Update `docs/config.md` to reflect the single supported path. Add a CHANGELOG entry under the release header (per the closed-by-release-process note in memory, the PRD does NOT edit CHANGELOG.md itself - the release flow owns it; just ensure the release notes will include this breaking change).

### 7. Tests

- Delete or update tests that exercise the legacy path.
- Add a test: starting with only `eforge.yaml` present, config load throws the migration error.
- Add a test: starting with only `monitor.lock` (no `daemon.lock`), lockfile read throws a clear "daemon not running" error.

### Files touched

- `packages/engine/src/config.ts`
- `packages/client/src/lockfile.ts`
- `packages/eforge/src/cli/{index,mcp-proxy}.ts`
- `docs/config.md`
- Tests in `test/`

## Scope

### In scope

- Removing the `eforge.yaml` fallback in `packages/engine/src/config.ts` and replacing it with a single legacy-detection error.
- Removing the `monitor.lock` fallback in `packages/client/src/lockfile.ts` and ensuring the daemon writes only `daemon.lock`.
- Preserving and verifying `eforge init --migrate` as the sole migration route (reads `eforge.yaml`, writes `eforge/config.yaml`, moves/deletes the legacy file, optional `--keep-legacy` flag, success message).
- Simplifying CLI migration-guidance messages in `packages/eforge/src/cli/index.ts`.
- Updating `docs/config.md` to reflect the single supported path.
- Deleting/updating legacy-path tests and adding tests for the new error paths (legacy-only config, legacy-only lockfile).
- Major version bump coordination + CHANGELOG note (handled by the release process, not this PRD).

### Out of scope

- Additional config schema changes.
- Changing the default daemon port or lockfile format content.
- Migration tooling beyond the existing `eforge init --migrate`.
- Editing `CHANGELOG.md` directly within this PRD (the release flow owns it).

## Acceptance Criteria

- `pnpm test && pnpm build` pass.
- Starting with legacy-only files: the migration error message is emitted, is clear, points at `eforge init --migrate`, and exits non-zero.
- Running `eforge init --migrate` on a legacy project completes successfully and normal operations succeed afterward.
- `rg "eforge\.yaml|monitor\.lock" packages/` returns hits only in migration-related error messages, tests, and the `init --migrate` tool.
- `eforge/config.yaml` is the only supported config location; no automatic fallback to `eforge.yaml` remains.
- `daemon.lock` is the only lockfile name read or written; no `monitor.lock` fallback remains.
- A test exists proving that with only `eforge.yaml` present, config load throws the migration error.
- A test exists proving that with only `monitor.lock` (no `daemon.lock`), lockfile read throws a clear "daemon not running" error.
- Release notes for the shipping version include the breaking-change entry (ensured via the release process).
