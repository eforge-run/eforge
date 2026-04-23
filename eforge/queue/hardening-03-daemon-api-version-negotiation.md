---
title: Hardening 03: daemon API version negotiation
created: 2026-04-23
depends_on: ["hardening-12-pipeline-ts-refactor-and-eforge-build-client-boundary-decision"]
---

# Hardening 03: daemon API version negotiation

## Problem / Motivation

`DAEMON_API_VERSION` is exported from `packages/client/src/api-version.ts` but nothing uses it. If a client built against version N talks to a daemon running version M (because the user upgraded one side without the other), requests fail with 404s or schema mismatches and confusing error messages. This is latent - fine today because everyone upgrades together, but painful as soon as the Pi extension or plugin ships on its own release cadence separate from the daemon.

## Goal

The daemon exposes its API version. Clients check once per daemon process and throw a clear "client expects vN, daemon reports vM" error on mismatch. The version constant becomes load-bearing - it increments whenever the HTTP contract changes in a non-backward-compatible way.

## Approach

### 1. Daemon version route

Add `GET /api/version` in `packages/monitor/src/server.ts`:

```ts
server.get(API_ROUTES.version, async () => ({
  version: DAEMON_API_VERSION,
  // Optional: include daemon PID + start time for debugging
}));
```

Register `version: '/api/version'` in the `API_ROUTES` map in `packages/client/src/routes.ts`. Define `VersionResponse { version: number }` in `packages/client/src/routes.ts`.

The handler should not require auth, should not touch the queue, and should never fail unless the daemon is actually down.

### 2. Client-side version check

In `packages/client/src/api-version.ts`, add a per-daemon version cache and a `verifyApiVersion` function.

The lockfile type (`LockfileData` in `packages/client/src/lockfile.ts`) has `{ pid, port, startedAt }` - use `port` and `pid` as the cache key:

```ts
const verifiedDaemons = new Map<string, number>(); // keyed by `${port}:${pid}`

export async function verifyApiVersion(cwd: string): Promise<void> {
  const lock = readLockfile(cwd);
  if (!lock) return; // daemon not running; let the caller fail naturally
  const key = `${lock.port}:${lock.pid}`;
  if (verifiedDaemons.has(key)) return;

  const { data } = await daemonRequest<VersionResponse>(
    cwd,
    'GET',
    API_ROUTES.version,
  );

  if (data.version !== DAEMON_API_VERSION) {
    throw new Error(
      `eforge daemon API version mismatch: client expects v${DAEMON_API_VERSION}, daemon reports v${data.version}. ` +
      `Restart the daemon with the matching version.`
    );
  }

  verifiedDaemons.set(key, data.version);
}
```

Note: `daemonRequest` signature is `(cwd: string, method: string, path: string, body?: unknown)` and returns `Promise<{ data: T; port: number }>`.

The thrown `Error` message must contain the string `"version mismatch"` (case-insensitive) so that `classifyDaemonError` in `packages/eforge/src/cli/errors.ts` can classify it as `DaemonErrorKind = 'version-mismatch'`. Verify that `classifyDaemonError` handles this pattern; if it checks for a different string, align the error message accordingly.

Call `verifyApiVersion(cwd)` from inside `daemonRequest` (before the actual HTTP call). Skip the check for the `version` route itself to avoid recursion.

### 3. Wire it into the CLI startup path

When the CLI delegates to the daemon (`eforge build`, `eforge queue list`, etc.), the first request will trigger `verifyApiVersion`. Confirm the error surfaces through the existing `formatCliError` / `classifyDaemonError` pipeline in `packages/eforge/src/cli/errors.ts` - exits non-zero with the mismatch message, not a stack trace.

### 4. Document when to bump `DAEMON_API_VERSION`

Add a short comment block in `packages/client/src/api-version.ts`:

> Bump this when making a breaking change to any route's path, request shape, or response shape. Adding a new optional field is NOT breaking. Removing a field, renaming a route, or changing a response's required fields IS.

### 5. Consider adding a daemon-side minimum version

Optional: the daemon could also reject requests from clients older than some floor via a request header. Likely overkill for now; defer unless the team wants it.

## Scope

### In scope

- Files touched:
  - `packages/client/src/{api-version,routes,index}.ts`
  - `packages/monitor/src/server.ts`
  - `packages/eforge/src/cli/errors.ts` - verify `classifyDaemonError` handles the mismatch error message; update the classifier string if needed
  - Tests: add a unit test for `verifyApiVersion` that mocks `daemonRequest` and confirms both the happy path and the mismatch error.
- Frontmatter:
  - title: "Hardening 03: daemon API version negotiation"
  - scope: excursion
  - depends_on: [2026-04-22-hardening-02-daemon-route-contract]

### Out of scope

- Automated release tooling to bump `DAEMON_API_VERSION`.
- Negotiating a compatibility range instead of strict equality.
- Validating request bodies against schema at the daemon.

## Acceptance Criteria

- `pnpm test` - new version-check unit test passes (covers both happy path and mismatch error).
- Manual: hand-edit `packages/client/src/api-version.ts` to pretend the client is v999, run `eforge status` against a running daemon, confirm the error message is clear and the process exits non-zero. Revert the edit.
- Manual: normal operations (`eforge queue list`, `eforge status`, `eforge build`) make at most one extra `/api/version` request per CLI invocation (visible in daemon logs if enabled) and otherwise behave identically.
- Daemon exposes `GET /api/version` returning `{ version: DAEMON_API_VERSION }`, registered via `API_ROUTES.version`, requiring no auth, not touching the queue, and only failing when the daemon is down.
- `VersionResponse { version: number }` is defined in `packages/client/src/routes.ts`.
- `verifyApiVersion(cwd)` exists in `packages/client/src/api-version.ts`, caches per-daemon (keyed by `${lock.port}:${lock.pid}`), is invoked from `daemonRequest` before the first real request, skips itself for the `version` route to avoid recursion, and throws the specified mismatch error.
- The mismatch error integrates with `classifyDaemonError` in `packages/eforge/src/cli/errors.ts` and is classified as `'version-mismatch'`.
- `packages/client/src/api-version.ts` includes the documented comment block describing when to bump `DAEMON_API_VERSION` (breaking changes to a route's path, request shape, or response shape; adding optional fields is not breaking; removing/renaming/changing required fields is).