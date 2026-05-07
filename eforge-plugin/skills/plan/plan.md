---
description: Start or resume a structured planning conversation for changes to be built by eforge. Classifies work type and depth, selects relevant dimensions from a per-type playbook, captures acceptance criteria, and produces a session plan that /eforge:build enqueues.
argument-hint: "[topic] [--resume]"
---

# /eforge:plan — Planning Conversation

Start or resume a structured planning conversation. The output is a session plan file in `.eforge/session-plans/` that accumulates decisions and context as the conversation progresses. When planning is complete, `/eforge:build` picks up the session plan and enqueues it.

## Assumption Discipline

Planning must distinguish **facts**, **evidence-backed conclusions**, and **assumptions**. Incorrect assumptions create expensive downstream rework, so handle them explicitly:

- Validate assumptions with cheap/static checks whenever possible before recording them: read files, grep for usages, inspect tests/docs/config, or run fast commands when appropriate.
- Do not present an inference as fact. If something is inferred from naming, conventions, stale docs, or partial evidence, label it as an assumption.
- When validation is expensive, runtime-dependent, requires external services, requires user observation, or would materially slow planning, disclose that instead of guessing. Record the assumption with confidence, validation cost, validation path(s), and impact if wrong.
- Low-confidence + high-impact assumptions should be resolved or explicitly accepted by the user before the plan is marked ready.

## Arguments

- `topic` (optional) — What to plan. If omitted, ask the user.
- `--resume` — Resume the most recent active session instead of starting a new one.

## Workflow

### Step 1: Session Setup

**Resume path** — If `--resume` is passed or the user says "resume" / "continue planning":
1. Call `mcp__eforge__eforge_session_plan { action: 'list-active' }` to discover active sessions.
2. If one found, call `{ action: 'show', session }` and present a summary of where things stand: topic, planning type, depth, what dimensions have content, key decisions so far, any open questions.
3. If multiple found, list them and ask which to resume; then call `{ action: 'show', session }` for the chosen one.
4. If none found, tell the user and offer to start a new session.
5. If the session has the legacy boolean `dimensions` shape (detected when `plan.required_dimensions` is empty in the `show` response and the plan body references old-format frontmatter), call `{ action: 'migrate-legacy', session }` to convert it, then call `{ action: 'show', session }` again to reload.
6. Continue from whatever dimension needs work
   - If `required_dimensions` is empty (e.g., the session was abandoned before classification), restart from Step 3 to classify type/depth and populate the playbook.

**New session path**:
1. If no topic provided, ask: "What change are you planning?"
2. Generate a session ID: `{YYYY-MM-DD}-{slug}` where slug is a short kebab-case derived from the topic (e.g., `2026-04-03-add-dark-mode`)
3. Call `mcp__eforge__eforge_session_plan { action: 'create', session: '{session-id}', topic: '{topic}' }` to create the session file.
4. Proceed to Step 2

### Step 2: Gather Context

Read project context relevant to the topic:

1. **CLAUDE.md / AGENTS.md** — Project overview, architecture, conventions
2. **Roadmap** (`docs/roadmap.md`) — Check alignment with planned direction
3. **Codebase exploration** — Search for code related to the topic: grep for key terms, read relevant files, understand current patterns
4. **Existing docs** — Identify documentation that might be affected (README, architecture docs, config docs, API docs)
5. **Assumption inventory** — While exploring, track statements that are not yet proven. Validate cheap assumptions immediately where possible; leave expensive/runtime-dependent ones for the `assumptions-and-validation` dimension with confidence and validation paths.

Write a `## Context` section to the session file summarizing what you found, including evidence sources and any early assumptions or unknowns. Present the summary to the user so the conversation starts from shared understanding.

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
| **unknown** | Cannot confidently classify — falls back to the legacy six-dimension checklist plus acceptance criteria and assumption validation |

**Planning depth** — how thoroughly to explore:

