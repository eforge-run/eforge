---
title: Configuration
description: Key configuration options for eforge and how to tune them.
---

# Configuration

eforge is configured via `eforge/config.yaml` (searched upward from cwd). All fields are optional - defaults work for most projects. This page covers the most commonly tuned options. For the full schema see the [Configuration Reference](/reference/config).

## The Three Config Tiers

Config merges from three levels (lowest to highest priority):

| Tier | Path | Committed? | Purpose |
|------|------|-----------|---------|
| User | `~/.config/eforge/config.yaml` | No | Cross-project, personal |
| Project | `eforge/config.yaml` | Yes | Team-canonical |
| Project-local | `.eforge/config.yaml` | No (gitignored) | Personal override |

The project-local tier deep-merges over the others. Use it for personal tuning - different model choices, extra verbosity, or test commands you do not want to commit.

## Initialization

The fastest way to set up config is `/eforge:init` in Claude Code or Pi. It scaffolds `eforge/config.yaml` with sensible defaults and walks you through harness and model selection.

To edit config interactively after initialization: `/eforge:config --edit`.

## Agent Tiers

Tiers are the primary configuration axis. Each tier is a self-contained recipe: `harness + model + effort`.

```yaml
agents:
  tiers:
    planning:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6
      effort: medium
    review:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
    evaluation:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
```

You only need to list tiers you want to change - unspecified tiers keep their engine defaults.

**Effort levels**: `low`, `medium`, `high`, `xhigh`, `max`. Higher effort means more agent turns and more thorough output, at higher cost.

**Thinking**: Add `thinking: true` to a tier to enable extended thinking. It is coerced to adaptive mode for models that only support adaptive thinking.

## Using the Pi Harness

To build with a provider other than Anthropic, set `harness: pi` and add a `pi.provider` block:

```yaml
agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: anthropic/claude-sonnet-4-6
      effort: medium
      pi:
        provider: openrouter
```

Pi supports OpenAI, Google, Mistral, Groq, xAI, Bedrock, Azure, OpenRouter, and local models. Authentication resolves from provider-specific environment variables or `~/.pi/agent/auth.json`. For OAuth providers (OpenAI Codex, GitHub Copilot), run `pi auth login <provider>` first.

## Agent Runtime Profiles

A profile bundles tier recipes into a reusable named file. This lets you switch between configurations - such as "use Claude for review, local model for implementation" - without editing `eforge/config.yaml`.

Profiles live at three scopes:

- `~/.config/eforge/profiles/` - User scope
- `eforge/profiles/` - Project scope (committed)
- `.eforge/profiles/` - Project-local scope (gitignored)

The active profile is resolved highest-priority-first. Set one with:

```
/eforge:profile use <name>
```

Or from the CLI: `eforge profile use <name>`.

## Native Extensions

Native eforge extensions are TypeScript/JavaScript modules discovered from three scopes:

| Scope | Directory | Trust default |
|-------|-----------|---------------|
| User | `~/.config/eforge/extensions/` | trusted |
| Project/team | `eforge/extensions/` | skipped unless trusted |
| Project-local | `.eforge/extensions/` | trusted |

Precedence is `project-local > project-team > user`. Use project-local extensions for experiments, then promote to `eforge/extensions/` when the team should share them. Project/team extensions require an explicit trust opt-in because they are committed code.

```yaml
extensions:
  enabled: true                  # default
  include:
    - build-notifier             # optional allowlist by name
  exclude:
    - experimental-policy        # optional denylist by name
  paths:
    - ./tools/eforge-audit.ts    # explicit file/directory paths
  trustProjectExtensions: false  # default
```

Supported extension entrypoints are `.ts`, `.mts`, `.js`, and `.mjs` files or directories with `index.*` / supported `package.json` entrypoints. TypeScript loads through `jiti`; JavaScript uses dynamic import. The loader executes the default-export factory in the eforge daemon/worker Node process without a sandbox, records registrations, and surfaces status, diagnostics, shadows, trust, source, strategy, and registration counts through `eforge extension list/show/validate` and extension API routes.

Current runtime support includes discovery, trust gating, loading, diagnostics, provenance output, registration capture, native `onEvent` dispatch, and management commands (`eforge extension list/show/validate/new/reload`). Blocking policy enforcement, agent augmentation, and other non-event registered capability execution are deferred runtime phases. See [Extensions](/docs/extensions) and [Extensions API Reference](/docs/extensions-api).

