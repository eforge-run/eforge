---
name: eforge-recover
description: Inspect the recovery verdict for a failed PRD and apply the recommended action (retry, split, or abandon)
disable-model-invocation: true
---

# /eforge:recover

Inspect the recovery analysis for a failed PRD and act on the verdict — re-queue, split into a successor PRD, or archive the original.

## Workflow

Call `eforge_status` to discover failed PRDs, read the recovery sidecar to surface the verdict and rationale, confirm the action with the user, and call `eforge_apply_recovery` to execute. Never auto-apply — always confirm.

## Steps

### Step 1: Identify the Failed PRD

If the user supplied `<setName> <prdId>` arguments, use them directly and skip to Step 2.

Otherwise, call `eforge_status` (no parameters) and look for PRDs with status `failed` in the response. Present the list to the user and ask which one to recover. If no failed PRDs are found, tell the user:

> No failed PRDs found. Use `/eforge:status` to check the current build state.

**Stop here** if no failed PRDs exist.

### Step 2: Read the Recovery Sidecar

Call `eforge_read_recovery_sidecar` with `{ setName, prdId }`.

- If the tool returns a 404 or the response contains a `recoveryError` field, offer to run the recovery analysis:

> No recovery analysis found for `{prdId}`. Would you like me to run the analysis now? (yes / no)

  If the user agrees, call `eforge_recover` with `{ setName, prdId }`, then loop back to Step 2.

  If the user declines, stop here.

- If the sidecar is present, continue to Step 3.

### Step 3: Render the Verdict

Display the recovery report to the user:

**PRD**: `{prdId}`
**Verdict**: `{verdict}` (`retry` / `split` / `abandon` / `manual`)
**Confidence**: `{confidence}` (`low` / `medium` / `high`)

**Rationale**
{rationale}

**Completed work**
{completedWork — bullet list}

**Remaining work**
{remainingWork — bullet list}

**Risks**
{risks — bullet list}

If the verdict is `split`, also show:

**Suggested successor PRD**
```
{suggestedSuccessorPrd}
```

### Step 4: Confirm the Action

Ask the user to confirm the verdict-specific action:

- `retry`: "Re-queue PRD `{prdId}` for another attempt? (yes / no)"
- `split`: "Enqueue a successor PRD based on the suggested content above? (yes / no)"
- `abandon`: "Archive the failed PRD `{prdId}` (this cannot be undone)? (yes / no)"
- `manual`: Render the full markdown report and stop. Tell the user:

> This verdict requires manual intervention. Review the report above and take action outside of eforge. No automated action is available for the `manual` verdict.

**Stop here** for `manual`. Do not call `eforge_apply_recovery`.

### Step 5: Apply the Recovery

On confirmation, call `eforge_apply_recovery` with `{ setName, prdId }`.

Report the result:

- **retry**: "PRD `{prdId}` has been re-queued. The daemon will pick it up on the next polling cycle."
- **split**: "Successor PRD enqueued. The daemon will begin the next build shortly."
- **abandon**: "PRD `{prdId}` has been archived. The failed PRD and its sidecar have been removed from the queue."

## Error Handling

| Condition | Action |
|-----------|--------|
| `eforge_read_recovery_sidecar` returns 404 | Offer to call `eforge_recover` to generate the verdict (Step 2) |
| Sidecar contains `recoveryError` | Offer to re-run `eforge_recover` to regenerate (Step 2) |
| `eforge_apply_recovery` fails | Surface the daemon error message verbatim; do not retry automatically |
<!-- parity-skip-start -->
| Tool unavailable | Warn that eforge tools are not available; suggest checking the extension is loaded |
<!-- parity-skip-end -->

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Status | `eforge_status` | Check which PRDs are failed before recovering |
| Build | `eforge_build` | Enqueue new work after a successful recovery |
| Plan | `eforge_plan` | Plan a replacement PRD before re-queuing |
