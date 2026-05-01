---
id: plan-01-close-parity-gaps
name: Close plugin/Pi parity gaps and extend parity script
branch: audit-eforge-plugin-and-packages-pi-eforge-for-capability-drift-and-close-gaps/close-gaps
---

## Architecture Context

The two consumer-facing surfaces of eforge are:
- **`eforge-plugin/`** — Claude Code plugin (skills + commands derived from `plugin.json`; MCP tools served by `packages/eforge/src/cli/mcp-proxy.ts` via the `bin/eforge-mcp-proxy.mjs` shim).
- **`packages/pi-eforge/`** — Pi extension (skills + native commands + tools registered directly in `extensions/eforge/index.ts`).

`AGENTS.md` requires that every capability exposed in one is exposed in the other when technically feasible. `scripts/check-skill-parity.mjs` enforces text parity for 9 of the 11 paired skills (excluding `playbook` and `recover`).

The audit surfaced four real gaps. All other rows of the parity matrix are either `parity` or `*-only-intentional`:
- `eforge_confirm_build` is Pi-only because it uses an interactive TUI overlay; the MCP transport cannot render TUIs.
- `eforge://status`, `eforge://queue`, `eforge://config`, `eforge://status/{sessionId}` are plugin-only because MCP resources are a Claude Code protocol feature with no Pi equivalent.
- The `init` skill diverges in harness selection (plugin offers both `claude-sdk` and `pi`; Pi offers only `pi`) — this is intentional and the parity script's normalizer already handles it via `parity-skip` markers.

## Implementation

### Overview

Make four small, related edits that close the audit's gap rows, plus a plugin version bump and a parity-script extension that prevents the same drift from recurring.

### Key Decisions

1. **Remove `eforge_enqueue` from the plugin instead of mirroring it on Pi.** It is registered in `mcp-proxy.ts` but referenced by zero skills, zero tests, and zero documentation. It overlaps with `eforge_build` (same daemon endpoint, same primary `source` parameter). Adding a no-op duplicate to Pi would be worse than removing the dead code.
2. **Register `eforge:recover` in Pi as a skill-delegate command** (mirroring how `eforge:build`, `:status`, `:init`, `:plan`, `:restart`, `:update` are wired). Recover is a conversational workflow ("confirm with the user, then apply"), so a TUI overlay is not the right model — the existing skill body is the right contract.
3. **Fix the plugin recover skill's reference table** — the body says "Call `eforge_queue_list` to discover failed PRDs" but the appendix table claims `eforge_status` is the discovery tool. Pi's table correctly says `eforge_queue_list`. This is a text bug, not a parity question.
4. **Add `playbook` and `recover` to the parity script.** `playbook` already passes the script's normalizer (the only diff is the Pi `> **Note:**` block which `stripPiNoteBlock` removes). `recover` will pass after step 3 plus wrapping the two genuinely platform-specific table cells (`MCP tools` / `plugin configuration` vs `tools` / `extension is loaded`) in `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` markers on each side. Per the parity script's documented contract, each skip block must contain only the *owning platform's* phrasing.
5. **Bump plugin version 0.19.0 → 0.20.0.** The recover skill body is consumer-visible. Per `AGENTS.md`: "Always bump the plugin version in `eforge-plugin/.claude-plugin/plugin.json` when changing anything in the plugin."

## Scope

### In Scope
- Remove `eforge_enqueue` MCP tool registration from `packages/eforge/src/cli/mcp-proxy.ts` (the entire `createDaemonTool(server, cwd, { name: 'eforge_enqueue', ... })` block, currently at lines ~340-352).
- Add `eforge:recover` to the `skillCommands` array in `packages/pi-eforge/extensions/eforge/index.ts` (the array at lines ~1672-1707, registered by the loop at ~1709-1716). Use `description: "Inspect and apply recovery for a failed PRD"` and `skill: "eforge-recover"`.
- In `eforge-plugin/skills/recover/recover.md`: change the table row whose tool column reads `` `eforge_status` `` to `` `eforge_queue_list` `` (currently the "Common Sibling Tools" appendix). Wrap the platform-specific phrasing in the "Tool unavailable" row in a `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` block containing only the plugin's wording ("MCP tools" / "plugin configuration").
- In `packages/pi-eforge/skills/eforge-recover/SKILL.md`: wrap the corresponding "Tool unavailable" row in a matching skip block containing only the Pi wording ("tools" / "extension is loaded"). Do NOT duplicate plugin phrasing inside the Pi skip block.
- Extend `scripts/check-skill-parity.mjs`: add `{ plugin: "playbook", pi: "eforge-playbook" }` and `{ plugin: "recover", pi: "eforge-recover" }` to the `SKILL_PAIRS` constant. No normalizer changes needed — the existing `stripSkipBlocks` and `stripPiNoteBlock` cover both new pairs after the skill edits above.
- Bump `eforge-plugin/.claude-plugin/plugin.json` `version` from `0.19.0` to `0.20.0`.

