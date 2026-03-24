---
title: Plan: Interactive eforge Build Skill
created: 2026-03-24
status: pending
---

# Interactive eforge Build Skill

## Problem / Motivation

The `/eforge:build` skill has two gaps in its current 3-step workflow:

1. **Thin prompts** (e.g., "add dark mode") get passed directly to the formatter, which faithfully reformats them — producing a PRD with mostly N/A sections since the formatter is instructed never to invent content.
2. **No arguments + no plan file** dead-ends with a suggestion to create a PRD, when the conversation context often contains enough signal to infer intent.

The planner's downstream clarification loop handles *technical* ambiguities (which database, architecture choices), but the *what and why* — problem, goal, scope, acceptance criteria — should be enriched before the source ever reaches the formatter.

## Goal

Restructure the `build.md` skill from a 3-step workflow to a 5-step workflow with branching logic, so that thin prompts get enriched through a brief interview and no-argument invocations can infer intent from conversation context — all before the source reaches the formatter.

## Approach

Rewrite the skill workflow with the following 5 steps. No engine, formatter, or MCP tool changes — this is purely a skill-level enhancement.

### Step 1: Resolve Source Input (replaces current Step 1)

Three branches:

- **A. File path** — Verify exists, read, show summary. Skip to Step 4 (files are already well-structured).
- **B. Inline description** — Note as working source. Proceed to Step 2.
- **C. No arguments:**
  1. Check `~/.claude/plans/` for a plan file (existing behavior).
  2. If found → read, summarize, proceed to Step 4.
  3. If not found → **infer from conversation context**:
     - Look at: recently discussed features, files edited/read, errors being debugged, user's stated goals.
     - If a coherent intent is identifiable: present a 2–3 sentence summary, ask "Is this what you'd like to build, or would you like to describe something else?"
     - If ambiguous or multi-topic: say so, ask user to specify.
     - If no signal at all: ask open-ended "What would you like to build?"
     - User's response (or confirmed inference) becomes the working source → proceed to Step 2.

### Step 2: Assess Completeness (new)

Evaluate the working source against the formatter's 5 PRD sections:

1. Problem / Motivation — is there a "why"?
2. Goal — is the desired outcome stated?
3. Approach — any technical direction hints?
4. Scope — boundaries mentioned?
5. Acceptance Criteria — is "done" defined?

Rules:

- Under ~30 words → always interview (Step 3).
- 3+ sections covered → skip to Step 4.
- Fewer than 3 → proceed to Step 3.
- Track which sections are missing.

### Step 3: Interview (conditional, new)

Ask **only about missing sections**, max 4 questions, presented together in a single message:

| Missing section(s) | Question |
|---|---|
| Problem + Goal (both) | "What problem does this solve, and what's the desired outcome?" |
| Problem only | "What's the motivation? What pain point does it address?" |
| Goal only | "What should the end result look like?" |
| Approach (non-trivial changes only) | "Do you have a preferred approach or technical constraints?" |
| Scope | "Anything explicitly out of scope or boundaries to keep in mind?" |
| Acceptance Criteria | "How will you know this is done? What would you want to verify?" |

After answers, integrate them with the original source into an enriched working source.

**Escape hatch**: If the user says "just build it" or declines to elaborate, respect that and proceed to Step 4 with whatever is available. The formatter handles N/A sections gracefully.

### Step 4: Confirm Source Preview (new)

Present the assembled source in a blockquote and ask the user to confirm, edit, or cancel before enqueuing. For file paths, just show the path + brief summary.

### Step 5: Enqueue & Report (current Steps 2–3, unchanged)

Call `mcp__eforge__eforge_build`, report result with session ID and monitor info.

### Key Boundaries

- **Skill interviews about "what and why"** (problem, goal, scope, criteria) — high-level product intent.
- **Planner clarifies "how"** (technical decisions, architecture, implementation specifics) — downstream, separate concern.
- The skill should NOT ask about database choices, library preferences, or implementation patterns.

## Scope

### In Scope

- Rewriting `eforge-plugin/skills/build/build.md` from 3 steps → 5 steps with branching logic (~120 lines, up from 58).
- Bumping the plugin version in `eforge-plugin/.claude-plugin/plugin.json` (convention: any plugin skill change requires version bump).

### Out of Scope

- Engine changes.
- Formatter prompt changes.
- MCP tool changes.
- Planner or downstream agent changes.
- Technical/implementation-level clarification (that remains the planner's responsibility).

### Reference Files (read-only)

- `eforge-plugin/skills/config/config.md` — Interview pattern to mirror.
- `src/engine/prompts/formatter.md` — The 5 PRD sections the assessment aligns with.

## Acceptance Criteria

1. **Thin prompt triggers interview**: Running `/eforge:build add dark mode` triggers interview questions about missing PRD sections before enqueuing.
2. **Context inference with no args**: After a conversation about a feature, running `/eforge:build` with no arguments infers intent from conversation context and asks for confirmation.
3. **Detailed prompt skips interview**: Running `/eforge:build` with a detailed multi-paragraph prompt skips the interview, shows a preview, and proceeds directly.
4. **File path bypass unchanged**: Running `/eforge:build path/to/prd.md` behaves exactly as before (reads file, skips to enqueue).
5. **Escape hatch works**: During the interview, responding with "just build it" proceeds without further questions.
6. **Plugin version bumped**: `eforge-plugin/.claude-plugin/plugin.json` version is incremented.
