---
id: plan-01-oauth-auth
name: Switch Pi Backend to File-Backed AuthStorage
depends_on: []
branch: support-oauth-providers-openai-codex-in-pi-backend/oauth-auth
---

# Switch Pi Backend to File-Backed AuthStorage

## Architecture Context

The Pi backend currently uses `AuthStorage.inMemory()` with a custom `resolveApiKey` function that duplicates logic Pi's file-backed AuthStorage already handles natively. This prevents OAuth providers (e.g. `openai-codex`, `github-copilot`) from working because in-memory storage can't read `~/.pi/agent/auth.json`. Switching to `AuthStorage.create()` enables OAuth support and removes redundant code.

## Implementation

### Overview

Replace `AuthStorage.inMemory()` and the `resolveApiKey` helper in `src/engine/backends/pi.ts` with `AuthStorage.create()`, preserving the `piConfig.apiKey` override via `setRuntimeApiKey`. Update the `PiConfig.apiKey` doc comment in `src/engine/config.ts`. Update `docs/config.md` to document OAuth provider support.

### Key Decisions

1. Use `AuthStorage.create()` instead of `AuthStorage.inMemory()` - this is the Pi SDK's file-backed storage that reads `~/.pi/agent/auth.json` and handles env vars natively, removing the need for eforge to duplicate that logic.
2. Preserve `piConfig.apiKey` as an explicit override via `authStorage.setRuntimeApiKey()` - this is highest priority and covers users who want to pass an API key directly without relying on auth.json or env vars.
3. Delete `resolveApiKey` entirely - the env var checking it performs is already handled by Pi's file-backed AuthStorage.

## Scope

### In Scope
- Delete `resolveApiKey` function from `src/engine/backends/pi.ts`
- Replace `AuthStorage.inMemory()` with `AuthStorage.create()` in `src/engine/backends/pi.ts`
- Wire `piConfig.apiKey` override via `setRuntimeApiKey`
- Update `PiConfig.apiKey` doc comment in `src/engine/config.ts`
- Update `docs/config.md` Pi Backend section to document OAuth support

### Out of Scope
- Changes to PiConfig type shape (no type changes needed)
- Changes to tests (existing tests mock PiBackend, unaffected by internal auth changes)

## Files

### Modify
- `src/engine/backends/pi.ts` - Delete `resolveApiKey` function (lines 262-285). Replace auth storage construction (lines 333-339): use `AuthStorage.create()` and conditionally call `setRuntimeApiKey` when `piConfig.apiKey` is set.
- `src/engine/config.ts` - Update the doc comment on `PiConfig.apiKey` to clarify it's an optional override; OAuth and env vars are handled automatically by Pi's file-backed AuthStorage.
- `docs/config.md` - Update the Pi Backend section to note OAuth provider support, add setup instructions for OAuth providers, clarify that `pi.apiKey` is optional.

## Verification

- [ ] `pnpm type-check` exits with code 0
- [ ] `pnpm test` exits with code 0
- [ ] `pnpm build` exits with code 0
- [ ] The `resolveApiKey` function does not exist in `src/engine/backends/pi.ts`
- [ ] `AuthStorage.create()` is called instead of `AuthStorage.inMemory()` in `src/engine/backends/pi.ts`
- [ ] `AuthStorage.inMemory` does not appear in `src/engine/backends/pi.ts`
- [ ] `setRuntimeApiKey` is called when `this.piConfig?.apiKey` is set
- [ ] `docs/config.md` contains setup instructions for OAuth providers (`openai-codex`, `github-copilot`)
- [ ] `docs/config.md` documents that `pi.apiKey` is optional and OAuth tokens are read from `~/.pi/agent/auth.json`
