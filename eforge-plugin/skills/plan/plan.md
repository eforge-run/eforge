---
description: Start or resume a structured planning conversation for changes to be built by eforge. Explores scope, code impact, architecture, design decisions, documentation, and risks before handing off to eforge.
argument-hint: "[topic] [--resume]"
---

# /eforge:plan — Planning Conversation

Start or resume a structured planning conversation. The output is a session plan file in `.eforge/session-plans/` that accumulates decisions and context as the conversation progresses. When planning is complete, `/eforge:build` picks up the session plan and enqueues it.

## Arguments

- `topic` (optional) — What to plan. If omitted, ask the user.
- `--resume` — Resume the most recent active session instead of starting a new one.

## Workflow

### Step 1: Session Setup

**Resume path** — If `--resume` is passed or the user says "resume" / "continue planning":
1. Scan `.eforge/session-plans/` for files where `status` in frontmatter is `planning` or `ready`
2. If one found, read it and present a summary of where things stand: topic, what dimensions have content, key decisions so far, any open questions
3. If multiple found, list them and ask which to resume
4. If none found, tell the user and offer to start a new session
5. Continue from whatever dimension needs work

**New session path**:
1. If no topic provided, ask: "What change are you planning?"
2. Generate a session ID: `{YYYY-MM-DD}-{slug}` where slug is a short kebab-case derived from the topic (e.g., `2026-04-03-add-dark-mode`)
3. Create `.eforge/session-plans/{session-id}.md` with initial frontmatter:

```markdown
---
session: {session-id}
topic: "{topic}"
created: {ISO timestamp}
status: planning
dimensions:
  scope: false
  code-impact: false
  architecture-impact: false
  design-decisions: false
  documentation-impact: false
  risks: false
profile: null
---

# {Topic}
```

4. Proceed to Step 2

### Step 2: Gather Context

Read project context relevant to the topic:

1. **CLAUDE.md / AGENTS.md** — Project overview, architecture, conventions
2. **Roadmap** (`docs/roadmap.md`) — Check alignment with planned direction
3. **Codebase exploration** — Search for code related to the topic: grep for key terms, read relevant files, understand current patterns
4. **Existing docs** — Identify documentation that might be affected (README, architecture docs, config docs, API docs)

Write a `## Context` section to the session file summarizing what you found. Present the summary to the user so the conversation starts from shared understanding.

**Update the session file** after this step.

### Step 3: Triage

Based on the topic and context gathered, assess the likely scope:

| Signal | Size | Depth |
|--------|------|-------|
| Single-file fix, typo, config tweak | **Small** | Quick pass — scope + code impact, skip others unless relevant |
| Multi-file feature, refactor, new capability | **Medium** | All dimensions, moderate depth |
| Cross-cutting architectural change, new subsystem | **Large** | All dimensions, deep — especially architecture impact |

Tell the user your assessment: "This looks like a [small/medium/large] change — I'll adjust depth accordingly." The user can override.

For **small** changes, compress Steps 4-9 — briefly confirm scope and code impact, then move to readiness. Don't force the user through dimensions that don't apply.

### Step 4: Scope

Establish what's in and out:

- What exactly is changing?
- What is explicitly NOT changing? (important for keeping eforge focused)
- Are there natural boundaries? (e.g., "backend only", "just the CLI", "types + all consumers")
- Does this relate to or conflict with roadmap items?

Write `## Scope` (with `### In Scope` and `### Out of Scope` subsections) to the session file. Mark `scope: true` in frontmatter dimensions.

### Step 5: Code Impact

Explore what areas of the codebase are affected:

- What files/modules/packages will need changes?
- What patterns exist that should be followed? (find similar features as examples)
- Are there shared utilities to reuse?
- What are the dependency relationships between affected areas?
- Are there tests that cover the affected areas?

Write `## Code Impact` to the session file. Mark `code-impact: true`.

### Step 6: Architecture Impact

Assess whether this changes the system's structure:

- Does this introduce new module boundaries or change existing ones?
- Does this change contracts between components? (APIs, interfaces, data formats)
- Does this change data flow or control flow at a system level?
- Does this affect public API surface?
- Does this change how the system is deployed, configured, or operated?

