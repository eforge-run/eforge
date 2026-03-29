---
title: Remove default provider from Pi backend config
created: 2026-03-29
status: pending
---

# Remove default provider from Pi backend config

## Problem / Motivation

The Pi backend currently defaults to `openrouter` when no provider is configured. Pi supports 23 providers, so defaulting to one specific provider is an opinionated choice. Users who opt into `backend: pi` should explicitly declare which provider they want. A previous build (commit d0e5feb) already fixed the main bug by removing `parseModelString`, removing `pi.model`, and making `resolveModel` use `piConfig.provider` directly - but the default provider fallback remains.

## Goal

Remove the implicit `openrouter` default from the Pi backend so that users must explicitly set `pi.provider` in `eforge/config.yaml`, and receive a clear error if they do not.

## Approach

Make `provider` optional in config types and remove all fallback values. In the runtime path (`resolveModel`), throw a descriptive error when provider is missing rather than silently falling back.

### `src/engine/backends/pi.ts`

**1. Remove `'openrouter'` fallback in `resolveModel`** (line 99)

Change `piConfig?.provider ?? 'openrouter'` to throw if provider is missing:

```typescript
const provider = piConfig?.provider;
if (!provider) {
  throw new Error('No provider configured for Pi backend. Set pi.provider in eforge/config.yaml.');
}
```

**2. Update doc comment** (line 94)

Remove "defaults to 'openrouter'" from the JSDoc.

**3. Fix `getModel` returning undefined** (line 102)

`getModel` returns `undefined` for unknown combos rather than throwing. Cast the result and check:

```typescript
const resolved = getModel(provider as never, modelStr as never) as Model<Api> | undefined;
if (resolved) return resolved;
```

### `src/engine/config.ts`

**4. Make `provider` optional in `PiConfig`** (line 306)

`provider: string` -> `provider?: string`

**5. Remove default provider from `DEFAULT_CONFIG.pi`** (line 393)

Delete `provider: 'openrouter'`

**6. Update `resolveConfig`** (line 504)

Change `provider: fileConfig.pi?.provider ?? DEFAULT_CONFIG.pi.provider` to `provider: fileConfig.pi?.provider` (no fallback)

## Scope

**In scope:**
- Removing the `openrouter` default from `resolveModel` in `pi.ts`
- Updating the JSDoc comment in `pi.ts`
- Handling `getModel` returning `undefined` in `pi.ts`
- Making `provider` optional in the `PiConfig` type in `config.ts`
- Removing the default provider from `DEFAULT_CONFIG.pi` in `config.ts`
- Removing the fallback in `resolveConfig` in `config.ts`

**Out of scope:**
- The main bug fix (already completed in commit d0e5feb: removed `parseModelString`, removed `pi.model`, made `resolveModel` use `piConfig.provider` directly)
- Any other Pi backend changes

## Acceptance Criteria

- `pnpm type-check` passes
- `pnpm test` passes
- Running with `backend: pi` but no `pi.provider` set throws a clear error: `"No provider configured for Pi backend. Set pi.provider in eforge/config.yaml."`
- No code path falls back to `openrouter` as a default provider
- `provider` is optional in `PiConfig` type
- `DEFAULT_CONFIG.pi` does not contain a `provider` value