### Out of Scope
- Adding any net-new capability that does not already exist in either package.
- Modifying `packages/pi-eforge/package.json` version (reserved for the publish flow per `AGENTS.md`).
- Changes to `packages/monitor/`, `packages/engine/`, `README.md`, or `docs/`.
- Refactoring or restructuring any other tools, skills, or commands. The audit's matrix records every other row as parity or intentional — do not modify them.
- Adding `eforge_confirm_build` to the plugin or MCP resources to Pi (both are intentional platform-affordance gaps documented in this plan's Architecture Context).

## Files

### Modify
- `packages/eforge/src/cli/mcp-proxy.ts` — delete the `eforge_enqueue` tool registration block (the whole `createDaemonTool(server, cwd, { name: 'eforge_enqueue', ... })` invocation including the leading `// Tool: eforge_enqueue` comment). Leave `sanitizeFlags` in place if it is referenced elsewhere; remove it if `eforge_enqueue` was the only caller. Do not touch `eforge_build`.
- `packages/pi-eforge/extensions/eforge/index.ts` — append `{ name: "eforge:recover", description: "Inspect and apply recovery for a failed PRD", skill: "eforge-recover" }` to the `skillCommands` array. The existing loop at the bottom of the array will register it via `pi.registerCommand` and have it `sendUserMessage("/skill:eforge-recover ...")`. Place it adjacent to the other entries (alphabetical by command name is fine).
- `eforge-plugin/skills/recover/recover.md` — (a) change `` `eforge_status` `` to `` `eforge_queue_list` `` in the Common Sibling Tools table row whose purpose is "Check which PRDs are failed before recovering"; (b) wrap the "Tool unavailable" troubleshooting row in `<!-- parity-skip-start -->` / `<!-- parity-skip-end -->` markers (plugin wording only, no Pi content).
- `packages/pi-eforge/skills/eforge-recover/SKILL.md` — wrap the corresponding "Tool unavailable" row in `<!-- parity-skip-start -->` / `<!-- parity-skip-end -->` markers (Pi wording only, no plugin content). The body must remain byte-identical to the plugin after the parity script's normalization is applied.
- `scripts/check-skill-parity.mjs` — append two entries to `SKILL_PAIRS`: `{ plugin: "playbook", pi: "eforge-playbook" }` and `{ plugin: "recover", pi: "eforge-recover" }`. No other changes; do not touch normalizers.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `"version": "0.19.0"` to `"version": "0.20.0"`.

### Create
- (none)

## Verification

- [ ] `node scripts/check-skill-parity.mjs` reports `11/11 pairs in sync.` (was 9/9; adding `playbook` and `recover` brings it to 11).
- [ ] `grep -n "eforge_enqueue" packages/eforge/src/cli/mcp-proxy.ts` returns zero matches.
- [ ] `grep -rn "eforge_enqueue" packages/ eforge-plugin/ --include="*.ts" --include="*.md"` returns zero matches across the repo.
- [ ] `grep -n "eforge:recover" packages/pi-eforge/extensions/eforge/index.ts` returns at least one match showing the command registration; running `node -e "import('./packages/pi-eforge/extensions/eforge/index.ts')"` (after `pnpm build`) does not throw a duplicate-name error.
- [ ] In `eforge-plugin/skills/recover/recover.md`, the Common Sibling Tools row whose purpose column contains `Check which PRDs are failed before recovering` references `` `eforge_queue_list` `` (not `` `eforge_status` ``).
- [ ] `eforge-plugin/.claude-plugin/plugin.json` shows `"version": "0.20.0"`.
- [ ] `pnpm test` exits 0 (parity check + vitest, both run by the root `test` script).
- [ ] `pnpm type-check` exits 0 across all workspaces.
- [ ] `grep -n "@eforge-build/client" packages/pi-eforge/extensions/eforge/index.ts packages/eforge/src/cli/mcp-proxy.ts` still shows the imports intact and no inlined `/api/...` route literals or `daemon-request` reimplementations were introduced (constraint from the audit's acceptance criteria).
- [ ] No file under `packages/monitor/`, `packages/engine/`, or `packages/pi-eforge/package.json` was modified by this plan.