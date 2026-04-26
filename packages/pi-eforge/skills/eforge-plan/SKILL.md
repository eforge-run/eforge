---
name: eforge-plan
description: Start or resume a structured planning conversation for changes to be built by eforge. Classifies work type and depth, selects relevant dimensions from a per-type playbook, captures acceptance criteria, and produces a session plan that /eforge:build enqueues.
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
2. If one found, read it and present a summary of where things stand: topic, planning type, depth, what dimensions have content, key decisions so far, any open questions
3. If multiple found, list them and ask which to resume
4. If none found, tell the user and offer to start a new session
5. If the session file uses the legacy boolean `dimensions: { ... }` shape, handle it per **Legacy Session Files** below
6. Continue from whatever dimension needs work
   - If `required_dimensions` is empty (e.g., the session was abandoned before classification), restart from Step 3 to classify type/depth and populate the playbook.

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
planning_type: unknown
planning_depth: focused
confidence: low
required_dimensions: []
optional_dimensions: []
skipped_dimensions: []
open_questions: []
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

### Step 3: Classify Work Type and Depth

Before exploring dimensions, classify the planned change to select the right conversation shape.

**Work type** — choose the closest match:

| Type | When |
|------|------|
| **bugfix** | Fixing a defect, crash, or incorrect behavior |
| **feature** | Adding new user-facing or API capability |
| **refactor** | Restructuring existing code without changing behavior |
| **architecture** | Changing module boundaries, interfaces, or system-level data flow |
| **docs** | Documentation-only changes |
| **maintenance** | Dependency upgrades, CI, tooling, config tweaks |
| **unknown** | Cannot confidently classify — falls back to the legacy six-dimension checklist plus acceptance criteria |

**Planning depth** — how thoroughly to explore:

| Depth | When |
|-------|------|
| **quick** | Small, low-risk — problem statement plus acceptance criteria plus one or two type-specific required dimensions |
| **focused** | Typical work — all required dimensions for the type (default) |
| **deep** | High-risk or cross-cutting — all required dimensions plus optional ones |

Tell the user: "This looks like a **{type}** / **{depth}** change — I'll shape the conversation accordingly. Override either if that's off."

Update frontmatter: set `planning_type`, `planning_depth`, and `confidence` (high / medium / low — how certain you are of the classification).

### Step 4: Consult Playbook

Use the work-type playbook to populate `required_dimensions` and `optional_dimensions` in the session frontmatter. For `quick` depth, trim the required list to the problem statement or scope dimension, `acceptance-criteria`, and at most two type-specific required dimensions.

**bugfix** — Required: `problem-statement`, `reproduction-steps`, `root-cause`, `acceptance-criteria`. Optional: `code-impact`, `risks`.

**feature** — Required: `problem-statement`, `scope`, `acceptance-criteria`, `code-impact`, `design-decisions`. Optional: `architecture-impact`, `documentation-impact`, `risks`.

**refactor** — Required: `scope`, `code-impact`, `acceptance-criteria`. Optional: `design-decisions`, `risks`.

**architecture** — Required: `scope`, `architecture-impact`, `design-decisions`, `acceptance-criteria`. Optional: `code-impact`, `documentation-impact`, `risks`.

**docs** — Required: `scope`, `documentation-impact`, `acceptance-criteria`. Optional: `code-impact`.

**maintenance** — Required: `scope`, `code-impact`, `acceptance-criteria`. Optional: `risks`.

**unknown** — Required: `scope`, `code-impact`, `architecture-impact`, `design-decisions`, `documentation-impact`, `risks`, `acceptance-criteria`. Optional: (none). This is the legacy six-dimension checklist plus acceptance criteria; use it when classification is not confident enough to narrow down.

Write the dimension lists to frontmatter and tell the user which dimensions will be explored.

### Step 5: Explore Dimensions

Work through `required_dimensions` in order, then any `optional_dimensions` for `deep` depth sessions. For each dimension:

1. Ask the relevant questions (see dimension guide below)
2. Write a `## {Dimension Title}` section to the session file
3. Coverage is recorded by the body section itself — if the dimension has a `## {Dimension Title}` section with content (at least one non-empty, non-placeholder line — not just the header, blank lines, or "TBD"/"N/A"), it counts as covered. If the user explicitly skips it, add an entry to `skipped_dimensions` with `name` and `reason` instead:

