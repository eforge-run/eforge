---
description: Enqueue a source for the eforge daemon to build via MCP tool
argument-hint: "<source>"
disable-model-invocation: true
---

# /eforge:build

Enqueue a PRD file or description for the eforge daemon to build. Uses the eforge tools which communicate with the daemon for orchestration, agent execution, and state management.

## Arguments

- `source` (optional) - PRD file path or inline description of what to build

## Workflow

### Step 1: Resolve Source Input

Determine the working source from one of three branches:

**Branch A — File path**: If `$ARGUMENTS` is a file path (ends in `.md`, `.txt`, `.yaml`, or contains `/`):
1. Verify the file exists with the Read tool
2. Show a brief summary of what it describes
3. Use the **file path** as the source — skip directly to **Step 4**

**Branch B — Inline description**: If `$ARGUMENTS` is provided but is not a file path:
1. Note the inline description as the working source
2. Proceed to **Step 2**

**Branch C — No arguments**: If `$ARGUMENTS` is empty or not provided:

1. **Check for active session plan** — Scan `.eforge/session-plans/` for files where YAML frontmatter `status` is `ready` or `planning`. If found:
   - If one session plan exists, read it and present a summary: "I found a planning session: _{topic}_. Status: {status}."
   - If multiple exist, list them by topic and date, most recent first, and ask which to use
   - If the session status is `ready`, use the **session plan file path** as the source — skip directly to **Step 4**. **Do not read the file and rewrite, summarize, or convert it into a different format.** The eforge daemon handles PRD formatting; the session plan file is the source material it needs.
   - If the session status is `planning`, warn: "This session is still in planning — some dimensions are still missing." Then:
     - **New-format sessions** (frontmatter has `required_dimensions`): read `required_dimensions`, `skipped_dimensions`, and the body section names from the file. Match section headers case-insensitively after converting kebab-case dimension names to space-separated words (e.g., `code-impact` matches `## Code Impact`). A section counts as covered only if it has at least one non-empty, non-placeholder line of content — not just a header, blank lines, or "TBD"/"N/A". List required dimensions that have neither body content nor a `skipped_dimensions` entry as **truly missing**. Separately list any intentionally skipped dimensions with their recorded reason. Recommend `/eforge:plan --resume` only if at least one required dimension is truly missing.
     - **Legacy-format sessions** (frontmatter has `dimensions: { name: bool, ... }`): list every dimension whose value is `false` as missing (preserving current behavior) and suggest `/eforge:plan --resume` to continue.
     - Ask the user whether to submit as-is or continue planning (suggest `/eforge:plan --resume`)
   - If the user confirms a `planning` session, use the **session plan file path** as the source and proceed to **Step 4**

2. **Fall back to conversation context** — If no session plans are found (or the user declines to use one):
   - Examine conversation context for intent signals:
     - Recently discussed features or requirements
     - Files the user has been editing or asking about
     - Errors or issues the user has been troubleshooting
     - Goals or tasks the user has stated
   - If context yields a reasonable description, present it: "Based on our conversation, it sounds like you want to build: _{inferred description}_. Is that right?"
     - If the user confirms, use that description as the working source and proceed to **Step 2**
     - If the user corrects, use their correction as the working source and proceed to **Step 2**

3. If no session plans and no context available, ask: "What would you like to build? You can provide a description or a path to a PRD file."
   - **Stop here** if the user declines or no source is identified

### Step 2: Assess Completeness

Evaluate the working source against the 5 PRD sections the formatter expects:

| Section | What to look for |
|---------|-----------------|
| **Problem/Motivation** | Why this needs to be built — pain point, gap, or opportunity |
| **Goal** | What the end result should be — the desired outcome |
| **Approach** | How to accomplish it — strategy, patterns, or technical approach |
| **Scope** | Boundaries — what's in and out of scope |
| **Acceptance Criteria** | How to verify it's done — testable conditions |

