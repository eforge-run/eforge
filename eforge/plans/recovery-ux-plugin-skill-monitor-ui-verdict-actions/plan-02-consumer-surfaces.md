---
id: plan-02-consumer-surfaces
name: /recover Skill (Plugin + Pi) and Monitor UI Verdict Action Buttons
branch: recovery-ux-plugin-skill-monitor-ui-verdict-actions/consumer-surfaces
---

# /recover Skill (Plugin + Pi) and Monitor UI Verdict Action Buttons

## Architecture Context

With `eforge_apply_recovery` and the `POST /api/recover/apply` route landed by `plan-01`, this plan delivers the user-facing surfaces:

- A `/recover` slash command in the Claude Code plugin that lists failed PRDs, reads the sidecar, presents the verdict, confirms with the user, and calls `eforge_apply_recovery`.
- The same skill in the Pi extension (Pi auto-discovers from `packages/pi-eforge/skills/`).
- Verdict-specific action buttons inside the existing `RecoverySidecarSheet` so the monitor UI follows the agreed view-then-act pattern (no one-click row buttons).
- A small "Run analysis" icon-button on failed rows that have no sidecar yet, so the user can trigger `recover` from the UI when the inline analysis didn't run or hasn't completed.

AGENTS.md mandates parity: every consumer-facing capability we expose in the Claude Code plugin must also exist in `packages/pi-eforge/`. This plan honors that by shipping both skill files in the same change.

## Implementation

### Overview

**Skill content (shared between plugin + Pi):**

1. Parse optional `<setName> <prdId>` args. If absent, call `eforge_status` and ask the user to pick from the failed PRDs.
2. Call `eforge_read_recovery_sidecar`. If 404 or the JSON has `recoveryError`: offer to call `eforge_recover` to (re)generate the verdict, then loop back to step 2.
3. Render the verdict, confidence, rationale, completed/remaining work, and (for `split`) a preview of `suggestedSuccessorPrd`.
4. Ask the user to confirm the verdict-specific action: "Re-queue PRD" for `retry`, "Enqueue successor PRD" for `split`, "Archive failed PRD" for `abandon`. For `manual`, render the markdown report and stop without calling the apply tool.
5. On confirmation, call `eforge_apply_recovery` with `{ setName, prdId }`.

The skill never touches git or the filesystem directly — all mutation flows through the engine's `applyRecovery()` via `eforge_apply_recovery`. Honor the existing memory rule (per `feedback_dont_retry_builds.md` and `feedback_requeue_failed_prds.md`): never auto-apply, always confirm.

**Monitor UI:**

- Add `triggerRecover(setName, prdId)` and `applyRecovery(setName, prdId)` mutation helpers to `packages/monitor-ui/src/lib/api.ts` mirroring the existing `cancelSession()` shape.
- Extend `RecoverySidecarSheet` (currently 61 lines, read-only) with a `<SheetFooter>` containing verdict-specific buttons plus a "Re-run analysis" secondary button.
- In `queue-section.tsx`, when `isRecoveryPending` is true, render a small icon-button next to the "recovery pending" label that calls `triggerRecover()`. The existing 5-second polling loop will pick up the new sidecar.

### Key Decisions

1. **View-then-act, never one-click recovery on the row.** All apply buttons live inside the sheet so the user always sees the verdict, rationale, and (for split) the suggested successor PRD before committing to an action.
2. **One primary button per verdict, one secondary always.** Primary maps 1:1 to the verdict (`retry` / `split` / `abandon` show their action; `manual` shows none, only a hint). Secondary is always "Re-run analysis" so the user can re-spawn `recover()` if they disagree with the verdict.
3. **Destructive variant for retry and abandon.** Both delete files (sidecars in `retry`, PRD+sidecars in `abandon`). Use shadcn `Button variant="destructive"` to match the existing destructive-action affordance pattern in the codebase.
4. **Skills are conversational wrappers, not implementations.** The skill markdown describes how the agent should orchestrate the existing MCP tools — it does not contain logic the agent has to interpret as code. This keeps the skill aligned with the engine-emits/consumers-render principle from AGENTS.md.
5. **Plugin version bump 0.12.0 → 0.13.0.** Per AGENTS.md, bump `eforge-plugin/.claude-plugin/plugin.json` whenever plugin behavior changes. Pi package version is NOT bumped (publish-time only).
6. **Pi README is not modified unless verification shows it lists skills.** The exploration report confirmed the Pi README does not list skills today — Pi auto-discovers from the `skills/` directory — so no doc edit is required there. If a skill listing is found at build time, add `eforge-recover` to it.
7. **No new daemon API or new routes.** Both UI helpers call routes that exist (`POST /api/recover` from the original recovery work, `POST /api/recover/apply` from `plan-01`).

