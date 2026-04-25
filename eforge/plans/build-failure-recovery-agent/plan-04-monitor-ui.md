---
id: plan-04-monitor-ui
name: "Monitor UI: Verdict Chip + Sidecar Link"
depends_on:
  - plan-03-daemon-mcp-pi
branch: build-failure-recovery-agent/monitor-ui
agents:
  builder:
    effort: medium
    rationale: Localized UI work in two components; shadcn/ui patterns already
      established in the codebase.
---

# Monitor UI: Verdict Chip + Sidecar Link

## Architecture Context

This plan surfaces recovery verdicts in the monitor UI. The failed-build view (queue section + event timeline) reads the JSON sidecar via the new `apiReadRecoverySidecar` route (added in plan-03) and renders a verdict + confidence chip plus a link to the markdown sidecar.

Key constraints:
- **shadcn/ui only** per the AGENTS.md UI rule.
- **Read-only display.** The UI does not trigger recovery (the daemon does that automatically) and does not act on verdicts.
- **Typed display fields from JSON twin.** Markdown is for humans; JSON is what the UI reads to render typed chips.
- **Failed PRDs are already enumerated by the queue endpoint** (`server.ts:669`, `loadFromDir(resolve(queueDir, 'failed'), 'failed')`). The UI checks for sidecar presence by attempting the read and showing a chip if successful.

## Implementation

### Overview

1. Extend the queue-section component (`packages/monitor-ui/src/components/layout/queue-section.tsx`) so that for each item with `status === 'failed'`, the UI fetches the sidecar JSON via `apiReadRecoverySidecar({ setName, prdId })` and renders a verdict chip + confidence dot. If the fetch returns 404 (recovery not yet run or pending), render a subtle "recovery pending" indicator instead.
2. Add a `RecoveryVerdictChip` shadcn-styled component (use `Badge` + variant) with color mapping: `retry` → blue, `split` → amber, `abandon` → red, `manual` → gray. Confidence rendered as a small dot or text suffix (`high` / `medium` / `low`).
3. Add a sidecar link (`Button` variant `link` or `Anchor`) that opens the markdown sidecar. Open path: a new `GET /api/recovery/sidecar/markdown` route is **not** added; instead the existing `readRecoverySidecar` route returns markdown alongside JSON, and the UI renders the markdown in a shadcn `Sheet` or `Dialog` component on click.
4. Extend the event-card component (`packages/monitor-ui/src/components/timeline/event-card.tsx`) so that `recovery:complete` and `recovery:error` events render with the verdict chip inline.
5. Poll cadence: queue-section already polls every 5s (`queue-section.tsx:62`); piggyback on that polling for sidecar fetches (debounced, only failed items).

### Key Decisions

1. **Reuse `apiReadRecoverySidecar` for both JSON + markdown.** plan-03's response shape returns both; UI does not need a separate route.
2. **shadcn `Sheet` for sidecar markdown view.** Matches existing UI patterns; markdown rendered with the project's existing markdown component (or a minimal shadcn-friendly renderer).
3. **Fail-soft fetch.** A 404 is normal (recovery hasn't run yet, or sidecar deleted manually). UI shows a neutral indicator and never blocks the queue rendering.
4. **No new API routes.** Plan-03 already provides everything the UI needs.

## Scope

### In Scope
- `RecoveryVerdictChip` component (shadcn-based).
- `RecoverySidecarSheet` component (shadcn `Sheet`) showing the markdown sidecar.
- Queue-section integration: fetch sidecar JSON for failed items, render chip + link.
- Event-card integration: render verdict chip for `recovery:complete` and surface `recovery:error` rationale.
- Tests: component-level snapshot or render tests for the chip per verdict + confidence pair (using vitest + the project's existing UI test setup).

### Out of Scope
- New API routes (plan-03 covers them).
- Triggering recovery from the UI (intentionally out of scope per PRD).
- Acting on verdicts (deferred per PRD).
- Pi extension UI surfaces beyond the MCP tools added in plan-03.

## Files

### Create
- `packages/monitor-ui/src/components/recovery/verdict-chip.tsx` — shadcn `Badge`-based chip.
- `packages/monitor-ui/src/components/recovery/sidecar-sheet.tsx` — shadcn `Sheet` rendering markdown sidecar.
- `packages/monitor-ui/src/components/recovery/__tests__/verdict-chip.test.tsx` — render test per verdict.

### Modify
- `packages/monitor-ui/src/components/layout/queue-section.tsx` — for `status === 'failed'` items, fetch sidecar via `apiReadRecoverySidecar` and render `RecoveryVerdictChip` + sidecar-sheet trigger.
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — handle `recovery:start | recovery:summary | recovery:complete | recovery:error` event types with verdict chip + concise rationale.
- `packages/monitor-ui/src/lib/api.ts` (or wherever the browser fetch transport lives) — ensure it dispatches `recover` and `readRecoverySidecar` via `API_ROUTES` + `buildPath()` per AGENTS.md (no inlined `/api/...` strings).

### Files to reuse
- `packages/client/src/api/recovery-sidecar.ts` (plan-03) — typed helper.
- `packages/client/src/routes.ts` `API_ROUTES` + `buildPath()`.
- Existing shadcn primitives in `packages/monitor-ui/src/components/ui/`.

## Verification

- [ ] `pnpm type-check` passes in `packages/monitor-ui`.
- [ ] `pnpm test` passes; chip render test asserts color mapping for all four verdicts.
- [ ] In a dev daemon with a fixture failed PRD that has a `recovery.json` sidecar, opening the queue section renders a verdict chip whose text matches the JSON `verdict` field (manual visual check noted as a verification gate; automated where the test harness supports it).
- [ ] Queue-section continues to render even when the sidecar fetch returns 404 (asserted by mocking the fetch transport to return 404).
- [ ] No `/api/...` literal strings introduced in `packages/monitor-ui/src/`; all paths flow through `API_ROUTES` + `buildPath()` (grep assertion in test).
- [ ] Event-card renders `recovery:complete` events with the verdict chip (snapshot test).
- [ ] All new components use shadcn primitives (Badge, Sheet, Button) — no custom UI primitives introduced.
