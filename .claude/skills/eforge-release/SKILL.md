---
description: Release a new patch version of eforge - commits staged changes, bumps version, pushes with tags
argument-hint: ""
disable-model-invocation: true
---

# /eforge-release

Release a new patch version of eforge. Checks git status, optionally commits, bumps the version, and pushes. A GitHub Action handles npm publish.

## Workflow

### Step 1: Check Git Status

Run `git status --porcelain` to determine the repo state.

Three possible outcomes:

1. **Clean** (no output) - proceed to Step 3
2. **All changes staged** (all lines start with `M `, `A `, `D `, `R ` - no `?? ` or ` M` or ` D` lines) - proceed to Step 2
3. **Unstaged or untracked changes exist** (any `??`, ` M`, ` D`, or `MM` lines) - **STOP**. Tell the user there are unstaged/untracked changes and they need to stage or stash them first. List the problematic files.

### Step 2: Commit Staged Changes

Use the `/git:commit-message-policy` skill to create a commit for the staged changes. Follow the standard commit workflow:

1. Run `git diff --cached` to see what's staged
2. Run `git log --oneline -5` for recent commit style
3. Draft a commit message following Conventional Commits format
4. Create the commit

### Step 3: Bump Version and Push

Run these commands sequentially:

```bash
pnpm version patch
git push origin --follow-tags
```

### Step 4: Summary

Report:
- The new version number (from `pnpm version patch` output)
- That the push succeeded
- Remind the user that npm publish is handled by the GitHub Action
