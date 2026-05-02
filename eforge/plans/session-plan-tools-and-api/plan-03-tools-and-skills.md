---
id: plan-03-tools-and-skills
name: MCP/Pi session-plan tool, skill updates, plugin version bump
branch: session-plan-tools-and-api/tools-and-skills
---

## Architecture Context

This plan adds the user-facing surfaces that consume the routes from plan-02: a single `eforge_session_plan` tool exposed by both the Claude Code MCP proxy and the Pi extension, and updates to the four skill files (`/eforge:plan` and `/eforge:build` in both Pi and Claude plugin) so they call the new tool instead of doing prompt-driven YAML/Markdown surgery on session-plan files. It also bumps the plugin version and updates docs.

Key existing surfaces:

- `packages/eforge/src/cli/mcp-proxy.ts` (lines 770–850) — `eforge_playbook` tool registered via `createDaemonTool`. New `eforge_session_plan` tool follows the same pattern: one tool with a discriminated `action` enum.
- `packages/pi-eforge/extensions/eforge/index.ts` (lines 1505–1665) — Pi-native `eforge_playbook` tool with TypeBox schema + `renderCall` / `renderResult`. New `eforge_session_plan` tool mirrors that shape using `daemonRequest` + `API_ROUTES.sessionPlan*` constants from plan-01.
- `eforge-plugin/skills/build/build.md` and `packages/pi-eforge/skills/eforge-build/SKILL.md` — Step 1 Branch C and Step 5 currently instruct manual scanning of `.eforge/session-plans/`, manual frontmatter parsing for readiness, and manual YAML edits to mark `status: submitted`. Replace with `eforge_session_plan` tool calls (`list-active`, `show`, `readiness`). The submitted-state edit is now performed by the daemon (plan-02), so step 5 can drop the YAML edit instruction entirely.
- `eforge-plugin/skills/plan/plan.md` and `packages/pi-eforge/skills/eforge-plan/SKILL.md` — Step 1 (resume + new session creation), Step 3 (classification), Step 4 (dimension selection), Step 5 (per-dimension section writes + skip), and Step 7 (readiness + status flip to `ready`) all currently instruct manual file edits. Replace with `eforge_session_plan` tool calls (`create`, `select-dimensions`, `set-section`, `skip-dimension`, `readiness`, `set-status`, `migrate-legacy`). Conversational planning behavior (Step 2 codebase exploration, Step 5 question prompts, Step 6 profile signal narrative) stays intact.
- `eforge-plugin/.claude-plugin/plugin.json` — currently version `0.22.0`; bump per project convention because plugin skills change.
- `scripts/check-skill-parity.mjs` — runs as part of `pnpm test`. Plugin and Pi skill files must remain narrative-equivalent after edits (modulo `parity-skip` blocks).
- `docs/architecture.md` — the package/control-plane section already describes `Input` and `Client` packages; add a sentence about session-plan routes/tool surfacing through these layers.

## Implementation

### Overview

1. **MCP tool** (`packages/eforge/src/cli/mcp-proxy.ts`): register `eforge_session_plan` via `createDaemonTool`. Action enum: `list-active`, `show`, `create`, `set-section`, `skip-dimension`, `set-status`, `select-dimensions`, `readiness`, `migrate-legacy`. Each branch builds the request body and calls the corresponding `API_ROUTES.sessionPlan*` route. Description and per-action parameter docs follow the `eforge_playbook` shape so agents reading the tool list see consistent guidance.
2. **Pi native tool** (`packages/pi-eforge/extensions/eforge/index.ts`): register the same `eforge_session_plan` tool with TypeBox schema, `renderCall` (showing `eforge session-plan <action> <session>`), and `renderResult` (special-casing `list-active` and `readiness` outputs the way `eforge_playbook` special-cases its list/save/enqueue payloads).
3. **Build skills** (`eforge-plugin/skills/build/build.md` and `packages/pi-eforge/skills/eforge-build/SKILL.md`):
   - Step 1 Branch C item 1: replace the inline `.eforge/session-plans/` scanning + frontmatter parsing instructions with a single `eforge_session_plan` call: `{ action: 'list-active' }` to discover active plans, then `{ action: 'readiness', session }` for any plan the user wants to inspect. Continue to support listing multiple, prompting the user, and using the file path as enqueue source. Do not duplicate readiness rules in the prompt — they live in the tool now.
   - Step 5 item 1: remove the manual YAML edit instruction ("update the session file's YAML frontmatter: set `status: submitted` and add `eforge_session: {sessionId}`"). The daemon handles this automatically per plan-02. Mention the behavior in passing so users understand why the file changed, but do not instruct the model to perform the edit.
