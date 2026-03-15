# EForge Plugin Spec

## What This Is

A Claude Code plugin that makes eforge accessible within Claude Code. The plugin is a thin launcher + conversational planning facilitator — it does not reimplement eforge's engine. All orchestration, agent execution, state management, and monitoring are handled by the `eforge` CLI.

**Prerequisite**: `eforge` must be installed and on PATH.

## Plugin Structure

```
eforge-plugin/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    ├── plan/
    │   └── SKILL.md          # /eforge:plan — conversational PRD authoring
    ├── run/
    │   └── SKILL.md          # /eforge:run — compile + build + validate delegation
    └── status/
        └── SKILL.md          # /eforge:status — state file rendering
```

No internal coordinator skills. No bash scripts. No completion markers. The eforge CLI handles all of that internally.

## How This Differs from the Orchestrate Plugin

The orchestrate plugin IS the orchestrator — it coordinates Tasks, manages state, and spawns `claude --print` subprocesses via bash scripts. The eforge plugin just LAUNCHES the `eforge` CLI, which is itself a complete orchestrator.

| Aspect | Orchestrate | EForge |
|--------|------------|---------|
| Orchestration | Plugin coordinates everything | CLI handles it |
| Scripts | Bash scripts spawn `claude --print` | No scripts needed |
| Coordinator skills | Internal coordinator SKILLs | None |
| Completion markers | `ORCHESTRATION_COMPLETE` etc. | CLI exit codes |
| State tracking | Plugin manages state file | CLI manages `.eforge/state.json` |

---

## Skills

### `/eforge:plan <source>`

**Frontmatter**: `disable-model-invocation: true`

The core value-add skill — conversational requirement refinement that produces a high-quality PRD file. This skill does NOT invoke the eforge CLI.

**Purpose**: Help users go from rough idea → refined PRD through codebase-aware conversation. By using Claude Code's full context (MCP tools, codebase knowledge, prior discussion), the resulting PRD is clear enough for `eforge run` to generate high-quality plans without needing its own clarification loop.

**Workflow**:

1. **Understand intent** — Read the source (PRD file path, inline prompt, or nothing). Use conversation context to understand what the user wants to build and why.

2. **Explore codebase** — Use Read, Grep, Glob to understand relevant patterns, conventions, and code that will be touched. Share findings with the user.

3. **Refine requirements** — Ask targeted clarifying questions grounded in codebase findings. 2-4 rounds typical. Identify ambiguities, missing acceptance criteria, unstated assumptions.

4. **Write PRD** — Write a structured PRD markdown file (or edit an existing one). The PRD should include problem statement, requirements, acceptance criteria, and relevant technical context.

5. **Suggest next step** — Point the user to `/eforge:run <prd-path>` to plan and build.

**Output**: A PRD markdown file ready for `eforge run`.

### `/eforge:run <source>`

**Frontmatter**: `disable-model-invocation: true`

**Purpose**: Validate a source and delegate to `eforge run` (compile + build + validate in one step) as a background task.

**Workflow**:

1. **Validate source** — Check that the source file exists and is readable, accept an inline description, or auto-detect a plan file from the current `/plan` session's conversation context.

2. **Preview (optional)** — Run `eforge run <source> --dry-run` to show the execution plan before committing.

3. **Launch** — Run `eforge run <source> --auto --verbose` as a background Bash task. The `--auto` flag is safe because the user approved by invoking this skill.

4. **Monitor link** — Point to `http://localhost:4567` for real-time progress. Suggest `/eforge:status` for inline checks. Post-merge validation is included in the run.

**Why background**: Builds take 10-60+ minutes. The user should be able to continue working.

### `/eforge:status`

**Frontmatter**: `disable-model-invocation: true`

**Purpose**: Quick inline status check without opening the monitor dashboard.

**Workflow**:

1. **Read state** — Read `.eforge/state.json` if it exists.
2. **Render** — Show plan set name, overall status, per-plan progress, duration.
3. **Monitor link** — If running, link to `http://localhost:4567`.
4. **No state** — If no state file, report no active builds and suggest `/eforge:run`.

This is the only skill that doesn't invoke the eforge CLI — it just reads and renders a JSON file.

---

## Primary Flow

```
/eforge:plan → writes PRD → /eforge:run <prd> → monitor with /eforge:status
```

## CLI Reference

Commands the plugin wraps:

```
eforge run <source>       # Compile + build + validate in one step
eforge status             # Check running builds
```

Key flags:
- `--auto` — bypass approval/clarification gates
- `--verbose` — stream agent output
- `--dry-run` — validate and show execution plan without running
- `--no-monitor` — disable web monitor
- `--parallelism <n>` — max concurrent plans

Exit codes: 0 = success, 1 = failure

## State File Format

`.eforge/state.json` — read by `/eforge:status`:

```json
{
  "setName": "feature-name",
  "status": "running",
  "startedAt": "2026-03-14T10:00:00Z",
  "baseBranch": "main",
  "plans": {
    "plan-id": {
      "status": "pending|running|completed|failed|blocked|merged",
      "branch": "eforge-plan-id",
      "dependsOn": [],
      "merged": false
    }
  },
  "completedPlans": ["plan-id"]
}
```
