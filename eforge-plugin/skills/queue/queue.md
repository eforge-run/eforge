---
description: View and manage the PRD queue - shows pending PRDs with staleness info and suggests next actions
disable-model-invocation: true
---

# /eforge:queue

View the PRD queue and get actionable next steps. This skill reads PRD files from the queue directory, parses their YAML frontmatter, and displays a summary of pending work with staleness information.

## Workflow

### Step 1: Locate Queue Directory

Check for a configured queue directory in `eforge.yaml` under `prdQueue.dir`. Default is `docs/prd-queue/`.

Use the Glob tool to find PRD files:
```
docs/prd-queue/*.md
```

If no files found, report:
> No PRDs in the queue. Use `/eforge:plan` to create a new PRD.

### Step 2: Parse PRD Files

For each `.md` file found, use the Read tool to read its contents. Parse the YAML frontmatter to extract:
- `title` (required)
- `created` (date string)
- `priority` (integer, lower = higher priority)
- `status` (pending, running, completed, failed, skipped)
- `depends_on` (array of PRD ids)

### Step 3: Display Queue Status

Show a summary table of PRDs grouped by status:

**Pending PRDs** (ready to build):

| Priority | Title | Created | Stale Days | Depends On |
|----------|-------|---------|------------|------------|

For each pending PRD, calculate staleness as days since the `created` date. Color-code:
- < 7 days: fresh
- 7-14 days: getting stale
- > 14 days: stale - may need revision

Also show completed/failed/skipped PRDs in a dimmed section if any exist.

### Step 4: Suggest Next Actions

Based on the queue state, suggest:

- If there are pending PRDs with no dependencies:
  > Ready to build. Run `eforge queue run <name>` to build the next PRD, or `eforge queue run --all` to process the entire queue.

- If all PRDs have unmet dependencies:
  > All pending PRDs have unmet dependencies. Check the dependency chain.

- If the queue is empty:
  > Queue is empty. Use `/eforge:plan` to create a new PRD.

## Error Handling

| Condition | Action |
|-----------|--------|
| Queue directory doesn't exist | Report empty queue, suggest `/eforge:plan` |
| PRD file has no frontmatter | Skip it, mention it in output |
| PRD file has invalid frontmatter | Skip it, warn about the specific file |
