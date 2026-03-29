---
title: Make `backend` a required field in eforge config Zod schema
created: 2026-03-29
status: pending
---

# Make `backend` a required field in eforge config Zod schema

## Problem / Motivation

The "remove default backend" change (commit 0d011f8) removed the default backend value but left `backend` as `.optional()` in the Zod schema (`src/engine/config.ts`). The runtime already validates at `eforge.ts:172` and throws if no backend is configured, so the schema and runtime are inconsistent. Users get a confusing runtime error instead of a clear config validation error.

## Goal

Make `backend` a required field in the config schema so that `eforge config validate` catches the missing backend early, before any build attempt.

## Approach

1. In `src/engine/config.ts`, change `backend: backendSchema.optional()` to `backend: backendSchema` in `eforgeConfigSchema`
2. Update the `EforgeConfig` interface to make `backend` non-optional: `backend: 'claude-sdk' | 'pi'`
3. The runtime check at `eforge.ts:172` can remain as a safety net but should no longer be the primary validation path
4. Update the `/eforge:config` skill reference (in `eforge-plugin/skills/config/config.md`) to show `backend` as required, not optional

## Scope

- **In scope:** schema change, type update, skill docs update
- **Out of scope:** changing how backends are loaded or initialized

## Acceptance Criteria

- `eforge config validate` returns an error when `backend` is missing from `eforge/config.yaml`
- `eforge config validate` passes when `backend: claude-sdk` or `backend: pi` is present
- TypeScript compiles without errors
- Existing tests pass