If the change has no architecture impact (many don't), note "No architecture impact — this operates within existing boundaries" and move on.

Write `## Architecture Impact` to the session file. Mark `architecture-impact: true`.

### Step 7: Design Decisions

Surface local design choices that matter:

- Data structures and representations
- API shape (if introducing or changing APIs)
- Error handling strategy
- Naming conventions
- Algorithm or approach choices
- Trade-offs being made (and why)

For each decision, capture the choice AND the rationale. These inform eforge's planner.

Write `## Design Decisions` (numbered list, each with rationale) to the session file. Mark `design-decisions: true`.

### Step 8: Documentation Impact

Identify what documentation would go stale:

- README sections describing affected features
- CLAUDE.md / AGENTS.md sections that describe architecture or conventions
- Architecture docs (`docs/architecture.md`, ADRs)
- Config docs (if config schema changes)
- API docs (if API surface changes)
- Inline code documentation (significant docstrings, module headers)

Be specific — name the files and sections, not just "docs might need updating."

Write `## Documentation Impact` (bullet list of file + what needs updating) to the session file. Mark `documentation-impact: true`.

### Step 9: Risks & Edge Cases

Identify what could go wrong:

- What are the tricky parts of this change?
- What edge cases need handling?
- Are there backward compatibility concerns?
- Could this break existing functionality? How?
- Are there performance implications?
- What happens if this change is partially applied? (important for eforge's multi-plan orchestration)

Write `## Risks & Edge Cases` to the session file. Mark `risks: true`.

### Step 10: Profile Signal

Based on everything explored, recommend an eforge profile:

| Profile | When |
|---------|------|
| **Errand** | Trivial, mechanical — typo, config tweak, single obvious fix |
| **Excursion** | Most feature work, multi-file refactors, bug fixes spanning multiple files |
| **Expedition** | 4+ independent subsystems, cross-cutting architectural changes |

Write the recommendation and rationale to `## Profile Signal` in the session file. Update `profile` in frontmatter.

### Step 11: Readiness

When all relevant dimensions have been explored (or explicitly skipped for small changes):

1. Update session file status to `ready` in frontmatter
2. Present a summary:

```
Planning complete for: {topic}

Dimensions covered:
  ✓ Scope — {one-line summary}
  ✓ Code Impact — {one-line summary}
  ✓ Architecture Impact — {one-line summary or "no impact"}
  ✓ Design Decisions — {count} decisions captured
  ✓ Documentation Impact — {count} docs identified
  ✓ Risks — {count} risks identified

Profile: {errand|excursion|expedition}

Ready to build. Run /eforge:build to enqueue.
```

If any dimension is thin and the change is non-trivial, flag it: "⚠ Architecture Impact was briefly addressed — worth another look before submitting?"

## Session File Updates

Update the session file at these milestones:
- After context gathering (Step 2)
- After each dimension is explored (Steps 4-9)
- After profile signal (Step 10)
- When status changes (planning → ready)

Use the Edit tool for incremental updates — don't rewrite the entire file each time.

## Conversation Style

This skill supports long, iterative conversations. Key behaviors:

- **Be thorough but not rigid** — follow the user's energy. If they want to go deep on architecture, go deep. If they want to move fast, move fast.
- **Push back when things are vague** — if the user says "it should handle errors properly", ask what specific error conditions matter and what the recovery behavior should be.
- **Bring codebase evidence** — don't discuss in the abstract. Read the actual code, show the actual patterns, reference the actual files.
- **Track what's been decided** — when a decision is made, write it down in the session file immediately. Don't let decisions drift.
- **Surface tensions** — if a design decision conflicts with an existing pattern, or a scope boundary seems artificial, say so.

## Error Handling

| Condition | Action |
|-----------|--------|
| `.eforge/session-plans/` doesn't exist | Create it |
| CLAUDE.md not found | Proceed without it, note limited context |
| No roadmap found | Skip roadmap alignment check |
| Session file gets corrupted | Offer to start a new session |
| User wants to abandon a session | Set status to `abandoned` in frontmatter |
| User wants to restart from scratch | Create a new session, leave old one as-is |

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Init | `/eforge:init` | No eforge config found in the project |
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Restart | `/eforge:restart` | User wants to restart the eforge daemon |
| Update | `/eforge:update` | User wants to check for or install eforge updates |
