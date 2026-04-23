---
id: plan-02-client-boundary-public
name: Declare @eforge-build/client public with stability policy
depends_on: []
branch: hardening-12-pipeline-ts-refactor-and-eforge-build-client-boundary-decision/client-boundary-public
---

# Declare @eforge-build/client public with stability policy

## Architecture Context

`packages/client/` ships as `@eforge-build/client@0.5.12` on npm with `publishConfig.access: public`, yet its `package.json` description ends with "not intended for direct consumption" and its `README.md` carries a self-contradicting "Note" telling consumers to depend on `@eforge-build/eforge` instead — even though the same README's "Consumers" section explicitly lists three direct consumers (root CLI, monitor, Pi extension), and the surface keeps growing (the `api/` subdirectory now has six typed route helpers: `backend.ts`, `config.ts`, `daemon.ts`, `models.ts`, `queue.ts`, `status.ts`).

Real consumption today (verified via `grep -rn "from '@eforge-build/client'"`):

- `packages/eforge/src/cli/index.ts`, `packages/eforge/src/cli/mcp-proxy.ts` (the eforge CLI and its MCP proxy)
- `packages/monitor/src/index.ts`, `packages/monitor/src/server.ts`, `packages/monitor/src/server-main.ts`, `packages/monitor/src/registry.ts`
- `packages/monitor-ui/src/**` (browser code reading `API_ROUTES`, `buildPath`, `BuildStageSpec`, `ReviewProfileConfig`)
- `packages/pi-eforge/extensions/eforge/index.ts` (Pi extension)
- `packages/engine/src/schemas.ts`, `packages/engine/src/config.ts` (the engine itself)
- `eforge-plugin/` runs the eforge CLI MCP proxy, so it consumes client transitively

The "internal" label is out of touch with reality. Per the PRD, Option 1 (declare public with a stability policy) is recommended; Option 2 (split into public/internal halves) is reserved for cases where Option 1 is rejected during implementation. There is no signal in the current consumer set that any subset of the client surface needs to stay volatile, so Option 1 applies.

## Implementation

### Overview

Update the client package's stated stance so the `package.json` description and the `README.md` agree, and document a short stability policy that callers can rely on. No code changes — purely a contract declaration.

### Key Decisions

1. **Pick Option 1.** The full surface (lockfile ops, daemon client, `API_ROUTES`/`buildPath`, typed `api/` helpers, SSE subscriber, request/response types, `DAEMON_API_VERSION`) is already consumed by every integration package. Splitting it now would create churn without isolating any genuinely volatile area.
2. **State the stability policy, don't bury it.** Replace the contradictory "Note" section with a top-level "Stability" section so the policy is the first thing a consumer sees after the surface description.
3. **Keep `DAEMON_API_VERSION` independent.** The HTTP wire contract evolves on its own cadence; bump that constant when the wire breaks even if the TS surface stays stable, and bump the package's major version when the TS surface breaks.

## Scope

### In Scope
- `packages/client/package.json` description string
- `packages/client/README.md` — remove the contradictory "Note" section, add a "Stability" section, leave "Consumers", "What's included", and "Rationale" sections intact

### Out of Scope
- Splitting `@eforge-build/client` into public/internal halves (Option 2) — only revisit if Option 1 is rejected during code review
- Bumping the client's major version (this PR is documentation only; the surface itself is unchanged)
- Touching consumer code, the engine, the daemon, the monitor UI, or the Pi extension
- Updating consumer-facing docs in other packages or the repo root README

## Files

### Modify
- `packages/client/package.json` — replace the `description` field with: `"Shared types, route constants, and daemon client helpers consumed by the eforge CLI, Claude Code plugin, and Pi extension."`
- `packages/client/README.md` — delete the existing `## Note` section (the paragraph telling consumers to depend on `@eforge-build/eforge` instead). Add a new `## Stability` section with these three bullets, in this order:
  - Public exports are stability-promised within a major version.
  - Breaking changes bump the major version and are noted in the release.
  - `DAEMON_API_VERSION` is bumped independently when the HTTP contract breaks.

## Verification

- [ ] `packages/client/package.json` `description` field is exactly: `Shared types, route constants, and daemon client helpers consumed by the eforge CLI, Claude Code plugin, and Pi extension.`
- [ ] `packages/client/README.md` no longer contains the substring "not intended for direct consumption"
- [ ] `packages/client/README.md` no longer contains the substring "This is an internal contract package"
- [ ] `packages/client/README.md` contains a `## Stability` section with the three bullets listed above (one bullet per line, in the documented order)
- [ ] `pnpm type-check` passes (no code changed, but the build pipeline still verifies)
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds and `packages/client/dist/index.js` is unchanged byte-for-byte against the pre-change build (no code modifications)
