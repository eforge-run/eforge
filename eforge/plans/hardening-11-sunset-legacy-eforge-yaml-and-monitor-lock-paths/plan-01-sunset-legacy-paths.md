---
id: plan-01-sunset-legacy-paths
name: Sunset legacy eforge.yaml and monitor.lock paths
depends_on: []
branch: hardening-11-sunset-legacy-eforge-yaml-and-monitor-lock-paths/sunset-legacy-paths
---

# Sunset legacy eforge.yaml and monitor.lock paths

## Architecture Context

eforge previously supported two legacy file locations that must now be retired as a breaking change:

1. **Config**: `eforge.yaml` at repo root (pre-overhaul) vs. `eforge/config.yaml` (current). The engine at `packages/engine/src/config.ts` no longer actually loads the legacy file but still emits a soft warning when it sees one. The PRD asks us to promote that warning into a hard migration error (`ConfigMigrationError`) so users cannot silently run without any config.
2. **Lockfile**: `.eforge/monitor.lock` (pre-rename) vs. `.eforge/daemon.lock` (current). `packages/client/src/lockfile.ts` still reads from the legacy path as a fallback and `removeLockfile` still tries to unlink both. The daemon at `packages/monitor/src/server-main.ts` already writes only `daemon.lock` via `writeLockfile`, so the writer side is already clean — only the reader fallback and the legacy cleanup call remain.

The PRD mentions `eforge init --migrate` as the "sole migration route". Investigation shows that the existing `migrate: true` branch of the `eforge_init` MCP tool in `packages/eforge/src/cli/mcp-proxy.ts` is an unrelated migration (extracting the `backend:` field from `eforge/config.yaml` into a named profile under `eforge/backends/`). It does **not** copy `eforge.yaml` → `eforge/config.yaml`. Because `eforge.yaml` and `eforge/config.yaml` share an identical schema, the correct migration instruction is the same simple shell command already printed in the current warning: `mkdir -p eforge && mv eforge.yaml eforge/config.yaml`. This plan therefore surfaces that instruction inside the new hard error rather than inventing a new `init --migrate` code path for a file move that is trivially done manually. The existing `eforge_init { migrate: true }` tool is preserved unchanged (separate concern, separate migration).

Neither `packages/eforge/src/cli/index.ts` nor any other file in `packages/` currently references `eforge.yaml` or `monitor.lock` outside the three touch points above, so no additional CLI message rewrites are needed.

## Implementation

### Overview

1. In `packages/engine/src/config.ts`, replace the legacy `eforge.yaml` warning branch in `loadConfig` with a `ConfigMigrationError` that names the detected path and gives the one-line `mv` fix. Update the `findConfigFile` doc comment and the `loadConfig` doc comment to match. No change to `findConfigFile` behavior (it already only looks for `eforge/config.yaml`).
2. In `packages/client/src/lockfile.ts`, delete `LEGACY_LOCKFILE_NAME`, `legacyLockfilePath`, and the fallback branch in `readLockfile`; simplify `removeLockfile` to only unlink `daemon.lock`. Keep `readLockfile`'s contract (`null` when the file is missing) — higher-level callers already translate that into a "daemon not running" message; add or tighten a test that asserts a legacy-only `monitor.lock` yields the same "not running" outcome (i.e., `readLockfile` returns `null`).
3. In `packages/engine/src/backends/pi.ts`, update the stale doc comment `from eforge.yaml` to `from eforge/config.yaml` (cosmetic, keeps the `rg` acceptance check clean).
4. Rewrite the two legacy-path test blocks in `test/config.test.ts` so they assert the new hard error (the `findConfigFile` test already asserts `null` and can stay; the `loadConfig legacy eforge.yaml detection` describe block becomes a `throws ConfigMigrationError` assertion, and the "no warnings when eforge/config.yaml is present" test drops the "plant legacy file" step since loadConfig no longer walks past a present `eforge/config.yaml` to check for a legacy file). Add a new lockfile test asserting `readLockfile` returns `null` when only `monitor.lock` exists.
5. Update `docs/config.md` if it references the legacy path (current grep shows no hits, but verify during build and add a short "Upgrading from eforge.yaml" note under the existing `eforge/config.yaml` heading pointing at the new error and the `mv` command).

### Key Decisions