## Profile Toolbelts for UI Work

Toolbelts let a tier opt into a named bundle of project MCP servers from `.mcp.json`. When a profile targets UI-heavy or browser-validation work, pair it with a `browser-ui` toolbelt backed by the Playwright MCP server. For the full field reference, see the [Toolbelts](/reference/config#toolbelts) section in the Configuration Reference.

**Step 1 - Register the toolbelt in `eforge/config.yaml`:**

```yaml
tools:
  toolbelts:
    browser-ui:
      description: Browser automation for UI implementation and review.
      mcpServers:
        - playwright
```

**Step 2 - Create `eforge/profiles/ui.yaml`:**

```yaml
# eforge/profiles/ui.yaml
description: UI-heavy feature work with browser validation.
whenToUse:
  - Frontend features
  - Layout bugs
  - Screenshot-driven UI fixes
tags:
  - ui
  - frontend
  - browser

agents:
  tiers:
    planning:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
      toolbelt: none

    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6
      effort: medium
      toolbelt: browser-ui

    review:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
      toolbelt: browser-ui

    evaluation:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
      toolbelt: none
```

**Step 3 - Add the Playwright MCP server to `.mcp.json`:**

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

**MVP constraints:**

1. Toolbelts filter only project MCP servers from `.mcp.json` - they do not affect Pi extensions, Claude Code plugins, engine-internal tools, or harness built-ins.
2. Each tier picks at most one toolbelt via the singular `toolbelt` field.
3. `toolbelt: none` passes no project MCP servers to agents in that tier.
4. An omitted `toolbelt` keeps the default: all servers from `.mcp.json` are passed through.
5. Pi extensions and Claude Code plugins are out of scope for this MVP - toolbelts are MCP-only and declarative.
6. Toolbelts are declarative MCP bundles; extensions are imperative lifecycle behavior. Extensions may inspect toolbelt and profile metadata when making routing decisions, but extensions should not redefine toolbelts or act as a hidden config layer.

For the complete field schema and validation behavior, see the [Toolbelts](/reference/config#toolbelts) section in the Configuration Reference. For the extension/toolbelt boundary, see the [Extensions API Reference](/docs/extensions-api#toolbelt-vs-extension-boundary).

## Post-Merge Commands

Commands to run after all plans merge - compile, test, lint, or any validation step:

```yaml
build:
  postMergeCommands:
    - "pnpm type-check"
    - "pnpm test"
  maxValidationRetries: 2
```

Each command runs under a 5-minute wall-clock timeout. On failure, a validation-fixer agent attempts repairs up to `maxValidationRetries` times.

## Queue Concurrency

How many PRDs to build concurrently when processing the queue:

```yaml
maxConcurrentBuilds: 2   # default
```

Within a single build, plans run in parallel automatically as their dependencies are satisfied - no configuration needed there.

## Per-Role Tuning

Fine-tune individual agent roles without reassigning them to a different tier:

```yaml
agents:
  roles:
    builder:
      effort: high
      maxTurns: 80
    reviewer:
      promptAppend: |
        ## Project Rules
        - Flag raw SQL queries
        - Require error handling for all async operations
    formatter:
      effort: low
```

Available per-role fields: `tier`, `effort`, `thinking`, `maxTurns`, `allowedTools`, `disallowedTools`, `promptAppend`, `shards` (builder-only).

## Custom Prompts

Override any bundled agent prompt by placing a `.md` file in `eforge/prompts/` with the same name as the role:

```yaml
agents:
  promptDir: eforge/prompts
```

If `eforge/prompts/reviewer.md` exists, it replaces the bundled reviewer prompt entirely. Use `promptAppend` on a role for additive rules instead of full replacement.

## Hooks

Hooks are fire-and-forget shell commands triggered by eforge events - useful for notifications, logging, and external integrations:

```yaml
hooks:
  - event: plan:build:complete
    command: "notify-send 'Build complete'"
    timeout: 5000
  - event: plan:build:failed
    command: "curl -X POST $SLACK_WEBHOOK -d '{\"text\": \"Build failed\"}'"
```

Hooks do not block the pipeline. See the [Hooks](/reference/config#hooks) section in the Configuration Reference for field details.

## Full Reference

For the complete `eforge/config.yaml` schema with all fields, types, and defaults, see the [Configuration Reference](/reference/config).
