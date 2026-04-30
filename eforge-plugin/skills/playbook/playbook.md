---
description: Create, edit, run, list, and promote eforge playbooks — reusable recurring-workflow templates
argument-hint: "[create|edit|run|list|promote|demote] [name]"
---

# /eforge:playbook

Manage eforge playbooks — reusable templates for recurring workflows that the daemon can execute on demand. Playbooks live in one of three storage tiers:

- `~/.config/eforge/playbooks/` — **user** scope (cross-project, personal)
- `eforge/playbooks/` — **project-team** scope (committed, shared with the team)
- `.eforge/playbooks/` — **project-local** scope (gitignored, personal draft)

A lower-tier playbook with the same name **shadows** a higher-tier one. The daemon always runs the most-specific tier.

## Step 1: Branch on Arguments

Inspect `$ARGUMENTS`:

- **Empty / whitespace** — show the **no-args menu** (Step 2).
- **`create [description]`** — jump to **Branch: Create** (Step 3).
- **`edit [name]`** — jump to **Branch: Edit** (Step 4).
- **`run [name]`** — jump to **Branch: Run** (Step 5).
- **`list`** — jump to **Branch: List** (Step 6).
- **`promote [name]`** — jump to **Branch: Promote** (Step 7).
- **`demote [name]`** — jump to **Branch: Demote** (Step 8).

## Step 2: No-Args Menu

Call `mcp__eforge__eforge_playbook { action: "list" }` to fetch the current playbook inventory. Use the result to determine which branches to show:

**Always shown:**
- **1. Create** — draft and save a new playbook
- **4. List** — read-only formatted listing

**Shown only when playbooks exist:**
- **2. Edit** — walk through a playbook section-by-section
- **3. Run** — enqueue a playbook for building

**Shown only when project-local playbooks exist (`.eforge/playbooks/`):**
- **5. Promote** — move a `.eforge/playbooks/<name>.md` to `eforge/playbooks/<name>.md`

**Shown only when project-team playbooks exist (`eforge/playbooks/`):**
- **6. Demote** — move a `eforge/playbooks/<name>.md` back to `.eforge/playbooks/<name>.md`

Present the available branches as a numbered list and ask the user to pick. Then jump to the corresponding branch.

---

## Branch: Create (Step 3)

Gather the recurring workflow the user wants to capture as a playbook, classify its scope automatically, draft the playbook, validate it, and save.

### 3.1: Gather the workflow description

If `$ARGUMENTS` contains a description after `create`, use it as the starting point. Otherwise ask:

> "What recurring workflow do you want to capture as a playbook? Describe what it does and when you'd run it."

If the user is entering Create from a mid-conversation `/eforge:plan` and has an in-progress session plan, offer to use that plan as the draft starting point:

> "I see you have an active planning session for `{topic}`. Would you like to use that as the playbook draft?"

If yes, pre-fill the goal, out-of-scope, acceptance criteria, and planner notes from the session plan content.

### 3.2: Intelligent scope classification

Apply the following decision flow **without asking the user** unless the signals are mixed (see step 3.2.5). The target is ≥80% no-prompt rate for first-author cases.

**Step 3.2.1: Project-bound vs cross-project**

Evidence of **project-bound**:
- Explicit file paths or directory names specific to this repo
- Package names, script names, or tooling that only exist in this project
- Domain language or identifiers unique to this codebase
- References to project-specific CI/CD targets, environment configs, or services

Evidence of **cross-project**:
- Generic vocabulary that applies to any project (e.g. "update dependencies", "run lint", "generate changelogs")
- Convention-based references without project-specific names
- No project-specific identifiers anywhere in the description

**Step 3.2.2: Shared vs personal** (only if project-bound)

Evidence of **shared** (team default):
- Neutral phrasing ("the project", "the repo", "we")
- References to team conventions or shared CI workflows
- Nothing that suggests personal ownership

Evidence of **personal** (project-local):
- First-person ownership language ("my workflow", "I want", "for me")
- Explicit "don't share" / "private" / "draft" / "experimental" signals
- References to sensitive personal tokens, credentials, or local-only paths

**Step 3.2.3: Decision matrix**

| Project signal | Personal signal | Target scope |
|---|---|---|
| Cross-project | — | `user` (`~/.config/eforge/playbooks/`) |
| Project-bound | Neutral / absent | `project-team` (`eforge/playbooks/`) |
| Project-bound | Personal / private | `project-local` (`.eforge/playbooks/`) |
| Mixed / weak | — | Ask the user (Step 3.2.4) |

**Step 3.2.4: Ask only when signals are mixed**

When the evidence is genuinely ambiguous, present the strongest evidence you found and offer a default:

> "This looks like it could go either way. The description mentions `{evidence}`, which suggests `{scope-A}`, but it's generic enough to work cross-project. I'd default to **`{scope-B}`** — is that right, or would you prefer a different scope?"

Present three choices with plain-English labels and path hints. Never ask "where should I save this?" as an open-ended question.