## Scope

### In Scope

- New `eforge-plugin/skills/recover/recover.md` Claude Code plugin skill, registered in `eforge-plugin/.claude-plugin/plugin.json` `commands` array.
- Plugin version bump in `eforge-plugin/.claude-plugin/plugin.json` from `0.12.0` to `0.13.0`.
- New `packages/pi-eforge/skills/eforge-recover/SKILL.md` mirroring the plugin skill.
- Verification check (and update if needed) of `packages/pi-eforge/README.md` — only modify if it lists skills.
- New `triggerRecover(setName, prdId)` and `applyRecovery(setName, prdId)` helpers in `packages/monitor-ui/src/lib/api.ts`.
- Extension of `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` with a verdict-aware footer (primary button per verdict + always-on "Re-run analysis" secondary).
- Addition of a "Run analysis" icon-button next to the "recovery pending" label in `packages/monitor-ui/src/components/layout/queue-section.tsx`.

### Out of Scope

- Any engine, daemon, client routes/types, MCP proxy, or Pi extension `index.ts` changes (handled in `plan-01`).
- One-click recovery affordance on the failed-row (explicitly rejected by the source).
- Auto-applying verdicts without user confirmation.
- Skill-side filesystem or git mutation (engine path only).
- Bumping `packages/pi-eforge/package.json` version.
- Bumping `DAEMON_API_VERSION`.

## Files

### Create

- `eforge-plugin/skills/recover/recover.md` — New skill markdown. Frontmatter: `description: <conversational description tying it to the recover MCP tools>` and `disable-model-invocation: true` (matching `restart.md` and `status.md`). Body sections: `## Workflow` (one-paragraph overview), `## Steps` (numbered 1–5 matching the Implementation Overview), `## Error Handling` (404 sidecar → offer `eforge_recover`; recoveryError set → re-run; apply failure → surface daemon error message verbatim), `## Related Skills` (cross-link `eforge-status`).
- `packages/pi-eforge/skills/eforge-recover/SKILL.md` — Mirror of the plugin skill, with frontmatter `name: eforge-recover` plus `description:` plus `disable-model-invocation: true` to match the Pi convention seen in `eforge-restart` / `eforge-status`. Body identical to the plugin skill.

### Modify

- `eforge-plugin/.claude-plugin/plugin.json` — Append `"./skills/recover/recover.md"` to the `commands` array (preserve existing entries and ordering style). Bump `"version"` from `"0.12.0"` to `"0.13.0"`.
- `packages/pi-eforge/README.md` — No-op unless the file contains a list of skills (current scan says it does not). If a skill list exists, add `/eforge-recover` with a one-line description matching the existing entries' style.
- `packages/monitor-ui/src/lib/api.ts` — Add two new exports:
  - `export async function triggerRecover(setName: string, prdId: string): Promise<{ sessionId: string; pid: number } | null>` — POST to `API_ROUTES.recover` with JSON `{ setName, prdId }`; mirror error handling of existing mutation helpers (`cancelSession`).
  - `export async function applyRecovery(setName: string, prdId: string): Promise<{ sessionId: string; pid: number } | null>` — POST to `API_ROUTES.applyRecovery` with the same body shape.
  - Both helpers must use `API_ROUTES` constants — do NOT inline `/api/...` strings (per AGENTS.md).
