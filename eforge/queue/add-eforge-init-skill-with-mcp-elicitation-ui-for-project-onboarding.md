---
title: Add `/eforge:init` skill with MCP elicitation UI for project onboarding
created: 2026-04-01
---

# Add `/eforge:init` skill with MCP elicitation UI for project onboarding

## Problem / Motivation

Project onboarding is friction-heavy. There is no `init` command - users must manually create `eforge/config.yaml` and know to add `.eforge/` to `.gitignore`. The existing `/eforge:config` skill walks through 12+ config sections via conversational Q&A, which is slow and overwhelming for first-time setup where most defaults are fine.

MCP elicitation support exists in both the SDK (v1.29.0, DRAFT-2026-v1 protocol) and Claude Code, but eforge doesn't use it. Elicitation lets the MCP server present structured forms (dropdowns, text fields, checkboxes) that Claude Code renders as interactive UI - much nicer than conversational interviews for structured choices.

## Goal

1. A new `/eforge:init` plugin skill that handles first-time project setup with minimal friction: adds eforge entries to `.gitignore`, creates `eforge/config.yaml` with sensible defaults, and only asks the user to choose their backend (claude-sdk or pi).
2. Both `/eforge:init` and `/eforge:config` should use MCP elicitation forms for user input instead of conversational Q&A. The MCP server sends elicitation requests and Claude Code renders them as interactive UI.

## Approach

### New MCP tool: `eforge_init`

Add a new tool to `src/cli/mcp-proxy.ts` that:

1. Checks if `eforge/config.yaml` already exists (abort if so, unless force flag)
2. Sends an elicitation form requesting backend choice (enum: claude-sdk, pi)
3. Adds `eforge/` and `.eforge/` to `.gitignore` if not already present
4. Writes `eforge/config.yaml` with chosen backend + all defaults
5. Calls config validation
6. Returns success with config summary

### Elicitation integration in MCP proxy

The eforge MCP server (`src/cli/mcp-proxy.ts`) needs to:

- Declare `elicitation: { form: {} }` in its client capabilities requirements
- Use the MCP SDK's elicitation API to send form requests from within tool handlers
- Handle accept/decline/cancel responses

Research needed during planning: how exactly to call elicitation from a tool handler in the `@modelcontextprotocol/sdk` Server class. The SDK types show `ElicitRequestFormParams` and `ElicitResult` but the wiring from tool handler to elicitation request needs to be traced.

### Updated `/eforge:config` skill

Rework the config skill to use elicitation forms for the interview step. Instead of 12 conversational questions, present grouped forms:

- Form 1: Backend + build settings (postMergeCommands, maxValidationRetries, maxConcurrentBuilds)
- Form 2 (opt-in): Agent/model tuning
- Form 3 (opt-in): Advanced (profiles, hooks, daemon)

### New `/eforge:init` skill markdown

Create `eforge-plugin/skills/init/init.md` that simply calls `mcp__eforge__eforge_init`. The skill is a thin launcher - the MCP tool handles the UX via elicitation.

### Plugin updates

- Add `./skills/init/init.md` to `plugin.json` commands array
- Bump plugin version

## Scope

**In scope:**

- New `eforge_init` MCP tool with elicitation form for backend choice
- New `/eforge:init` plugin skill
- `.gitignore` management (add eforge entries)
- Config file creation with defaults
- Understanding and implementing MCP elicitation in the proxy server

**Out of scope:**

- Full rework of `/eforge:config` to use elicitation (can be a follow-up, but include if straightforward)
- URL-mode elicitation (form mode only)
- Elicitation hooks for automation

## Acceptance Criteria

- Running `/eforge:init` in a project without eforge config presents an interactive form for backend choice, creates `eforge/config.yaml`, and updates `.gitignore`
- The form is rendered as structured UI by Claude Code (not conversational text)
- Running `/eforge:init` in an already-initialized project warns and does not overwrite
- Config created by init passes `eforge_config validate`
- Plugin version is bumped
