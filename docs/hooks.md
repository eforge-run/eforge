# Hooks

Hooks are shell commands that fire in response to eforge events. They run in the background and do not block or influence the eforge pipeline in any way - a hook can fail, time out, or run slowly without affecting the build. This makes them suitable for logging, notifications, time tracking, and external system integration, but not for gating or modifying behavior.

This is different from Claude Code hooks, which can block tool execution. eforge hooks are strictly informational and fire-and-forget.

## Configuration

Hooks are configured in `eforge/config.yaml` under the `hooks` key. Each hook specifies an event pattern and a shell command:

```yaml
hooks:
  - event: "session:start"
    command: "~/.config/eforge/hooks/session-start.sh"
    timeout: 5000
  - event: "agent:tool_use"
    command: "~/.config/eforge/hooks/log-event.sh"
    timeout: 5000
  - event: "plan:build:*"
    command: "~/.config/eforge/hooks/build-notify.sh"
    timeout: 3000
```

### Event patterns

Patterns use glob-style matching where `*` matches any characters:

| Pattern | Matches |
|---------|---------|
| `session:start` | Exact match |
| `plan:build:*` | `plan:build:start`, `plan:build:complete`, `plan:build:failed`, etc. |
| `*:complete` | `planning:complete`, `plan:build:complete`, `wave:complete`, etc. |
| `agent:*` | All agent-level events |

### Timeout

Each hook has a configurable timeout in milliseconds. If the hook doesn't complete within the timeout, it receives `SIGTERM`. Defaults to 5000ms.

## Environment variables

Every hook receives these environment variables:

| Variable | Description |
|----------|-------------|
| `EFORGE_SESSION_ID` | Session identifier - stable across compile+build per PRD. In queue mode, each PRD gets its own session ID. Use this for session tracking. |
| `EFORGE_RUN_ID` | Per-phase run identifier. Changes between compile and build phases. |
| `EFORGE_EVENT_TYPE` | Event type string (e.g., `plan:build:start`, `agent:tool_use`) |
| `EFORGE_CWD` | Working directory for the eforge run |
| `EFORGE_GIT_REMOTE` | Git origin remote URL (empty if not a git repo or no origin) |

`EFORGE_CWD` and `EFORGE_GIT_REMOTE` are resolved once at startup. `EFORGE_EVENT_TYPE` is set per event. `EFORGE_SESSION_ID` and `EFORGE_RUN_ID` are captured from lifecycle events.

For `eforge run`, `EFORGE_SESSION_ID` stays the same across the compile and build phases for each PRD while `EFORGE_RUN_ID` changes. In queue mode (`--queue`), each PRD gets a unique session ID - queue-level events (`queue:start`, `queue:complete`, etc.) carry no `EFORGE_SESSION_ID`.

## Event JSON on stdin

The full event JSON is piped to the hook's stdin. Parse it with `jq` or similar:

```bash
#!/bin/bash
CONTEXT=$(cat)
PLAN_ID=$(echo "$CONTEXT" | jq -r '.planId // empty' 2>/dev/null)
TOOL_NAME=$(echo "$CONTEXT" | jq -r '.tool // empty' 2>/dev/null)
```

## Global vs project configuration

Hooks can be configured at two levels:

1. **Global** - `~/.config/eforge/config.yaml` (or `$XDG_CONFIG_HOME/eforge/config.yaml`)
2. **Project** - `eforge/config.yaml` in the project root

When both are present, hook arrays are **concatenated** - global hooks fire first, then project hooks. This lets you keep general-purpose hooks (notifications, time tracking) global while adding project-specific hooks where needed.

## Event types

All event types are defined in [`packages/engine/src/events.ts`](../packages/engine/src/events.ts) as the `EforgeEvent` discriminated union. Refer to that file for the complete list - event type strings follow the `category:action` pattern (e.g., `build:start`, `agent:tool_use`, `validation:failed`).
