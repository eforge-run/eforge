---
description: Conversational requirement refinement using full Claude Code context to produce a high-quality PRD file for eforge
argument-hint: "[source]"
disable-model-invocation: true
---

# /eforge:plan

Go from rough idea to a refined PRD file through conversational exploration. This skill uses Claude Code's full context (codebase knowledge, MCP tools, prior discussion) to produce requirements clear enough for `eforge run` to generate high-quality plans without needing its own clarification loop.

The output is a PRD markdown file — this skill does NOT invoke the eforge CLI.

## Arguments

- `source` (optional) — PRD file path to refine, or inline prompt describing what to build. If omitted, start a conversation about what the user wants to build.

## Workflow

### Step 1: Understand Intent

Read the source from `$ARGUMENTS`:
- **File path**: Read it with the Read tool
- **Inline prompt**: Use it as the starting point
- **Nothing provided**: Ask the user what they want to build

Use conversation context and any prior discussion to understand:
- What the user wants to build
- Why they're building it
- What constraints exist

If the source is vague or minimal, that's fine — refinement happens in Step 3.

### Step 2: Explore Codebase

Use Read, Grep, and Glob tools to understand the relevant parts of the codebase:
- Existing patterns and conventions the new work should follow
- Related code that will be touched or extended
- Test patterns in use
- Configuration and infrastructure relevant to the change

Share key findings with the user — this grounds the conversation in reality rather than assumptions.

### Step 3: Refine Requirements

Ask targeted clarifying questions to fill gaps in the source. Ground questions in codebase findings:

- "I see you have an Express API in `src/routes/` — should the new endpoint follow the same pattern?"
- "The existing tests use vitest with this setup — should we follow that?"
- "There's already a `UserService` class — should this extend it or be separate?"

Identify:
- Ambiguities and unstated assumptions
- Missing acceptance criteria
- Edge cases worth addressing
- Dependencies on other systems or code

Keep this conversational — 2-4 rounds of questions is typical. Don't over-interrogate.

### Step 4: Write PRD

Based on the conversation, write a structured PRD markdown file:

- **If refining an existing file**: Suggest specific edits to strengthen it. Apply with the Edit tool after user approval.
- **If starting fresh**: Write a new PRD file. Default output to `docs/prd-queue/<name>.md` (or the configured queue directory from `eforge.yaml` `prdQueue.dir`). Ask the user if they'd prefer a different location.

Include YAML frontmatter at the top of the file:
```yaml
---
title: <descriptive title>
created: <today's ISO date, e.g. 2026-03-17>
priority: <ask user, or omit if no preference>
status: pending
---
```

The PRD body should be clear, specific, and complete enough for eforge to plan from. Encourage these sections:
- Problem statement / motivation
- Goal
- Design / approach
- Scope (in scope and out of scope)
- Acceptance criteria
- Relevant technical context from codebase exploration

### Step 5: Suggest Next Step

After the PRD is written:

> PRD enqueued to **{path}**. Run `eforge queue list` to see the queue, or `eforge queue run <name>` to build it now.

## Error Handling

| Condition | Action |
|-----------|--------|
| Source file not found | Check path, suggest alternatives, or start fresh |
| User wants to restart | Re-run from Step 3 with updated understanding |
| PRD already exists | Read it, suggest improvements based on exploration |
