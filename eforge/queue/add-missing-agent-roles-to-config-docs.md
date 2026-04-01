---
title: Add missing agent roles to config docs
created: 2026-04-01
---



# Add missing agent roles to config docs

## Problem / Motivation

The `docs/config.md` file has a YAML config example block (around lines 37-42) that lists available agent roles in comments. This list is missing two roles - `prd-validator` and `dependency-detector` - that are defined in the codebase (`src/engine/config.ts` AGENT_ROLES array and `src/engine/events.ts` AgentRole type). This makes the documentation inaccurate relative to the current codebase state.

## Goal

Update the commented role list in the YAML example block of `docs/config.md` to include all available agent roles, adding the two missing ones: `prd-validator` and `dependency-detector`.

## Approach

- Add `prd-validator` and `dependency-detector` to the existing commented list of roles in the YAML config example block
- Follow the same comment formatting style already used (roles listed across multiple comment lines)
- Minimal edit - no other changes to the file

## Scope

**In scope:**
- Adding `prd-validator` and `dependency-detector` to the commented role list in the YAML block (around lines 37-42)

**Out of scope:**
- All other sections of `docs/config.md` (Model Classes, Profiles, MCP Servers, Pi Backend, Plugins, Hooks, Config Layers, Parallelism) - these are accurate and current
- Any other file changes

## Acceptance Criteria

- The commented role list in the YAML example block of `docs/config.md` includes `prd-validator` and `dependency-detector` in addition to all previously listed roles
- The comment formatting style matches the existing style used for the role list
- No other content in the file is modified
