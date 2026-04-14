---
name: eforge-release
description: Release a new version of eforge with release notes, changelog, and GitHub Release - supports patch, minor, and major release types
argument-hint: "[--patch|--minor|--major]"
disable-model-invocation: true
---

# /eforge-release

Release a new version of eforge. Parses the release type from arguments, checks git status, optionally commits staged changes, generates release notes from the git log, updates CHANGELOG.md, bumps the version, pushes with tags, and creates a GitHub Release.

## Workflow

### Step 1: Parse Release Type

Read `$ARGUMENTS` to determine the release type:

- `--patch` or empty/unrecognized - **patch** (default)
- `--minor` - **minor**
- `--major` - **major**

Store the resolved bump type (one of `patch`, `minor`, `major`) for use in later steps.

### Step 2: Check Git Status

Run `git status --porcelain` to determine the repo state.

Three possible outcomes:

1. **Clean** (no output) - proceed to Step 4
2. **All changes staged** (all lines start with `M `, `A `, `D `, `R ` - no `?? ` or ` M` or ` D` lines) - proceed to Step 3
3. **Unstaged or untracked changes exist** (any `??`, ` M`, ` D`, or `MM` lines) - **STOP**. Tell the user there are unstaged/untracked changes and they need to stage or stash them first. List the problematic files.

### Step 3: Commit Staged Changes

Use the `/git:commit-message-policy` skill to create a commit for the staged changes. Follow the standard commit workflow:

1. Run `git diff --cached` to see what's staged
2. Run `git log --oneline -5` for recent commit style
3. Draft a commit message following Conventional Commits format
4. Create the commit

### Step 4: Generate Release Notes

Generate release notes from the git log between the previous tag and HEAD.

**Find the previous tag:**

```bash
git describe --tags --abbrev=0
```

If no tags exist, fall back to the root commit:

```bash
git rev-list --max-parents=0 HEAD
```

**Collect commits:**

```bash
git log <PREV_TAG>..HEAD --oneline
```

**Filter noise** - remove any lines matching these patterns:
- Version bump messages: lines matching `^\w+ \d+\.\d+\.\d+$` (e.g., `0.2.5`)
- Contains `enqueue(` (eforge queue entries)
- Contains `cleanup(` (eforge cleanup commits)
- Contains `plan(` (eforge planning artifacts)
- Contains `Merge ` (merge commits)
- Contains `bump plugin version`

**Clean up commit messages:**
- Strip the leading commit hash
- Strip `plan-NN-` prefixes from conventional commit scopes (e.g., `feat(plan-01-foo): bar` becomes `feat(foo): bar`)
- Extract the description after the `: ` separator

**Deduplicate** by description text - keep only the first occurrence of each description.

**Group by conventional commit type** into markdown sections:
- `feat` - `### Features`
- `fix` - `### Bug Fixes`
- `refactor` - `### Refactoring`
- `perf` - `### Performance`
- `docs` - `### Documentation`
- `chore`, `ci`, `build`, `test` - `### Maintenance`
- Anything else - `### Other`

Omit empty sections. If no meaningful commits remain after filtering, use "Maintenance release" as the release notes.

Store the generated markdown for use in Steps 5 and 7.

### Step 5: Update CHANGELOG.md

**Compute the new version** before bumping by reading the source-of-truth version from `packages/eforge/package.json` and incrementing the appropriate component:

```bash
node -e "
const v = require('./packages/eforge/package.json').version.split('.');
const bump = '$BUMP_TYPE';
if (bump === 'major') { v[0]++; v[1]=0; v[2]=0; }
else if (bump === 'minor') { v[1]++; v[2]=0; }
else { v[2]++; }
console.log(v.join('.'));
"
```

(Where `$BUMP_TYPE` is the resolved bump type from Step 1.)

Note: the root `package.json` has no `version` field - this is a pnpm workspace and `packages/eforge/package.json` is the lockstep source of truth.

**Create or update CHANGELOG.md:**

1. If `CHANGELOG.md` does not exist, create it with a `# Changelog` heading
2. Prepend a new entry immediately after the `# Changelog` heading line:

```markdown
## [X.Y.Z] - YYYY-MM-DD

<release notes from Step 4>
```

3. Trim to a maximum of 20 `## [` sections. If entries are removed, ensure this footer exists at the bottom of the file:

```markdown
---
For older releases, see [GitHub Releases](https://github.com/eforge-build/eforge/releases).
```

**Commit the changelog:**

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG.md for vX.Y.Z"
```

### Step 6: Bump Version and Push

Run these commands sequentially:

```bash
pnpm release <bump-type>
git push origin HEAD --follow-tags
```

(Where `<bump-type>` is the resolved bump type from Step 1.)

`pnpm release` (scripts/bump-version.mjs) bumps `packages/eforge/package.json` (source of truth), propagates the version to the other lockstep packages (`client`, `engine`, `monitor`, `pi-eforge`), commits all five package.jsons with message `X.Y.Z`, and creates an annotated tag `vX.Y.Z`. The push then ships the changelog commit, the version commit, and the tag.

### Step 7: Create GitHub Release and Summary

Create a GitHub Release:

```bash
gh release create v<version> --title "v<version>" --notes "<release-notes>"
```

(Use a heredoc or temp file for the notes if they contain special characters.)

Report:
- The new version number
- The release type (patch, minor, or major)
- Link to the GitHub Release
- Remind the user that npm publish is handled by the GitHub Action