| Depth | When |
|-------|------|
| **quick** | Small, low-risk — problem statement plus acceptance criteria plus one or two type-specific required dimensions |
| **focused** | Typical work — all required dimensions for the type (default) |
| **deep** | High-risk or cross-cutting — all required dimensions plus optional ones |

Tell the user: "This looks like a **{type}** / **{depth}** change — I'll shape the conversation accordingly. Override either if that's off."

Note the classification confidence (high / medium / low — how certain you are of the classification) for context when calling the tool in Step 4.

### Step 4: Consult Playbook

Use the work-type playbook to populate `required_dimensions` and `optional_dimensions` in the session frontmatter. For `quick` depth, trim the required list to the problem statement or scope dimension, `acceptance-criteria`, `assumptions-and-validation`, and at most one type-specific required dimension.

**bugfix** — Required: `problem-statement`, `reproduction-steps`, `root-cause`, `acceptance-criteria`, `assumptions-and-validation`. Optional: `code-impact`, `risks`.

**feature** — Required: `problem-statement`, `scope`, `acceptance-criteria`, `code-impact`, `design-decisions`, `assumptions-and-validation`. Optional: `architecture-impact`, `documentation-impact`, `risks`.

**refactor** — Required: `scope`, `code-impact`, `acceptance-criteria`, `assumptions-and-validation`. Optional: `design-decisions`, `risks`.

**architecture** — Required: `scope`, `architecture-impact`, `design-decisions`, `acceptance-criteria`, `assumptions-and-validation`. Optional: `code-impact`, `documentation-impact`, `risks`.

**docs** — Required: `scope`, `documentation-impact`, `acceptance-criteria`, `assumptions-and-validation`. Optional: `code-impact`.

**maintenance** — Required: `scope`, `code-impact`, `acceptance-criteria`, `assumptions-and-validation`. Optional: `risks`.

**unknown** — Required: `scope`, `code-impact`, `architecture-impact`, `design-decisions`, `documentation-impact`, `risks`, `acceptance-criteria`, `assumptions-and-validation`. Optional: (none). This is the legacy six-dimension checklist plus acceptance criteria plus assumption validation; use it when classification is not confident enough to narrow down.

Call `mcp__eforge__eforge_session_plan { action: 'select-dimensions', session, planning_type, planning_depth }` to record the type, depth, and populate the dimension lists. Tell the user which dimensions will be explored.

### Step 5: Explore Dimensions

Work through `required_dimensions` in order, then any `optional_dimensions` for `deep` depth sessions. For each dimension:

1. Ask the relevant questions (see dimension guide below)
2. Validate cheap assumptions before recording the dimension. Prefer file reads, search, docs inspection, existing tests, and fast local commands over speculation.
3. When writing dimension content, separate evidence from assumptions. If a dimension depends on an unvalidated assumption, include the assumption, confidence, validation cost, validation path, and impact if wrong; also carry it into `assumptions-and-validation`.
4. Call `mcp__eforge__eforge_session_plan { action: 'set-section', session, dimension: '{dimension-name}', content: '{content}' }` to record the dimension content.
5. If the user explicitly skips a dimension, call `{ action: 'skip-dimension', session, dimension: '{dimension-name}', reason: '{reason}' }` instead. The tool records the skip — it will not block readiness.

**Dimension guide:**

**problem-statement** — What is the symptom or gap? Who is affected? Why does it matter now?

**scope** — What is explicitly changing? What is explicitly NOT changing? Natural boundaries (e.g., "backend only", "just the CLI")? Relation to roadmap items?

**reproduction-steps** — Exact steps to reproduce the bug. Expected vs actual behavior. Any known workarounds?

**root-cause** — What in the code causes this? Has the cause been confirmed by code inspection, tests, reproduction, or logs? If suspected but not confirmed, label it as a hypothesis and record it in `assumptions-and-validation`. Any related latent issues?

