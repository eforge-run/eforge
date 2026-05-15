<!-- Generated file. Do not edit. -->
<!-- eforge version: 0.7.12 -->
<!-- Commit: d171f301 -->
<!-- Source: packages/engine/src/config.ts -->

# eforge Configuration Reference

eforge merges configuration from three tiers (highest precedence first):

1. `.eforge/config.yaml` — project-local, gitignored, developer-personal
2. `eforge/config.yaml` — project-level, committed
3. `~/.config/eforge/config.yaml` — user-global

## Top-level fields

| Field | Description |
|-------|-------------|
| `agents` |  |
| `build` |  |
| `daemon` |  |
| `extensions` | Native eforge extension configuration |
| `hooks` |  |
| `langfuse` |  |
| `maxConcurrentBuilds` |  |
| `monitor` |  |
| `plan` |  |
| `plugins` |  |
| `prdQueue` |  |
| `tools` |  |

## Toolbelts

`tools.toolbelts` declares named bundles of project MCP servers that tiers can opt into with `agents.tiers.<tier>.toolbelt`. Toolbelts are intended for profiles that need a focused capability set, such as browser automation for UI implementation and review.

```yaml
tools:
  toolbelts:
    browser-ui:
      description: Browser automation for UI implementation and review.
      mcpServers:
        - playwright

agents:
  tiers:
    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6
      effort: medium
      toolbelt: browser-ui
    planning:
      harness: claude-sdk
      model: claude-opus-4-7
      effort: high
      toolbelt: none
```

- `tools.toolbelts.<name>.description` is optional human-readable prose for list/show surfaces.
- `tools.toolbelts.<name>.mcpServers` is a non-empty list of server names from `.mcp.json`.
- `agents.tiers.<tier>.toolbelt` names one declared toolbelt, or uses `toolbelt: none` to pass no project MCP servers to that tier.
- An omitted `toolbelt` keeps the default behavior: all project MCP servers from `.mcp.json` are passed through.
- Toolbelts filter only project MCP servers from `.mcp.json`; they do not affect Pi extensions, Claude Code plugins, engine-internal tools, extension-contributed custom tools, or harness built-ins.
- Validation rejects reserved toolbelt names such as `none`, invalid toolbelt names, tier references to undeclared toolbelts, missing `.mcp.json` files when a toolbelt declares MCP servers, and toolbelt server names that are not present under `.mcp.json` `mcpServers`.

## Hooks

`hooks` is an optional list of fire-and-forget shell commands triggered by eforge events. Hooks are for notifications, logging, and external integrations; they do not block the build pipeline.

```yaml
hooks:
  - event: plan:build:complete
    command: "notify-send 'Build complete'"
    timeout: 5000
  - event: plan:build:failed
    command: "curl -X POST $SLACK_WEBHOOK -d '{\"text\": \"Build failed\"}'"
```

| Field | Description |
|-------|-------------|
| `event` | Event name or pattern that triggers the hook command. |
| `command` | Shell command executed when the event matches. |
| `timeout` | Optional positive timeout in milliseconds; defaults to `5000`. |

Hook commands run asynchronously from the pipeline path. Use them for best-effort side effects, not required validation or build steps.

## JSON Schema

The complete machine-readable schema is at [`/schemas/config.schema.json`](/schemas/config.schema.json).