```yaml
skipped_dimensions:
  - name: documentation-impact
    reason: no user-facing docs affected
```

If the user says a dimension is not applicable, record it in `skipped_dimensions` with their stated reason — it will not block readiness.

**Dimension guide:**

**problem-statement** — What is the symptom or gap? Who is affected? Why does it matter now?

**scope** — What is explicitly changing? What is explicitly NOT changing? Natural boundaries (e.g., "backend only", "just the CLI")? Relation to roadmap items?

**reproduction-steps** — Exact steps to reproduce the bug. Expected vs actual behavior. Any known workarounds?

**root-cause** — What in the code causes this? Has the cause been confirmed? Any related latent issues?

**code-impact** — What files, modules, and packages need changes? What patterns exist to follow? Shared utilities to reuse? Dependency relationships? Existing test coverage?

**architecture-impact** — New module boundaries? Changed contracts (APIs, interfaces, data formats)? Changed data flow or control flow at a system level? Public API surface changes? Deployment or operational changes? If none apply, note: "No architecture impact — this operates within existing boundaries."

**design-decisions** — Data structures and representations, API shape, error handling strategy, naming conventions, algorithm or approach choices, trade-offs and rationale. Capture the choice AND the reason for each decision.

**documentation-impact** — Which specific files and sections go stale? Name them — not just "docs might need updating."

**risks** — Tricky parts, edge cases, backward compatibility concerns, partial-application behavior (important for eforge's multi-plan orchestration), performance implications.

**acceptance-criteria** — Specific, testable conditions that confirm the change is complete. This is a required dimension for every work type, including the `unknown` fallback.

### Step 6: Profile Signal

Based on everything explored, recommend an eforge profile:

| Profile | When |
|---------|------|
| **Errand** | Trivial, mechanical — typo, config tweak, single obvious fix |
| **Excursion** | Most feature work, multi-file refactors, bug fixes spanning multiple files |
| **Expedition** | 4+ independent subsystems, cross-cutting architectural changes |

Write the recommendation and rationale to `## Profile Signal` in the session file. Update `profile` in frontmatter.

### Step 7: Readiness

A plan is ready when every entry in `required_dimensions` either has body content in the session file or appears in `skipped_dimensions` with a reason. Body content means at least one non-empty, non-placeholder line under the section header — not just the header, blank lines, or "TBD"/"N/A". Optional dimensions never block readiness.

When the plan is ready:

1. Update session file status to `ready` in frontmatter
2. Present a summary:

```
Planning complete for: {topic}

Type: {planning_type} / {planning_depth}

Dimensions covered:
  ✓ {dimension} — {one-line summary}
  ...
  ⊘ {skipped dimension} — {reason}

Profile: {errand|excursion|expedition}

Ready to build. Run /eforge:build to enqueue.
```

If any required dimension was briefly addressed and the change is non-trivial, flag it: "⚠ {dimension} was briefly addressed — worth another look before submitting?"

## Legacy Session Files

If a resumed session file uses the old boolean `dimensions: { scope: false, ... }` shape instead of `required_dimensions` / `optional_dimensions` / `skipped_dimensions`:

- **On resume**: treat the session as `unknown` type with all six legacy dimensions (`scope`, `code-impact`, `architecture-impact`, `design-decisions`, `documentation-impact`, `risks`) plus `acceptance-criteria` as required. Any dimension that is `true` in the old map counts as already covered; any that is `false` is treated as a missing required dimension (preserving current build-skill behavior).
- **On next save**: migrate the frontmatter to the new shape — convert covered dimensions to body-content entries and uncovered ones to entries in `required_dimensions`.

## Session File Updates

Update the session file at these milestones:
- After context gathering (Step 2)
- After classifying type and depth (Step 3)
- After populating dimension lists (Step 4)
- As each dimension is explored (Step 5)
- After profile signal (Step 6)
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
| Init | `eforge_init` | No eforge config found in the project |
| Build | `eforge_build` | User wants to enqueue work for the daemon to build |
| Config | `eforge_config` | User wants to view, edit, or validate the eforge config |
| Status | `eforge_status` | User wants to check build progress or queue state |
| Restart | `eforge_restart` | User wants to restart the eforge daemon |
| Update | `eforge_update` | User wants to check for or install eforge updates |