**Threshold rules:**
- If the working source is **short (~30 words or fewer)**, always proceed to **Step 3** (interview) — short sources benefit from enrichment regardless of apparent coverage
- If the working source covers **3 or more** of the 5 sections, skip to **Step 4** (confirm) — the formatter can handle the remaining gaps
- Otherwise, proceed to **Step 3** (interview) for the missing sections

### Step 3: Interview

Ask about **missing sections only**. Use the question lookup table below to formulate questions. Combine all questions into a **single message** (max 4 questions).

**Question lookup table:**

| Missing section(s) | Question |
|--------------------|----------|
| Problem/Motivation + Goal (both missing) | "What problem are you trying to solve, and what should the end result look like?" |
| Problem/Motivation (alone) | "What's the pain point or gap that motivates this change?" |
| Goal (alone) | "What should the end result look like when this is done?" |
| Approach | "Do you have a preferred approach or technical strategy in mind?" |
| Scope | "Is there anything explicitly out of scope or any boundaries to be aware of?" |
| Acceptance Criteria | "How will you know this is done? Any specific conditions to verify?" |

**Escape hatch**: If the user responds with "just build it", "skip", "go ahead", or any similar signal to decline elaboration, accept the working source as-is and proceed to **Step 4**. The formatter handles missing sections gracefully (fills them with "N/A").

After the user responds, incorporate their answers into the working source and proceed to **Step 4**.

### Step 4: Confirm Source Preview

<!-- parity-skip-start -->
Present the assembled source for confirmation:

> **Source preview:**
>
> _{the complete working source text}_

Then ask: "Ready to send this to eforge? (confirm / edit / cancel)"

- **confirm** — Proceed to **Step 5**
- **edit** — Let the user revise, then re-display the updated preview
- **cancel** — Stop here

For **file path sources** (Branch A from Step 1), show a brief summary of the file contents in the blockquote instead of the full text, and note the file path.
<!-- parity-skip-end -->

### Step 5: Enqueue & Report

First, validate the project config by calling the `mcp__eforge__eforge_config` tool with `{ action: "validate" }`.

- If `configFound` is `false`, stop and tell the user:
  > **No eforge config found.** Run `/eforge:init` to initialize eforge in this project.

  **Do not proceed to enqueue.**

- If `valid` is `false`, display the errors and stop:
  > **Config validation failed:**
  >
  > _{list each error}_
  >
  > Fix your config with `/eforge:config` and try again.

  **Do not proceed to enqueue.**

- If `valid` is `true`, continue silently.

Call the `mcp__eforge__eforge_build` tool with `{ source: "<source>" }`.

The tool returns a JSON response with a `sessionId` and `autoBuild` status.

After successful enqueue:

1. If the source came from a session plan file (Branch C, step 1), update the session file's YAML frontmatter: set `status: submitted` and add `eforge_session: {sessionId}`.

2. Tell the user:

> PRD enqueued (session: `{sessionId}`). The daemon will auto-build.
>
<!-- parity-skip-start -->
> Watch live at {monitorUrl} or run `/eforge:status` for progress.
>
<!-- parity-skip-end -->
> The daemon formats your source into a PRD, selects a workflow profile, then compiles and builds. The pipeline varies by profile — errands skip straight to building, while excursions and expeditions go through planning and plan review first. Every profile gets blind code review (a separate agent with no builder context), merge, and post-merge validation.

If the monitor is running, also include the monitor URL.

## Error Handling

| Error | Action |
|-------|--------|
| Source file not found | Check path, suggest alternatives |
| No arguments and no context available | Ask the user what they want to build |
| User cancels at confirmation | Acknowledge and stop |
| Tool returns error | Show the error message from the daemon response |
| Config validation fails | Show errors, suggest fixing config, do not enqueue |
| No config found | Tell the user to run `/eforge:init` to initialize eforge |
| Daemon connection failure | The daemon auto-starts; if it still fails, suggest running `eforge daemon start` manually |

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:init` | No eforge config found in the project |
| `/eforge:build` | User wants to enqueue work for the daemon |
| `/eforge:config` | Config validation fails or user wants to view/edit config |
| `/eforge:status` | After enqueue, to check build progress |
