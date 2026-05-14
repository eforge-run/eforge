---
id: plan-03-consumer-extension-tools
name: Claude Code and Pi Extension Tooling Parity
branch: add-extension-discovery-config-and-loader/plan-03-consumer-extension-tools
agents:
  builder:
    effort: medium
    rationale: Adds a thin parity layer over the daemon/client API in both consumer
      integrations plus source-inspection tests.
  reviewer:
    effort: high
    rationale: Consumer-facing tool parity and plugin versioning require careful
      review against AGENTS.md conventions.
---

# Claude Code and Pi Extension Tooling Parity

## Architecture Context

`eforge-plugin/` and `packages/pi-eforge/` are the consumer-facing integrations. AGENTS.md requires parity between them when adding user-facing capabilities. Plan-02 adds CLI and daemon visibility; this plan exposes the same list/show/validate foundation to Claude Code and Pi agents without implementing the later `/eforge:extend` scaffold/test/replay workflow.

## Implementation

### Overview

Add a shared-action `eforge_extension` tool to the Claude Code MCP proxy and the Pi extension. Add a minimal slash-command skill in both integration packages that instructs agents to inspect and validate loaded native extensions through the tool. Keep the two skill bodies parity-compatible and update parity metadata and tests.

### Key Decisions

1. The tool action set is limited to `list`, `show`, and `validate`.
2. Tool handlers call `@eforge-build/client` extension helpers from plan-02; they do not inline request paths.
3. The slash command is `/eforge:extension`, not `/eforge:extend`; scaffold/test/replay remains out of scope.
4. Bump only the Claude Code plugin version because plugin files change; do not bump `packages/pi-eforge/package.json`.

## Scope

### In Scope

- Claude Code MCP tool `eforge_extension`.
- Pi native tool `eforge_extension`.
- Claude Code plugin skill `/eforge:extension`.
- Pi skill `/eforge:extension`.
- Skill parity script and generated-docs skill-pair config updates.
- Source-inspection tests for tool registration and parity.

### Out of Scope

- Extension scaffolding, enable/disable, trust mutation, promote/demote, reload, or event replay.
- Native Pi overlay UI for extension management.
- Monitor UI changes.

## Files

### Create

- `eforge-plugin/skills/extension/extension.md` — Claude Code slash-command skill for listing, showing, and validating native extensions.
- `packages/pi-eforge/skills/eforge-extension/SKILL.md` — Pi slash-command skill with parity-compatible body.
- `test/extension-consumer-surface.test.ts` — Source-inspection tests for MCP/Pi tool parity, skill files, and parity config.

### Modify

- `packages/eforge/src/cli/mcp-proxy.ts` — Register `eforge_extension` with actions `list`, `show`, and `validate`, using the shared client helpers.
- `packages/pi-eforge/extensions/eforge/index.ts` — Register matching native Pi tool with the same actions and daemon semantics.
- `eforge-plugin/.claude-plugin/plugin.json` — Add the new skill path and bump the plugin version.
- `scripts/check-skill-parity.mjs` — Add the `extension` ↔ `eforge-extension` pair.
- `packages/docs-gen/src/generators/tools.ts` — Add the same skill pair so generated tool docs include the new command.
- `test/profile-wiring.test.ts` — Extend existing source-inspection assertions if the new test file does not cover all parity checks.

## Verification

- [ ] `mcp-proxy.ts` registers exactly one `eforge_extension` tool with `list`, `show`, and `validate` actions.
- [ ] `packages/pi-eforge/extensions/eforge/index.ts` registers exactly one `eforge_extension` tool with `list`, `show`, and `validate` actions.
- [ ] Both tool handlers call `apiExtensionList()`, `apiExtensionShow()`, or `apiExtensionValidate()` from `@eforge-build/client`; neither handler calls `daemonRequest` directly or contains a literal `/api/extension` string.
- [ ] The plugin skill and Pi skill bodies match after `scripts/check-skill-parity.mjs` normalization.
- [ ] `scripts/check-skill-parity.mjs` includes the extension skill pair.
- [ ] `packages/docs-gen/src/generators/tools.ts` includes the extension skill pair.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is incremented from `0.25.1` and includes `./skills/extension/extension.md`.
- [ ] `packages/pi-eforge/package.json` version remains unchanged.