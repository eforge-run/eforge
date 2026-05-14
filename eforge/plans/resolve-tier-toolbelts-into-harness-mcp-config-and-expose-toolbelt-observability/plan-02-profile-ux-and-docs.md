---
id: plan-02-profile-ux-and-docs
name: Profile UX surfaces, monitor rendering, and docs cleanup
branch: resolve-tier-toolbelts-into-harness-mcp-config-and-expose-toolbelt-observability/plan-02-profile-ux-and-docs
agents:
  builder:
    effort: high
    rationale: Touches monitor-ui shadcn components, Pi profile-commands YAML
      rendering, Claude Code skill text, eforge-plugin version bump, and final
      docs. No type churn but multiple parallel surfaces with skill-parity check
      via scripts/check-skill-parity.mjs.
---

---
id: plan-02-profile-ux-and-docs
name: Profile UX surfaces, monitor rendering, and docs cleanup
depends_on: [plan-01-runtime-and-observability]
---

# Profile UX surfaces, monitor rendering, and docs cleanup

## Architecture Context

Plan 01 lands runtime filtering, the new optional `agent:start` fields, and harness debug payload restructure. This plan renders the resulting data in user-facing surfaces and finishes the docs that still flag the runtime as "not yet implemented".

Profile show/list returns the full resolved profile YAML config (`packages/monitor/src/server.ts` line 1619 onward), so consumers can derive `tier.toolbelt` and the referenced `tools.toolbelts.<name>.mcpServers` directly. The monitor UI already has a profile sheet that renders tier recipe fields (`packages/monitor-ui/src/components/profile/profile-badge.tsx`); the Pi extension renders a YAML preview when creating profiles (`packages/pi-eforge/extensions/eforge/profile-commands.ts::buildYamlPreview`); the Claude Code plugin shows `resolved.harness` from the show response (`eforge-plugin/skills/profile/profile.md`). All three need to additionally display each tier's toolbelt assignment (referenced toolbelt name + selected server names, or `none`).

This plan also adds rendering of per-agent toolbelt selection into the monitor UI's agent detail/hover surface so a user looking at a running build can confirm which project MCP servers reached which agent run.

## Implementation

### Overview

1. Update monitor `profile-badge.tsx` to display tier `toolbelt` assignment (toolbelt name + sorted referenced server names from `cfg.tools.toolbelts[name].mcpServers`, or the badge text `none` when explicit).
2. Update monitor UI agent detail/hover component(s) to display `toolbelt`, `projectMcpSelection`, and `projectMcpServerNames` from agent state populated by the plan-01 reducer change.
3. Update Pi `profile-commands.ts::buildYamlPreview` to render the `toolbelt:` line under each tier when set, and to render a top-level `tools.toolbelts:` section when present on `payload.tools`.
4. Update Pi profile-show rendering in `packages/pi-eforge/extensions/eforge/index.ts` (and any sibling commands that print a textual profile summary) to include tier toolbelt assignments.
5. Update Claude Code profile skill text (`eforge-plugin/skills/profile/profile.md`) and Pi skill text (`packages/pi-eforge/skills/eforge-profile/SKILL.md`) so the `show` output now includes a tier-by-tier toolbelt summary. Run `node scripts/check-skill-parity.mjs` to confirm parity gate stays green.
6. Update `packages/eforge/src/cli/mcp-proxy.ts` profile tool result formatting so the MCP-exposed profile show/list response surfaces tier toolbelt assignments to the Claude Code plugin consumers.
7. Bump `eforge-plugin/.claude-plugin/plugin.json` version per repo policy. Do NOT bump `packages/pi-eforge/package.json` (release flow owns it).
8. Finalize docs: update `docs/roadmap.md` to remove the "Remaining work" paragraph under "Profile toolbelts - runtime filtering" and reflect that runtime filtering + observability have shipped. Update `docs/prd/profile-toolbelts.md` with a status note that runtime and observability are implemented; leave the canonical Playwright UI profile example for TOOLBELTS_06.

### Key Decisions

1. **Read profile config, not new wire shapes.** The profile show route already returns the resolved profile config including `tools.toolbelts` and per-tier `toolbelt`. Do not add typed summary fields to `ProfileShowResponse` in `@eforge-build/client` for this slice - consumers can derive the summary in one place each. Adding wire shapes is deferred unless duplication across Pi/Claude/monitor becomes painful in a future plan.
2. **MCP server names only.** No surface in this plan exposes backend tool names like `mcp__playwright__browser_navigate`. Profile and agent surfaces show MCP server names (e.g. `playwright`).
3. **Monitor agent surface.** Add a small block near the existing tier/effort/model badges showing `toolbelt: <name>` (or `none`/`all`) and the sorted `projectMcpServerNames` when non-empty. Reuse existing shadcn `Badge` component (no new primitives).
4. **Plugin version bump cadence.** Because `eforge-plugin/skills/profile/profile.md` changes the documented show output, bump the plugin version. Skill-parity script enforces matching text in the Pi twin.
5. **No new wire-protocol bumps.** Plan 01 already settled whether `DAEMON_API_VERSION` needed bumping. Profile-show response payload is unchanged here.

## Scope