4. **Plan skills** (`eforge-plugin/skills/plan/plan.md` and `packages/pi-eforge/skills/eforge-plan/SKILL.md`):
   - Step 1 New session path: replace the inline file-creation instructions with `{ action: 'create', session, topic }`.
   - Step 1 Resume path: list active plans via `{ action: 'list-active' }`, load via `{ action: 'show', session }`, and use `{ action: 'migrate-legacy', session }` instead of the prompt-level legacy-detection rules. Keep the legacy narrative section but defer detection to the tool.
   - Step 3/4: after classification, call `{ action: 'select-dimensions', session, planning_type, planning_depth }` rather than instructing the agent to write `required_dimensions` / `optional_dimensions` in YAML. Keep the type/depth tables — those are conversation guidance, not file-edit instructions.
   - Step 5: per-dimension recording becomes `{ action: 'set-section', session, dimension, content }` and `{ action: 'skip-dimension', session, dimension, reason }` instead of Edit-tool YAML/Markdown surgery. Keep the dimension question guide and the placeholder/substantive-content rule narrative — they explain what to ask, not how to write it.
   - Step 7: `{ action: 'readiness', session }` to assemble the readiness summary and `{ action: 'set-status', session, status: 'ready' }` to flip status. Drop the prompt-level placeholder rules — they live in the tool.
   - Keep Steps 2 (context gathering), 6 (profile signal narrative), Conversation Style, and the Saving-as-Playbook handoff intact.
5. **Plugin manifest**: bump `version` in `eforge-plugin/.claude-plugin/plugin.json` (e.g., `0.22.0` → `0.23.0`) per project convention because user-facing plugin skill behavior changed.
6. **Docs**: extend `docs/architecture.md` Package Topology section to mention that session-plan routes and the `eforge_session_plan` tool ride on the `client` → `monitor` → `input` chain just like playbooks. Update `README.md` only if it documents the `/eforge:plan` or `/eforge:build` session-plan workflow steps that materially changed.
7. **Skill parity**: after editing both Claude and Pi versions of each skill, run `node scripts/check-skill-parity.mjs` (this is part of `pnpm test`). Use `<!-- parity-skip-start -->` / `<!-- parity-skip-end -->` markers only for genuine platform-divergent affordances (preserved from existing skip-blocks for `eforge_confirm_build`, etc.). Tool action names and request shapes are identical, so the bulk of edits should diff-match without skip markers.

### Key Decisions

1. **Single `eforge_session_plan` tool with action enum** — mirrors `eforge_playbook` and avoids tool-list bloat. Per the PRD design decision.
2. **Skills do not perform YAML edits** — every file mutation routes through the tool. This is the entire point of the follow-on per the PRD's "prompt-level YAML/Markdown surgery" framing.
3. **Auto-submit instructions are removed from build skills** — daemon owns this now (plan-02). Removing the instruction prevents a double-write race where the skill might overwrite the daemon's update.
4. **Conversation behavior is preserved** — codebase exploration, dimension question prompts, profile signal narrative, abandonment flows, and the playbook handoff all stay in the skill prompts. The tool replaces deterministic file mechanics, not conversational decision-making.
5. **Plugin minor version bump** — user-visible behavior of skills changed (no more YAML surgery prompt instructions, new tool dependency). Per project convention, the plugin manifest version bumps.

## Scope