- `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` — Replace the current sheet body with a layout that puts the rendered markdown above a `<SheetFooter>` (or equivalent flex region pinned to the bottom). Footer renders, based on `sidecar.json.verdict.verdict`:
  - `retry`: shadcn `<Button variant="destructive">Re-queue PRD</Button>` calling `applyRecovery(setName, prdId)`.
  - `split`: shadcn `<Button>Enqueue successor PRD</Button>` calling `applyRecovery(setName, prdId)`.
  - `abandon`: shadcn `<Button variant="destructive">Archive failed PRD</Button>` calling `applyRecovery(setName, prdId)`.
  - `manual`: no primary button; render a single-line hint `<p class="text-xs text-text-dim italic">Use /recover in chat to act on this verdict.</p>`.
  - For all four verdicts, also render a secondary `<Button variant="secondary">Re-run analysis</Button>` calling `triggerRecover(setName, prdId)`.
  - Disable buttons while a request is in flight (track local `isApplying` / `isAnalyzing` state). On success, close the sheet via `setOpen(false)`. On error, surface the message inline (small text-red-* paragraph above the buttons) without crashing the sheet.
  - Accept `setName` as a new prop so the helpers can be called; thread that prop down from the call site in `queue-section.tsx`.
- `packages/monitor-ui/src/components/layout/queue-section.tsx` — In the failed-row block (lines ~178-225), when `isRecoveryPending` is true, render a small icon-button (shadcn `<Button variant="ghost" size="icon">` with a `Play` or `RefreshCw` lucide icon) immediately after the `recovery pending` text. The button calls `triggerRecover(plan.setName, item.id)` and disables itself for ~3 seconds after click to debounce double-presses (the existing 5s polling loop will surface the new sidecar). Pass the new `setName` prop down to `<RecoverySidecarSheet ... setName={plan.setName} />` at its existing render site.

## Verification

- [ ] `pnpm type-check` reports zero errors.
- [ ] `pnpm build` produces a `monitor-ui` bundle without warnings or errors.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` shows `version: "0.13.0"` and includes `"./skills/recover/recover.md"` in the `commands` array; the existing entries are preserved in their original order.
- [ ] `eforge-plugin/skills/recover/recover.md` exists and matches the frontmatter shape of `eforge-plugin/skills/restart/restart.md` (`description` + `disable-model-invocation: true`).
- [ ] `packages/pi-eforge/skills/eforge-recover/SKILL.md` exists and matches the frontmatter shape of `packages/pi-eforge/skills/eforge-restart/SKILL.md` (`name`, `description`, `disable-model-invocation: true`).
- [ ] `packages/monitor-ui/src/lib/api.ts` exports `triggerRecover` and `applyRecovery`; both reference `API_ROUTES.recover` and `API_ROUTES.applyRecovery` respectively (no inlined `/api/...` strings, grep confirms).
- [ ] `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` renders, for a sidecar with `verdict.verdict === 'retry'`, exactly one button labeled `Re-queue PRD` with destructive variant plus one secondary button labeled `Re-run analysis`.
- [ ] Same sheet, for `verdict.verdict === 'split'`, renders exactly one button labeled `Enqueue successor PRD` (default variant) plus the `Re-run analysis` secondary.
- [ ] Same sheet, for `verdict.verdict === 'abandon'`, renders exactly one button labeled `Archive failed PRD` with destructive variant plus the `Re-run analysis` secondary.
- [ ] Same sheet, for `verdict.verdict === 'manual'`, renders zero primary buttons, the literal text `Use /recover in chat to act on this verdict.`, and the `Re-run analysis` secondary.
- [ ] In `queue-section.tsx`, when a failed row has no sidecar yet (`isRecoveryPending` true), an icon-button is rendered immediately after the `recovery pending` text and clicking it calls `triggerRecover(plan.setName, item.id)`.
- [ ] `RecoverySidecarSheet` receives a `setName` prop from its call site in `queue-section.tsx`.
- [ ] Manual end-to-end: trigger an intentionally failing PRD, let the inline recovery write the sidecar, open the sheet, click "Enqueue successor PRD" on a `split` verdict, observe a new PRD lands in `eforge/queue/`, the daemon picks it up, and `git log` shows a `forgeCommit` with subject `recover(<prdId>): enqueue successor <successorPrdId>`.
- [ ] Plugin skill end-to-end: from a fresh Claude Code session, `/recover` lists failed PRDs (via `eforge_status`), reads the sidecar (via `eforge_read_recovery_sidecar`), confirms with the user, and calls `eforge_apply_recovery`.
- [ ] Pi parity: starting `pi-eforge` exposes the `eforge-recover` skill, and the Pi-side `eforge_apply_recovery` MCP tool succeeds end-to-end against a running daemon.
- [ ] No `package.json` version bump in `packages/pi-eforge/` and no `DAEMON_API_VERSION` change.