**code-impact** — What files, modules, and packages need changes? What evidence supports that list (search results, imports, tests, package boundaries)? What patterns exist to follow? Shared utilities to reuse? Dependency relationships? Existing test coverage? If impact is inferred rather than verified, record the assumption and validation path.

**architecture-impact** — New module boundaries? Changed contracts (APIs, interfaces, data formats)? Changed data flow or control flow at a system level? Public API surface changes? Deployment or operational changes? If none apply, note: "No architecture impact — this operates within existing boundaries."

**design-decisions** — Data structures and representations, API shape, error handling strategy, naming conventions, algorithm or approach choices, trade-offs and rationale. Capture the choice AND the reason for each decision. Also capture assumptions behind the decision (e.g., compatibility expectations, caller behavior, data shape, runtime constraints) and whether they have been validated.

**documentation-impact** — Which specific files and sections go stale? Name them — not just "docs might need updating."

**risks** — Tricky parts, edge cases, backward compatibility concerns, partial-application behavior (important for eforge's multi-plan orchestration), performance implications, and assumption risk: what breaks or becomes expensive if a key assumption is wrong.

**assumptions-and-validation** — Required for every work type. List material assumptions, evidence or validation already performed, confidence (`high` / `medium` / `low`), cost to validate further (`low` / `medium` / `high`), validation path(s), and impact if wrong. If there are no material assumptions, say so and cite why (e.g., all requirements are user-stated and code impact was verified by search). Use this shape when useful:

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| ... | ... | high/medium/low | low/medium/high | ... | ... |

**acceptance-criteria** — Specific, testable conditions that confirm the change is complete. Include validation criteria for important assumptions when practical. This is a required dimension for every work type, including the `unknown` fallback.

### Step 6: Profile Signal

Based on everything explored, recommend an eforge profile. Profile selection is about **planning complexity**, not just number of files or breadth of code touched.

| Profile | When |
|---------|------|
| **Errand** | Trivial, mechanical — typo, config tweak, single obvious fix where plan review would add little value |
| **Excursion** | Default for most feature work, multi-file refactors, and bug fixes. Use when one planner session can enumerate all plans, file changes, and cross-plan dependencies with quality |
| **Expedition** | Use only when the work requires delegated module planning: a single planner session cannot fully plan all modules/subsystems with quality, and the build needs architecture planning plus subplan cohesion review |

When deciding between **Excursion** and **Expedition**, ask: "Can a single cohesive plan cover the work without deferring detailed planning to module planners?" If yes, choose **Excursion**. Choose **Expedition** only when multiple independently planned subplans are genuinely needed.

Do **not** choose Expedition merely because a change is cross-cutting, touches many files, or has a shared foundation layer. Type/interface refactors, sequential dependency chains, and broad-but-cohesive engine changes are usually Excursion.

Write the recommendation and rationale to `## Profile Signal` in the session file. Update `profile` in frontmatter.

### Step 7: Readiness

Before marking a plan ready, review `assumptions-and-validation`:

- Confirm every material assumption from Context, root cause, scope, code impact, architecture impact, design decisions, documentation impact, risks, and acceptance criteria appears in the ledger.
- Confirm cheap validations have actually been performed rather than deferred.
- Do not mark ready if a low-confidence/high-impact assumption lacks a validation path or explicit user acceptance.
- If all assumptions are validated or low impact, say that explicitly.

When all required dimensions appear complete and the assumption review passes, call `mcp__eforge__eforge_session_plan { action: 'readiness', session }` to verify. The tool checks all required dimensions and returns a readiness report with `ready`, `missingDimensions`, `coveredDimensions`, and `skippedDimensions`. Optional dimensions never block readiness.

When `readiness.ready` is true:

1. Call `mcp__eforge__eforge_session_plan { action: 'set-status', session, status: 'ready' }` to mark the session complete.
2. Present a summary:

```
Planning complete for: {topic}

Type: {planning_type} / {planning_depth}

Dimensions covered:
  ✓ {dimension} — {one-line summary}
  ...
  ⊘ {skipped dimension} — {reason}

Profile: {errand|excursion|expedition}

Assumptions: {validated | disclosed with confidence/cost/path | user-accepted} — {one-line summary}

Ready to build. Run /eforge:build to enqueue.
```

If any required dimension was briefly addressed and the change is non-trivial, flag it: "⚠ {dimension} was briefly addressed — worth another look before submitting?"

If the assumptions ledger is thin, stale, or contains unresolved low-confidence/high-impact assumptions, flag it even when the readiness tool says ready: "⚠ Assumptions need review before submitting — {reason}."

## Legacy Session Files

If a resumed session file uses the old boolean `dimensions: { scope: false, ... }` shape instead of `required_dimensions` / `optional_dimensions` / `skipped_dimensions`:

- **On resume**: call `mcp__eforge__eforge_session_plan { action: 'migrate-legacy', session }` — the tool converts covered dimensions to body entries, uncovered ones to `required_dimensions` entries, adds `assumptions-and-validation` as a required dimension, and rewrites frontmatter to the new shape. Then reload via `{ action: 'show', session }` to continue with the migrated data.

## Session File Updates

Update the session file using `eforge_session_plan` tool calls at these milestones:
- After populating dimension lists (Step 4): `{ action: 'select-dimensions', ... }`
- As each dimension is explored (Step 5): `{ action: 'set-section', ... }` or `{ action: 'skip-dimension', ... }`
- When status changes (planning → ready, Step 7): `{ action: 'set-status', ... }`

For free-form sections — Context (Step 2) and Profile Signal (Step 6) — use the Edit tool for incremental writes to the session file. Do not rewrite the entire file.

## Conversation Style

This skill supports long, iterative conversations. Key behaviors:

- **Be thorough but not rigid** — follow the user's energy. If they want to go deep on architecture, go deep. If they want to move fast, move fast.
- **Push back when things are vague** — if the user says "it should handle errors properly", ask what specific error conditions matter and what the recovery behavior should be.
- **Bring codebase evidence** — don't discuss in the abstract. Read the actual code, show the actual patterns, reference the actual files.
- **Do not launder assumptions into facts** — if something has not been validated, keep it visibly labeled as an assumption with confidence and validation cost.
- **Prefer cheap validation over caveats** — if a search, file read, or fast local command can resolve uncertainty, do it before asking the user to accept the assumption.
- **Track what's been decided** — when a decision is made, write it down in the session file immediately. Don't let decisions drift.
- **Surface tensions** — if a design decision conflicts with an existing pattern, or a scope boundary seems artificial, say so.

## Error Handling

| Condition | Action |
|-----------|--------|
| `.eforge/session-plans/` doesn't exist | The `eforge_session_plan` tool creates it automatically on first use |
| CLAUDE.md not found | Proceed without it, note limited context |
| No roadmap found | Skip roadmap alignment check |
| Session file gets corrupted | Offer to start a new session |
| User wants to abandon a session | Set status to `abandoned` in frontmatter |
| User wants to restart from scratch | Create a new session, leave old one as-is |

## Saving a Plan as a Playbook

If the user asks to save the in-progress plan as a reusable playbook (e.g. "save this as a playbook", "turn this into a playbook", "I want to reuse this"), hand off to `/eforge:playbook` (Create branch) with the current session plan as the draft starting point. The playbook skill handles scope classification (project-local vs. project-team vs. user) and persists the playbook via the daemon.

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Init | `/eforge:init` | No eforge config found in the project |
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Playbook | `/eforge:playbook` | User wants to save this plan as a reusable playbook, or manage existing playbooks |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Restart | `/eforge:restart` | User wants to restart the eforge daemon |
| Update | `/eforge:update` | User wants to check for or install eforge updates |