### In Scope
- New `eforge_session_plan` MCP tool registration in `packages/eforge/src/cli/mcp-proxy.ts`.
- New `eforge_session_plan` Pi native tool registration in `packages/pi-eforge/extensions/eforge/index.ts`.
- Updates to `eforge-plugin/skills/build/build.md` and `packages/pi-eforge/skills/eforge-build/SKILL.md` to use the new tool for active-plan discovery / readiness, and to drop the post-enqueue YAML edit (now daemon-owned).
- Updates to `eforge-plugin/skills/plan/plan.md` and `packages/pi-eforge/skills/eforge-plan/SKILL.md` to use the new tool for create / list / show / readiness / dimension selection / section writes / skip dimensions / status updates / legacy migration.
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json`.
- `docs/architecture.md` update describing session-plan routes / tool layering.
- README.md update only where session-plan workflow steps materially changed.
- Skill-parity check (`scripts/check-skill-parity.mjs`) passes for both build and plan skill pairs.

### Out of Scope
- New conversational logic in the planning skill.
- Native Pi TUI for `/eforge:plan` (left for follow-on).
- Engine changes.
- Adding a `save` (full-file) tool action — deferred per PRD risk note.
- Web monitor UI for session plans.

## Files

### Modify
- `packages/eforge/src/cli/mcp-proxy.ts` — register `eforge_session_plan` MCP tool with action enum dispatching to `API_ROUTES.sessionPlan*` via `daemonRequest`.
- `packages/pi-eforge/extensions/eforge/index.ts` — register Pi-native `eforge_session_plan` tool with TypeBox schema, `renderCall`, and `renderResult` mirroring `eforge_playbook`.
- `eforge-plugin/skills/build/build.md` — replace Step 1 Branch C session-plan scanning/parsing/readiness narrative with `eforge_session_plan` tool calls; remove Step 5 item 1 manual YAML edit instruction.
- `packages/pi-eforge/skills/eforge-build/SKILL.md` — same edits as plugin build skill, preserving `parity-skip` blocks.
- `eforge-plugin/skills/plan/plan.md` — replace inline file-create / dimension-list-write / section-write / skip-dimension / status-flip / legacy-migrate instructions with `eforge_session_plan` tool calls; preserve conversational guidance (questions, narrative, handoff).
- `packages/pi-eforge/skills/eforge-plan/SKILL.md` — same edits as plugin plan skill, preserving `parity-skip` blocks.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` (e.g., `0.22.0` → `0.23.0`).
- `docs/architecture.md` — extend Package Topology / control-plane section with a sentence explaining that session-plan routes and the `eforge_session_plan` tool layer on `client` → `monitor` → `input` like playbooks.
- `README.md` — update only if existing prose describes session-plan workflow steps that changed (e.g., the manual YAML editing). If no such prose exists, leave unchanged.

## Verification

- [ ] `eforge_session_plan` MCP tool is registered in `mcp-proxy.ts` with actions `list-active`, `show`, `create`, `set-section`, `skip-dimension`, `set-status`, `select-dimensions`, `readiness`, `migrate-legacy`.
- [ ] `eforge_session_plan` Pi native tool is registered in the Pi extension with the same action set, TypeBox parameter schema matching the MCP zod schema, plus `renderCall` and `renderResult` implementations.
- [ ] Both tools dispatch every action via `daemonRequest` against `API_ROUTES.sessionPlan*` constants — no inline `/api/...` strings.
- [ ] `eforge-plugin/skills/build/build.md` and `packages/pi-eforge/skills/eforge-build/SKILL.md` no longer instruct the model to scan `.eforge/session-plans/` manually, parse frontmatter manually, or apply readiness rules in prose; each of those steps is replaced with an `eforge_session_plan` tool call.
- [ ] Both build skills no longer instruct the model to set `status: submitted` or write `eforge_session` after `eforge_build` returns.
- [ ] `eforge-plugin/skills/plan/plan.md` and `packages/pi-eforge/skills/eforge-plan/SKILL.md` use `eforge_session_plan` tool calls for create / list / show / readiness / dimension selection / section writes / skip dimensions / status updates / legacy migration; conversational guidance (codebase exploration, per-dimension questions, profile signal, playbook handoff) is preserved verbatim or with only mechanical changes.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` is greater than the prior value.
- [ ] `docs/architecture.md` mentions session-plan routes / `eforge_session_plan` tool layering on `client` → `monitor` → `input`.
- [ ] `node scripts/check-skill-parity.mjs` exits 0 (also runs as part of `pnpm test`).
- [ ] Existing playbook MCP/Pi tools and routes are unchanged and still work.
- [ ] `pnpm type-check` passes.
- [ ] `pnpm test` passes (includes skill-parity check + all daemon and input tests from plan-01 / plan-02).
- [ ] `pnpm build` produces bundles for `packages/eforge`, `packages/pi-eforge`, and `packages/monitor` without error.
