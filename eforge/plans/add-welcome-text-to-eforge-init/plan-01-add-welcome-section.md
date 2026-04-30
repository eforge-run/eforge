---
id: plan-01-add-welcome-section
name: Add Welcome Section to Init Skills
branch: add-welcome-text-to-eforge-init/welcome-section
---

# Add Welcome Section to Init Skills

## Architecture Context

The `/eforge:init` skill is exposed via two consumer-facing surfaces that must stay in sync per the AGENTS.md convention:

- `eforge-plugin/skills/init/init.md` — Claude Code plugin
- `packages/pi-eforge/skills/eforge-init/SKILL.md` — Pi extension

Parity is enforced by `scripts/check-skill-parity.mjs` (run as the first step of `pnpm test`). The parity checker strips YAML frontmatter and content inside `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` markers, then diffs the remainder. Any content placed **outside** those markers must be byte-identical between the two files post-normalization.

The welcome message is harness-agnostic (it describes eforge generally — "agentic build system that turns plans into code"), so it goes **outside** the parity-skip markers in both files. Identical placement and identical copy guarantees the parity check passes.

## Implementation

### Overview

Insert a new `## Welcome` section between the description block (which ends with `<!-- parity-skip-end -->`) and the existing `## Workflow` heading in both files. The section instructs the agent to print a verbatim welcome message to the user before executing Step 1.

### Key Decisions

1. **Welcome lives outside `parity-skip-*` markers.** The copy is identical between platforms, so it must be in the parity-checked region. Putting it inside skip markers would defeat parity enforcement and (per the parity script's documentation) skip blocks are not for mirrored content.
2. **Always-show, no conditional branching.** The PRD explicitly excludes any suppression logic for `--force` or `--migrate`. The instruction to the agent is unconditional: "Before starting Step 1, print this welcome message to the user verbatim."
3. **Verbatim copy from the PRD.** No paraphrasing. The two files must contain the exact same `## Welcome` block (header, instruction sentence, blockquoted message, trailing "Then proceed to Step 1." line).

## Scope

### In Scope

- Insert the `## Welcome` section into `eforge-plugin/skills/init/init.md` between the closing `<!-- parity-skip-end -->` (line 10) and the `## Workflow` heading (line 12).
- Insert the identical `## Welcome` section into `packages/pi-eforge/skills/eforge-init/SKILL.md` between the closing `<!-- parity-skip-end -->` (line 11) and the `## Workflow` heading (line 13).
- Bump the plugin version in `eforge-plugin/.claude-plugin/plugin.json` per the AGENTS.md rule ("Always bump the plugin version when changing anything in the plugin").

### Out of Scope

- Any code changes (engine, CLI, daemon, MCP).
- Any test changes — no behavior is added; existing parity check covers the cross-file consistency requirement.
- Conditional branching (e.g., suppressing on `--force` or `--migrate`).
- Harness-specific wording variations.
- Bumping the `packages/pi-eforge/package.json` version (per AGENTS.md: "Do not bump the Pi package version. It will be versioned with the npm package at publish time.").
- CHANGELOG edits (release flow owns CHANGELOG).

## Files

### Modify

- `eforge-plugin/skills/init/init.md` — Insert the following block on a new line immediately after line 10 (`<!-- parity-skip-end -->`) and before line 12 (`## Workflow`). The result is a blank line, then the welcome block, then a blank line, then `## Workflow`. Exact content to insert:

  ```markdown
  ## Welcome

  Before starting Step 1, print this welcome message to the user verbatim:

  > Welcome to eforge — an agentic build system that turns plans into code. You stay close to the code (planning, decisions) while eforge implements, blind-reviews, and validates in the background.
  >
  > This setup configures your agent runtime profile and post-merge validation commands.

  Then proceed to Step 1.
  ```

- `packages/pi-eforge/skills/eforge-init/SKILL.md` — Insert the **identical** block (byte-for-byte the same as above) immediately after line 11 (`<!-- parity-skip-end -->`) and before line 13 (`## Workflow`). Same surrounding blank-line convention.

- `eforge-plugin/.claude-plugin/plugin.json` — Bump the `version` field by a patch increment (e.g., `0.x.y` -> `0.x.(y+1)`). Read the current value first; do not invent a version. This is required by the AGENTS.md plugin-version rule.

## Verification

- [ ] `eforge-plugin/skills/init/init.md` contains a `## Welcome` heading on a line that previously did not exist; the heading appears after the line containing `<!-- parity-skip-end -->` and before the line containing `## Workflow`.
- [ ] `packages/pi-eforge/skills/eforge-init/SKILL.md` contains a `## Welcome` heading in the same relative position (after `<!-- parity-skip-end -->`, before `## Workflow`).
- [ ] The block of lines from the `## Welcome` heading through the `Then proceed to Step 1.` line is byte-identical between the two files (compare with `diff <(sed -n '/^## Welcome$/,/^Then proceed to Step 1\.$/p' eforge-plugin/skills/init/init.md) <(sed -n '/^## Welcome$/,/^Then proceed to Step 1\.$/p' packages/pi-eforge/skills/eforge-init/SKILL.md)` — output must be empty).
- [ ] The `## Welcome` heading and its body are not enclosed by any `<!-- parity-skip-start -->` / `<!-- parity-skip-end -->` markers in either file (grep for the heading and confirm the nearest preceding marker on each side is `<!-- parity-skip-end -->`, not `<!-- parity-skip-start -->`).
- [ ] `node scripts/check-skill-parity.mjs` exits 0 (the welcome block lives in the parity-checked region and must match between files).
- [ ] `pnpm test` exits 0 (runs the parity check then vitest; vitest suite is unaffected by markdown changes).
- [ ] `pnpm type-check` exits 0 (no source files were modified, but run as a sanity check).
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field is incremented by exactly one patch level relative to its value before this plan ran.
- [ ] `packages/pi-eforge/package.json` `version` field is unchanged from its value before this plan ran.
- [ ] No files outside the three listed under "Modify" were changed (`git diff --name-only` returns exactly those three paths).