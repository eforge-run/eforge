---
title: Cross-skill awareness for eforge skills
created: 2026-04-16
---

# Cross-skill awareness for eforge skills

## Problem / Motivation

When a user runs `/eforge:build` in a project where eforge hasn't been initialized (no `eforge/config.yaml`), they get a generic "No backend configured" error but are never told about `/eforge:init`. Skills operate in isolation with no awareness of each other, so the agent can't intelligently suggest the right next step. This creates a frustrating experience where users hit dead ends without guidance.

## Goal

Make all eforge skills aware of each other so the agent can intelligently suggest the right next step - particularly when a prerequisite (like initialization) hasn't been completed.

## Approach

Three coordinated changes:

1. **Engine change** - Add a `configFound: boolean` field to the validate API response so skills can distinguish "no config file" from "valid config with defaults."
   - `packages/engine/src/config.ts` - `validateConfigFile` function
   - `packages/client/src/types.ts` - `ConfigValidateResponse` type

2. **Build skill update** - Update Step 5 (validation) in both build skill files to check the `configFound` field and suggest `/eforge:init` when no config exists:
   - `eforge-plugin/skills/build/build.md`
   - `packages/pi-eforge/skills/eforge-build/SKILL.md`

3. **Related Skills sections** - Add a cross-skill reference table to all 13 skill files (6 Claude Code plugin + 7 Pi extension) so the agent knows what other skills exist and when to suggest them. Also add "No config found" error handling rows to build and status skills.

4. **Plugin version bump** - Bump `eforge-plugin/.claude-plugin/plugin.json` from `0.5.23` to `0.5.24`.

## Scope

**In scope:**
- Adding `configFound: boolean` to the validate API response in engine and client types
- Updating build skill validation step in both Claude Code plugin and Pi extension
- Adding Related Skills reference tables to all 13 skill files (6 Claude Code plugin + 7 Pi extension)
- Adding "No config found" error handling rows to build and status skills
- Plugin version bump from 0.5.23 to 0.5.24

**Out of scope:**
- N/A

## Acceptance Criteria

- `ConfigValidateResponse` in `packages/client/src/types.ts` includes a `configFound: boolean` field.
- `validateConfigFile` in `packages/engine/src/config.ts` populates `configFound` correctly (false when no `eforge/config.yaml` exists, true otherwise).
- `eforge-plugin/skills/build/build.md` Step 5 checks `configFound` and suggests `/eforge:init` when no config exists.
- `packages/pi-eforge/skills/eforge-build/SKILL.md` Step 5 checks `configFound` and suggests `/eforge:init` when no config exists.
- All 13 skill files (6 Claude Code plugin, 7 Pi extension) contain a Related Skills cross-reference table.
- Build and status skills include "No config found" error handling rows.
- `eforge-plugin/.claude-plugin/plugin.json` version is `0.5.24`.