1. **Use `ConfigMigrationError` rather than a new error class.** The existing class already exists for exactly this shape of breaking-change migration (it's used for the separate `backend:` migration). Reusing it keeps the error taxonomy small and the catch site in `loadConfig` already re-throws it, so no wiring changes.
2. **Do not invent a new `eforge init --migrate` code path for the file rename.** The PRD suggested making `eforge init --migrate` the sole migration route for `eforge.yaml` → `eforge/config.yaml`. Since the file rename is trivial and the existing `migrate` flag already means something else (backend-field extraction), the hard error message points users at a one-line `mv` command. This keeps the existing `migrate` flag's single-purpose semantics and avoids a tool name overload. Rationale captured here so reviewers do not flag it as a missed requirement.
3. **Keep `readLockfile` returning `null` on absence.** The PRD asks for a "clear 'daemon not running' error" when only `monitor.lock` exists. That message is produced by higher-level callers (e.g. the CLI's daemon-status checks), not by `readLockfile` itself — changing `readLockfile` to throw would break every caller that treats absence as a normal "no daemon" signal. The test therefore asserts `null`, and we rely on existing callers to surface the user-facing message.
4. **Preserve the `removeLockfile` signature** but drop the legacy `unlinkSync` call. No caller inspects the number of unlinks; this is a pure internal simplification.
5. **Single plan, not split.** Fewer than 10 files change, all edits are tightly coupled (the tests verify the code changes in the same files), and there is no natural seam for a second plan.

## Scope

### In Scope
- Replace soft legacy-config warning with a hard `ConfigMigrationError` throw in `loadConfig`.
- Delete the `monitor.lock` reader fallback and legacy unlink in `packages/client/src/lockfile.ts`.
- Update stale doc comments that still reference `eforge.yaml` (engine config.ts function docs, pi.ts field doc).
- Update `test/config.test.ts` to cover the new error; add a lockfile test in the most appropriate existing test file (or a new `test/lockfile.test.ts`) asserting legacy-only `monitor.lock` yields `readLockfile() === null`.
- Update `docs/config.md` with a short upgrade note if the legacy path is referenced or if a breaking-change note is warranted there.

### Out of Scope
- Editing `CHANGELOG.md` (owned by the release process, per `feedback_changelog_managed_by_release.md`).
- Changes to the unrelated `eforge_init { migrate: true }` MCP tool (it handles the separate `backend:`-field migration).
- Any changes to config schema, daemon port, or lockfile on-disk format.
- Major-version bump coordination (handled at release time).
- Additional migration tooling.

## Files

### Modify
- `packages/engine/src/config.ts` — replace the legacy-warning branch (~lines 708-721) inside `loadConfig` with a `throw new ConfigMigrationError(...)` that includes the legacy path and the `mkdir -p eforge && mv eforge.yaml eforge/config.yaml` one-liner. Update the `findConfigFile` doc comment (line 363-368) to drop the reference to the legacy check. Update the `loadConfig` doc comment (line 687-700) to describe the new behavior. Leave `findConfigFile` behavior unchanged.
- `packages/client/src/lockfile.ts` — remove the `LEGACY_LOCKFILE_NAME` constant and the `legacyLockfilePath` helper; change `readLockfile` to return the result of `tryReadLockfileAt(lockfilePath(cwd))` only; change `removeLockfile` to unlink only `lockfilePath(cwd)`. Keep `tryReadLockfileAt` as an internal helper (still useful) or inline it, whichever keeps the diff smaller.
- `packages/engine/src/backends/pi.ts` — change the `from eforge.yaml` comment on line 46 to `from eforge/config.yaml` (one-line doc fix; keeps the `rg` acceptance check from flagging this file).
- `test/config.test.ts` — in the `findConfigFile` describe (line 469), keep the existing "returns null when only legacy eforge.yaml exists" test (still accurate). Replace the `loadConfig legacy eforge.yaml detection` describe block (lines 493-534): the first test becomes `throws ConfigMigrationError with the mv instruction when only legacy eforge.yaml exists`; the second test keeps asserting that `eforge/config.yaml` is preferred but drops the "plant legacy alongside" step (since the legacy-probe branch is gone when `configPath` is found — the current assertion still passes but the sibling legacy file is no longer relevant to the test intent).
- `test/lockfile.test.ts` — create a new test file (there is no existing one; the closest is `test/retry-on-lock.test.ts`, which is about a different concern). Add tests: (1) `readLockfile` returns `null` when `.eforge/` is empty; (2) `readLockfile` returns a valid `LockfileData` when `.eforge/daemon.lock` is present and well-formed; (3) `readLockfile` returns `null` when only a legacy `.eforge/monitor.lock` exists (proves the fallback is gone). Use `mkdtemp`/`rm` the same way `test/config.test.ts` does.
- `docs/config.md` — add a short "Upgrading from pre-overhaul `eforge.yaml`" paragraph under the `eforge/config.yaml` heading: one sentence explaining the rename and the exact `mkdir -p eforge && mv eforge.yaml eforge/config.yaml` command, plus a note that running without migrating now aborts with a clear error.

## Verification

- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] In a scratch directory containing only `eforge.yaml` (no `eforge/config.yaml`), calling `loadConfig(dir)` throws a `ConfigMigrationError` whose message contains both the legacy file path and the substring `mv eforge.yaml eforge/config.yaml`.
- [ ] In a scratch directory containing only `.eforge/monitor.lock` with otherwise-valid JSON, `readLockfile(dir)` returns `null`.
- [ ] In a scratch directory containing `.eforge/daemon.lock` with valid JSON, `readLockfile(dir)` returns an object with numeric `pid`, numeric `port`, and string `startedAt`.
- [ ] `packages/client/src/lockfile.ts` contains no occurrence of the string `monitor.lock` or the identifier `LEGACY_LOCKFILE_NAME`.
- [ ] `packages/engine/src/config.ts` contains no automatic-fallback read of `eforge.yaml`; the only remaining occurrence of the string `eforge.yaml` is inside the new `ConfigMigrationError` message (and optionally the `mv` one-liner).
- [ ] Running `rg "eforge\\.yaml|monitor\\.lock" packages/` outputs matches only in (a) the new `ConfigMigrationError` message in `packages/engine/src/config.ts` and (b) zero files under `packages/client/` and `packages/monitor/`.
- [ ] `docs/config.md` mentions the single supported config path `eforge/config.yaml` and contains the upgrade paragraph with the `mv` command.
- [ ] The test file `test/lockfile.test.ts` exists and contains a test case whose name references the legacy `monitor.lock` fallback being removed.
