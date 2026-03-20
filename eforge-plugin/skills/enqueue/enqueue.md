---
description: Normalize any input and add it to the eforge queue
argument-hint: "<source>"
disable-model-invocation: true
---

# /eforge:enqueue

Normalize a source document (PRD file, inline prompt, or rough notes) and add it to the eforge queue. This skill runs the eforge CLI's `enqueue` command, which uses a formatter agent to produce a well-structured PRD with frontmatter.

## Arguments

- `source` — file path to a PRD, plan, or markdown document; or an inline description of what to build

## Workflow

### Step 1: Validate Source

Check that `$ARGUMENTS` is provided:

- **File path**: Verify the file exists with the Read tool. Show a brief summary of what it describes.
- **Inline description**: Note that eforge will use this directly as the source prompt.
- **Nothing provided**: Check the current conversation for a plan file or PRD that could be enqueued. If none found, ask the user what they want to enqueue.

**Stop here** if no source is identified.

### Step 2: Enqueue

Resolve the eforge CLI command, preferring a local install over npx:

```bash
if command -v eforge >/dev/null 2>&1; then
  EFORGE_CMD="eforge"
else
  EFORGE_CMD="npx --yes eforge"
fi
```

Run the eforge enqueue command:

```bash
$EFORGE_CMD enqueue $SOURCE
```

This will:
1. Read the source content
2. Run the formatter agent to normalize it into a well-structured PRD
3. Write the formatted PRD with YAML frontmatter to the queue directory (`docs/prd-queue/` by default)

### Step 3: Report Result

After successful enqueue, tell the user:

> Enqueued: **{title}** -> `{filePath}`
>
> Next steps:
> - `/eforge:run --queue` to process the queue
> - `/eforge:run {filePath}` to build this PRD directly
> - `/eforge:status` to check build progress

## Error Handling

| Error | Action |
|-------|--------|
| Source file not found | Check path, suggest alternatives |
| No arguments provided | Check conversation for relevant files; if none, ask the user |
| Enqueue fails | Show error output, suggest checking the source format |
| Version mismatch (e.g. "unknown option", "unknown command", or other CLI errors suggesting the installed eforge version doesn't match the plugin) | Tell the user the CLI and plugin versions may be out of sync. Suggest `npm update -g eforge` or clearing the npx cache (`npx --yes eforge@latest --version` to force refresh). Suggest `/plugin update eforge@eforge` to update the plugin. If both are already at the latest version, suggest reporting as a bug. |
