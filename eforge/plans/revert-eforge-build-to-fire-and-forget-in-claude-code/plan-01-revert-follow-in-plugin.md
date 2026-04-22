---
id: plan-01-revert-follow-in-plugin
name: Revert Claude Code build skill to fire-and-forget
depends_on: []
branch: revert-eforge-build-to-fire-and-forget-in-claude-code/plugin-revert
---

# Revert Claude Code build skill to fire-and-forget

## Architecture Context

The Claude Code `/eforge:build` skill currently ends with a blocking call to `mcp__eforge__eforge_follow`, which was added by plan-02 of `real-time-build-feedback-for-the-eforge-claude-code-plugin-and-pi-parity`. In Claude Code the call is observationally broken:

- Claude Code does not surface `notifications/progress` events to the user, so the inline streaming is invisible.
- The call blocks the main agent thread for up to 30 minutes, and often terminates with a transport-imposed abort before `session:end` arrives, surfacing as a tool error.

Pi's transport does surface progress notifications and does not impose a hidden tool-call timeout, so `eforge_follow` continues to work there. The MCP tool (`mcp__eforge__eforge_follow`), the SSE subscriber (`packages/client/src/session-stream.ts`), and the monitor SSE endpoint (`packages/monitor/src/server.ts`) remain correct and stay registered - advanced users and Pi can still call the tool directly.

The scope is purely documentation/markdown content in the plugin's build skill, plus a plugin version bump (AGENTS.md requires this whenever plugin content changes). A narrow parity-skip wrap is also required around Pi's existing Step 6 so that `scripts/check-skill-parity.mjs` (invoked by `pnpm test`) keeps passing once the plugin-side Step 6 is removed.

## Implementation

### Overview

1. Delete Step 6 ("Follow the Build") from `eforge-plugin/skills/build/build.md` (currently lines 142-156).
2. Rewrite the Step 5 success message so it directs users at the monitor URL and `/eforge:status` for progress, restoring pre-plan-02 wording.
3. Wrap Pi's existing Step 6 in `packages/pi-eforge/skills/eforge-build/SKILL.md` with `<!-- parity-skip-start -->` / `<!-- parity-skip-end -->` markers. This is the only change to the Pi file; its narrative, tool call, and behavior are unchanged. This is required because `scripts/check-skill-parity.mjs` diffs both files after stripping frontmatter and skip blocks, so divergence must live inside a skip block on the owning side.
4. Bump the plugin version in `eforge-plugin/.claude-plugin/plugin.json` from `0.6.0` to `0.7.0` (behavior change for `/eforge:build`).

### Key Decisions

1. **Keep `eforge_follow` registered in the MCP server.** Pi uses it; advanced Claude Code users can still invoke it explicitly. Only the skill stops auto-calling it. No changes to `packages/eforge/src/cli/mcp-proxy.ts`, `packages/client/src/session-stream.ts`, or `packages/monitor/src/server.ts`.
2. **Pi's Step 6 stays, wrapped in parity-skip.** The source document lists the Pi SKILL as out of scope, but `pnpm test` runs the parity checker which will fail if only the plugin removes Step 6. Wrapping the Pi Step 6 in `parity-skip-*` markers is a pure-markup change that preserves Pi's runtime behavior (skip markers are HTML comments, invisible to the loaded skill). This satisfies acceptance criterion #2 (`pnpm test` passes) without altering Pi's behavior, honoring the source's intent that Pi stays functional.
3. **Step 5 message wording.** Use the pre-plan-02 guidance: "PRD enqueued (session: {sessionId}). The daemon will auto-build. Watch live at {monitorUrl} or run `/eforge:status` for progress." Keep the existing 2nd paragraph explaining pipeline variation by profile, since it is orthogonal to follow-vs-fire-and-forget.
4. **Minor plugin version bump (0.6.0 -> 0.7.0)** rather than patch. The tool call contract from the user's perspective changes materially (blocking vs non-blocking), warranting a minor bump under the plugin's versioning policy.

## Scope

### In Scope
- Remove Step 6 from the Claude Code build skill markdown
- Rewrite Step 5 success message to point at monitor URL and `/eforge:status`
- Add `<!-- parity-skip-start -->` / `<!-- parity-skip-end -->` around Pi's Step 6 (no other Pi edits)
- Bump `eforge-plugin/.claude-plugin/plugin.json` version to `0.7.0`

### Out of Scope
- Any change to `mcp__eforge__eforge_follow` registration or implementation (`packages/eforge/src/cli/mcp-proxy.ts`)
- Any change to `packages/client/src/session-stream.ts`
- Any change to `packages/monitor/src/server.ts`
- Any behavioral/narrative change to the Pi build skill beyond adding the parity-skip markers
- Introducing any new stop-hook, subagent, or polling mechanism for inline summaries (explicitly deferred per source)
- Changes to `eforge-plugin/skills/status/status.md` or any other skill

## Files

### Modify

- `eforge-plugin/skills/build/build.md` - delete the entire Step 6 section (`### Step 6: Follow the Build` heading and its body, currently lines 142-156). Update the Step 5 success message block to read:

  > PRD enqueued (session: `{sessionId}`). The daemon will auto-build.
  >
  > Watch live at {monitorUrl} or run `/eforge:status` for progress.
  >
  > The daemon formats your source into a PRD, selects a workflow profile, then compiles and builds. The pipeline varies by profile - errands skip straight to building, while excursions and expeditions go through planning and plan review first. Every profile gets blind code review (a separate agent with no builder context), merge, and post-merge validation.

  Remove the now-redundant trailing sentence "If the monitor is running, also include the monitor URL." since the monitor URL is now inline in the primary message. Leave the related-skills row pointing at `/eforge:status` as-is (already present around line 177).

- `packages/pi-eforge/skills/eforge-build/SKILL.md` - wrap the existing Step 6 section (the `### Step 6: Follow the Build` heading and its body, currently lines 138-152) in `<!-- parity-skip-start -->` and `<!-- parity-skip-end -->` HTML-comment markers. Do not change any other content in the file. The wrapping must place the start marker immediately before the `### Step 6: Follow the Build` line and the end marker immediately after the final paragraph of the section ("If the user cancels or the tool is interrupted, acknowledge and point them at `/eforge:status` to re-check progress.") and before the `## Error Handling` section heading.

- `eforge-plugin/.claude-plugin/plugin.json` - bump the `version` field from `"0.6.0"` to `"0.7.0"`. No other changes.

## Verification

- [ ] `eforge-plugin/skills/build/build.md` contains no `### Step 6` section and no references to `mcp__eforge__eforge_follow` or `eforge_follow`.
- [ ] `eforge-plugin/skills/build/build.md` Step 5 success message contains the literal substring `run `/eforge:status` for progress` and references `{monitorUrl}` inline.
- [ ] `packages/pi-eforge/skills/eforge-build/SKILL.md` contains exactly one `<!-- parity-skip-start -->` immediately preceding `### Step 6: Follow the Build` and one matching `<!-- parity-skip-end -->` between the final paragraph of Step 6 and the `## Error Handling` heading.
- [ ] `packages/pi-eforge/skills/eforge-build/SKILL.md` still contains the literal call `eforge_follow` inside the Step 6 block (unchanged Pi behavior).
- [ ] `eforge-plugin/.claude-plugin/plugin.json` shows `"version": "0.7.0"`.
- [ ] `pnpm type-check` exits 0.
- [ ] `pnpm test` exits 0 (includes `scripts/check-skill-parity.mjs` and vitest).
- [ ] `pnpm build` exits 0 and emits `packages/eforge/dist/cli.js`.
