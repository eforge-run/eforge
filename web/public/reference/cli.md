<!-- Generated file. Do not edit. -->
<!-- eforge version: 0.7.12 -->
<!-- Commit: aefeaa45 -->
<!-- Source: packages/eforge/src/cli/index.ts -->

# eforge CLI Reference

Autonomous plan-build-review CLI for code generation.

**Usage:** `eforge [command] [options]`

## Commands

### `enqueue`

Normalize input and add it to the PRD queue


**Options:**

| Flag | Description |
|------|-------------|
| `--name <name>` | Override the inferred PRD title |
| `--verbose` | Stream agent output |
| `--no-plugins` | Disable plugin loading |
| `--profile <name>` | Override active profile for this enqueue + build |

### `build`

Compile + build + validate in one step

**Alias:** `run`


**Options:**

| Flag | Description |
|------|-------------|
| `--auto` | Run without approval gates |
| `--verbose` | Stream agent output |
| `--name <name>` | Plan set name (inferred from source if omitted) |
| `--queue` | Process all PRDs from the queue |
| `--max-concurrent-builds <n>` | Max parallel queue PRDs |
| `--dry-run` | Compile only, then show execution plan without building |
| `--foreground` | Run in-process instead of delegating to daemon |
| `--no-cleanup` | Keep plan files after successful build |
| `--no-monitor` | Disable web monitor |
| `--no-plugins` | Disable plugin loading |
| `--watch` | Watch mode: continuously poll the queue for new PRDs |
| `--poll-interval <ms>` | Poll interval in milliseconds for watch mode |

### `monitor`

Start or connect to the monitor dashboard


**Options:**

| Flag | Description |
|------|-------------|
| `--port <port>` | Preferred port |

### `status`

Check running builds


### `queue`

Manage PRD queue


#### `list`

Show PRDs in the queue


#### `run`

Process PRDs from the queue


**Options:**

| Flag | Description |
|------|-------------|
| `--all` | Process all pending PRDs |
| `--auto` | Run without approval gates |
| `--verbose` | Stream agent output |
| `--no-monitor` | Disable web monitor |
| `--no-plugins` | Disable plugin loading |
| `--max-concurrent-builds <n>` | Max parallel queue PRDs |
| `--watch` | Watch mode: continuously poll the queue for new PRDs |
| `--poll-interval <ms>` | Poll interval in milliseconds for watch mode |

#### `exec`

Build a single PRD directly (subprocess entry point for the queue scheduler)


**Options:**

| Flag | Description |
|------|-------------|
| `--auto` | Run without approval gates |
| `--verbose` | Stream agent output |
| `--no-monitor` | Disable web monitor |
| `--no-plugins` | Disable plugin loading |
| `--session-id <uuid>` | Session ID injected by parent scheduler (skips child session:start emission) |
| `--profile <name>` | Override active profile for this build |

### `extension`

Manage native eforge extensions


#### `list`

List discovered native extensions


**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Output JSON |

#### `show`

Show one native extension by name


**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Output JSON |

#### `validate`

Validate configured native extensions, or a single extension name/path


**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Output JSON |

#### `test`

Dry-run native extension event hooks against fixture or monitor events


**Options:**

| Flag | Description |
|------|-------------|
| `--run <run>` | Replay monitor DB events: latest or a session/run id |
| `--event <type>` | Filter replay input by exact event type |
| `--fixture <path>` | Replay project-local fixture events from a JSON or JSONL file |
| `--json` | Output JSON |

#### `new`

Scaffold a native eforge extension


**Options:**

| Flag | Description |
|------|-------------|
| `--scope <scope>` | Extension scope: local, project, or user |
| `--template <template>` | Scaffold template |
| `--force` | Overwrite an existing extension file |
| `--json` | Output JSON |

#### `reload`

Reload native extension discovery and restart the daemon watcher when running


**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Output JSON |

### `config`

Manage eforge configuration


#### `validate`

Validate eforge/config.yaml configuration


#### `show`

Show resolved eforge configuration


### `debug-composer`

Run only the pipeline-composer stage under one or more backend profiles and dump the request payload each backend constructs (system prompt, tools, model, thinking) for side-by-side diffing. Use --backend <name> to select profiles; repeat to compare multiple.


**Options:**

| Flag | Description |
|------|-------------|
| `--backend <name>` | Backend profile to test (repeatable). Defaults to the currently-active profile. |
| `--out <dir>` | Output directory for captured payloads |
| `--verbose` | Stream composer agent messages to stdout |

### `daemon`

Manage persistent daemon server


#### `start`

Start the persistent daemon server


**Options:**

| Flag | Description |
|------|-------------|
| `--port <port>` | Preferred port |

#### `stop`

Stop the persistent daemon server


**Options:**

| Flag | Description |
|------|-------------|
| `--force` | Skip active-build safety check |

#### `status`

Show daemon status


#### `kill`

Force-kill the daemon (SIGKILL)


### `recover`

Analyse a failed build and write recovery sidecar files


**Options:**

| Flag | Description |
|------|-------------|
| `--cwd <cwd>` | Working directory override |
| `--verbose` | Stream agent output |
| `--no-monitor` | Disable web monitor |

### `apply-recovery`

Apply the recovery verdict for a failed build plan (requeue, enqueue successor, or abandon)


**Options:**

| Flag | Description |
|------|-------------|
| `--cwd <cwd>` | Working directory override |
| `--no-monitor` | Disable web monitor |

### `playbook`

Manage playbooks


#### `list`

List all available playbooks with source and shadow chain


#### `new`

Scaffold a new playbook (non-interactive, for scripts)


**Options:**

| Flag | Description |
|------|-------------|
| `--scope <scope>` | Playbook scope: user \| project-team \| project-local |
| `--name <name>` | Playbook name (kebab-case) |
| `--description <description>` | Short description of the playbook |
| `--from <file>` | Read body content from this file (used as the Goal section) |

#### `edit`

Open a playbook in $EDITOR, validate, and save to the same tier


#### `run`

Enqueue a playbook as a PRD


**Options:**

| Flag | Description |
|------|-------------|
| `--after <queue-id>` | Queue ID that this PRD should run after (piggyback) |

#### `promote`

Promote a playbook from project-local to project-team (stages with git add)


#### `demote`

Demote a playbook from project-team to project-local (.eforge/playbooks/)


### `play`

Shortcut for `eforge playbook run <name>`


**Options:**

| Flag | Description |
|------|-------------|
| `--after <queue-id>` | Queue ID that this PRD should run after (piggyback) |

### `mcp-proxy`

Run the MCP stdio proxy server (used by Claude Code plugin)


## Global options

**Options:**

| Flag | Description |
|------|-------------|
| `-V, --version` | output the version number |