### In Scope
- Monitor UI: render tier toolbelt assignments in `profile-badge.tsx`.
- Monitor UI: render per-agent toolbelt selection in agent detail/hover surface using fields captured by the plan-01 reducer change.
- Pi extension: render tier `toolbelt:` in `buildYamlPreview` and any profile-show summary path; render `tools.toolbelts:` section when present.
- Claude Code plugin: update `eforge-plugin/skills/profile/profile.md` show output documentation to mention tier toolbelt summary.
- Pi skill text parity: update `packages/pi-eforge/skills/eforge-profile/SKILL.md` to match.
- `packages/eforge/src/cli/mcp-proxy.ts` profile-related tool response includes tier toolbelt assignments when present.
- `eforge-plugin/.claude-plugin/plugin.json` version bump.
- `docs/roadmap.md` update: profile toolbelts entry no longer flags remaining runtime/observability work.
- `docs/prd/profile-toolbelts.md` status note that runtime + observability are implemented (preserve TOOLBELTS_06 for the Playwright canonical profile example).
- Tests: monitor-ui rendering tests for profile-badge tier toolbelt section and agent detail toolbelt surface; Pi `buildYamlPreview` toolbelt output test if one exists for that helper.

### Out of Scope
- New typed wire shapes for profile list/show summarization (deferred).
- Live MCP doctor or backend tool listing.
- Per-role toolbelt assignment UX.
- Pi extension or Claude plugin-backed toolbelts.
- Runtime/engine behavior (owned by plan-01).
- Canonical Playwright UI profile example (deferred to TOOLBELTS_06).

## Files

### Create
- (No new files unless a focused rendering test is easier as a new file, e.g. `packages/monitor-ui/src/components/profile/profile-badge.test.tsx` if one does not exist.)

### Modify
- `packages/monitor-ui/src/components/profile/profile-badge.tsx` - extend `ProfileConfigShape` with `tools?: { toolbelts?: Record<string, { description?: string; mcpServers: string[] }> }`; extend `TierRecipeEntry` with `toolbelt?: string`; in the "Tier Recipes" section, render a `toolbelt` row showing the selected toolbelt name (or `none`/`all (default)`) plus the sorted list of referenced server names looked up via `cfg.tools.toolbelts[entry.toolbelt]?.mcpServers`. Use existing shadcn `Badge`/text styles - no new primitives.
- Monitor UI agent detail/hover surface (locate the component that renders `agent:start` fields next to tier/effort badges; likely under `packages/monitor-ui/src/components/agent*` or `packages/monitor-ui/src/components/build*`) - add a small inline section showing `toolbelt: <name | none | all>` and, when non-empty, the sorted `projectMcpServerNames`. Use shadcn `Badge` + plain text.
- `packages/pi-eforge/extensions/eforge/profile-commands.ts::buildYamlPreview` - when an entry has a `toolbelt`, append `      toolbelt: ${entry.toolbelt}`. If `payload.tools?.toolbelts` is present, append a `tools:\n  toolbelts:` section with each declared toolbelt's `description` and `mcpServers` list.
- `packages/pi-eforge/extensions/eforge/index.ts` - in any profile-show formatter that lists tier recipes, append `toolbelt: <name | none>` per tier when present, mirroring the monitor surface.
- `packages/eforge/src/cli/mcp-proxy.ts` - in the `profileShow`/`profileList` tool handlers, include tier toolbelt assignments in the formatted text/JSON response so Claude Code plugin consumers receive the data.
- `eforge-plugin/skills/profile/profile.md` - in the show output documentation, add a `Tier toolbelts:` bullet that mirrors the monitor and Pi surfaces (toolbelt name + referenced server names).
- `packages/pi-eforge/skills/eforge-profile/SKILL.md` - mirror the Claude Code skill text update so `node scripts/check-skill-parity.mjs` stays green.
- `eforge-plugin/.claude-plugin/plugin.json` - bump `version` per repo policy.
- `docs/roadmap.md` - update the "Profile toolbelts - runtime filtering" entry: drop the "Remaining work" paragraph and note that runtime filtering and observability have shipped. Keep TOOLBELTS_06 (canonical Playwright UI profile example) on the roadmap if currently listed.
- `docs/prd/profile-toolbelts.md` - add a brief Status note under the title indicating runtime filtering and observability are implemented; leave the canonical Playwright example for TOOLBELTS_06.

## Verification

- [ ] `pnpm type-check` succeeds across all workspace packages.
- [ ] `pnpm test` passes (vitest + `node scripts/check-skill-parity.mjs`).
- [ ] `pnpm build:ui` (or `pnpm build`) succeeds for `@eforge-build/monitor-ui` with the new rendering changes.
- [ ] Monitor UI profile sheet renders a `toolbelt: <name>` row per tier when the resolved profile config sets `tier.toolbelt`; renders `toolbelt: none` when explicit; omits the row (or shows `all (default)`) when omitted.
- [ ] Monitor UI agent detail/hover surface displays `toolbelt`, `projectMcpSelection`, and the sorted `projectMcpServerNames` from an `agent:start` event that carries them.
- [ ] Pi `buildYamlPreview` output for a profile that sets `tier.toolbelt: browser-ui` contains the literal line `      toolbelt: browser-ui` inside that tier block.
- [ ] Pi `buildYamlPreview` renders a `tools:\n  toolbelts:` section when `payload.tools?.toolbelts` is non-empty.
- [ ] `eforge-plugin/skills/profile/profile.md` and `packages/pi-eforge/skills/eforge-profile/SKILL.md` both mention tier toolbelt summary in the show output; `node scripts/check-skill-parity.mjs` exits 0.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` is greater than the version in main at the point this branch diverged.
- [ ] `docs/roadmap.md` no longer contains the substring "Remaining work" under "Profile toolbelts - runtime filtering".
- [ ] `docs/prd/profile-toolbelts.md` includes a status note that runtime filtering and observability are implemented.
- [ ] `packages/eforge/src/cli/mcp-proxy.ts` profile tool responses include tier toolbelt assignments when present in the resolved profile config.