**Step 3.2.5: Confirm scope with the user** (informative, not interrogative)

When classification is confident, state the inferred scope briefly:

> "I'll save this as a **{scope}** playbook (`{path}`). You can override the scope if you'd like."

### 3.3: Draft the playbook

Compose the playbook content based on the workflow description. Structure:

**Frontmatter (YAML):**
```yaml
---
name: {slug-kebab-case}
description: {one-line description}
scope: {user|project-team|project-local}
---
```

**Body sections:**
- `## Goal` — what the workflow achieves
- `## Out of scope` — what this playbook should NOT do (prevents scope creep in the build)
- `## Acceptance criteria` — specific, testable conditions for a successful run
- `## Notes for the planner` — hints, constraints, or context for the build agent (optional but encouraged)

Present the draft to the user for review. If entries were pre-filled from an `/eforge:plan` session, note which sections came from the session.

### 3.4: Validate and save

1. Call `mcp__eforge__eforge_playbook { action: "validate", raw: "<draft-markdown>" }` before saving.
   - If `ok: false`, surface the errors **verbatim** and ask the user to fix them. Loop back to Step 3.3 with the errors highlighted. Do NOT write the file.
   - If `ok: true`, proceed.

2. Call `mcp__eforge__eforge_playbook { action: "save", scope: "<scope>", playbook: { frontmatter: {...}, body: {...} } }`.

3. Report the path returned by the daemon:
   > "Playbook saved to `{path}`."

4. Offer next steps: run it with `/eforge:playbook run {name}`, or promote it with `/eforge:playbook promote {name}` if it was saved as project-local.

---

## Branch: Edit (Step 4)

Walk through an existing playbook section-by-section and save the updated version.

### 4.1: Pick a playbook

Call `mcp__eforge__eforge_playbook { action: "list" }`. Print a numbered list:

```
  1. docs-sync           [project-team]
  2. dependency-update   [user]
  3. release-prep        [project-local]  ← shadows project-team version
```

- Include `[source]` labels.
- Mark shadowed entries with `← shadows {tier} version`.
- If no playbooks exist, tell the user and offer to Create one.

Ask the user to pick by number. Never ask for a name.

### 4.2: Shadow notice

If the selected playbook is **shadowed by** a more-specific tier (e.g., the user picked a `project-team` entry that has a `project-local` shadow), show:

> "⚠ This playbook is shadowed by a `project-local` version at `.eforge/playbooks/{name}.md`. The daemon always runs the shadow. Would you like to:
> 1. Edit the **shadow** (project-local — what the daemon actually runs)
> 2. Edit the **original** (project-team — shadowed, not active)
> 3. Copy the original to project-local and edit (creates a new shadow)"

If the user picks option 3, call `POST /api/playbook/copy` with `{ name: "<name>", targetScope: "project-local" }` via the daemon client before entering the section-by-section edit loop. This atomically copies the playbook to the project-local tier so the daemon will run the new shadow going forward. Then proceed with the edit loop using the copied version.

### 4.3: Load the playbook

Call `mcp__eforge__eforge_playbook { action: "show", name: "<name>" }` (resolved to the tier the user chose).

### 4.4: Section-by-section walkthrough

Present each section with its current content and ask if the user wants to update it. Work through in order: **Goal** → **Out of scope** → **Acceptance criteria** → **Notes for the planner**.

For each section:
1. Show: `**## {Section}** (current): {current content}`
2. Ask: "Does this look right, or would you like to update it?"
3. If the user provides new content, update the draft. If they say "fine" / "keep it" / "no change", preserve the current content.

### 4.5: Validate and save

Same as Step 3.4. Validate before saving, surface errors verbatim, do NOT write on failure. On success, report the path.

---

## Branch: Run (Step 5)

Enqueue a playbook, with an optional wait for an in-flight build to finish first.

### 5.1: Pick a playbook

Same numbered-list approach as Step 4.1. If a name was provided via `$ARGUMENTS`, pre-select it but still confirm.

### 5.2: Check for in-flight builds

Call `mcp__eforge__eforge_queue_list {}` to get current queue items.

Filter for items where `status` is `"running"` or `"pending"` (queued). Build a numbered list indexed starting at 1.

- **If no active items**: skip to Step 5.3 and enqueue immediately.
- **If active items exist**: list them by **title** with index numbers (never show queue ids):

```
There are active builds in the queue:
  1. [running] Update documentation site
  2. [pending] Add dark mode support

Would you like to:
  a. Run now (enqueue immediately, no dependency)
  b. Wait for build 1 to finish, then run
  c. Wait for build 2 to finish, then run
```

**Resolving selection:**
- Internally map the user's pick (letter b/c or number 1/2) to the corresponding queue item's internal id.
- The user never types or sees the queue id at any point.

**Handling ambiguity:**
- If the user provides a free-text name instead of a number (e.g. "wait for the docs build"), find all items whose title contains the mention.
- If exactly one match: proceed.
- If multiple matches: ask the user to pick by number from the numbered list above.

**Before enqueueing, confirm the mapping:**
> "Got it — `{playbook-name}` will run after **{selected-build-title}** finishes."

Await user confirmation (y/n or just Enter). Only proceed if confirmed.

### 5.3: Enqueue

- **Run now**: Call `mcp__eforge__eforge_playbook { action: "enqueue", name: "<name>" }`.
- **Wait for build**: Call `mcp__eforge__eforge_playbook { action: "enqueue", name: "<name>", afterQueueId: "<resolved-id>" }`.

The `afterQueueId` is the internal queue id resolved in Step 5.2 — never the title and never typed by the user.

Report:
> "Playbook `{name}` enqueued. {If afterQueueId: 'It will start after `{build-title}` completes.'}"

If the enqueue fails because the upstream is no longer active (404 from daemon), tell the user:
> "The build you selected has already finished. Running `{name}` now instead."
Then call `mcp__eforge__eforge_playbook { action: "enqueue", name: "<name>" }` without `afterQueueId`.

---

## Branch: List (Step 6)

Call `mcp__eforge__eforge_playbook { action: "list" }` and render a formatted read-only listing.

For each playbook, show:
- Name
- Description
- Source tier `[user]` / `[project-team]` / `[project-local]`
- Shadow chain (if any): `→ shadowed by project-local: .eforge/playbooks/{name}.md`

Group by scope tier for readability. If no playbooks exist, tell the user and offer to Create one.

---

## Branch: Promote (Step 7)

Move a project-local playbook to project-team so the whole team benefits from it.

### 7.1: Pick a project-local playbook

Call `mcp__eforge__eforge_playbook { action: "list" }` and filter for `source: "project-local"` entries. Present as a numbered list. If none exist, tell the user.

### 7.2: Shadow trade-off notice

Before promoting, note the trade-off:

> "Promoting `{name}` moves it from `.eforge/playbooks/` to `eforge/playbooks/` and commits it with the project. **Note:** once promoted, you will no longer automatically receive team-side improvements to a playbook of the same name — your promoted version will shadow the team default."

Ask: "Proceed with promotion?"

### 7.3: Promote

Call `mcp__eforge__eforge_playbook { action: "promote", name: "<name>" }`.

Report the destination path returned by the daemon.

---

## Branch: Demote (Step 8)

Move a project-team playbook back to project-local (personal shadow, not shared).

### 8.1: Pick a project-team playbook

Call `mcp__eforge__eforge_playbook { action: "list" }` and filter for `source: "project-team"` entries. Present as a numbered list. If none exist, tell the user.

### 8.2: Shadow trade-off notice

> "Demoting `{name}` creates a project-local copy at `.eforge/playbooks/{name}.md` that will shadow the team version. The team version remains in `eforge/playbooks/` but the daemon will run your local copy instead."

Ask: "Proceed with demotion?"

### 8.3: Demote

Call `mcp__eforge__eforge_playbook { action: "demote", name: "<name>" }`.

Report the destination path returned by the daemon.

---

## Power-User Shortcuts

Direct invocations with a name argument jump into the relevant branch with that item pre-selected and still confirm before acting:

- `/eforge:playbook run docs-sync` — Run branch, pre-selects `docs-sync`, still offers wait-for-build if applicable.
- `/eforge:playbook edit dependency-update` — Edit branch, pre-selects `dependency-update`.
- `/eforge:playbook promote release-prep` — Promote branch, pre-selects `release-prep`.
- `/eforge:playbook create` — Create branch, asks for the workflow description.

---

## Validation Rules

Every save path (Create and Edit) must pass `mcp__eforge__eforge_playbook { action: "validate", raw: "<markdown>" }` before the daemon writes anything to disk. On failure:

1. Surface the daemon's error messages **verbatim** — do not paraphrase.
2. Show the user exactly which section or field caused the error.
3. Ask the user to fix the content.
4. Re-validate before trying to save again.
5. Never write to disk while `ok: false`.

---

## Error Handling

| Condition | Action |
|-----------|--------|
| No playbooks exist | Tell the user and offer Create |
| Playbook name not found | Surface daemon error, list available playbooks |
| Validation failure | Show errors verbatim, do not save |
| Queue list fails | Skip wait-for-build offer, enqueue immediately and note the queue check failed |
| Tool connection failure | Daemon auto-starts; if it still fails, suggest `eforge daemon start` |
| No eforge config | Tell the user: "No eforge config found. Run `/eforge:init` to initialize eforge in this project." |

---

## Related Skills

| Skill | When to suggest |
|-------|----------------|
| `/eforge:plan` | User wants to plan a one-off change (not recurring); at plan completion, offer to save as a playbook via `/eforge:playbook create` |
| `/eforge:build` | User wants to enqueue a session plan (not a playbook) |
| `/eforge:status` | User wants to check current build progress |
| `/eforge:config` | User wants to view or edit `eforge/config.yaml` |
