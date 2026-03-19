---
id: plan-01-lockfile-url
name: Read monitor lockfile for actual URL in run skill
dependsOn: []
branch: fix-use-actual-monitor-url-from-lockfile-in-run-skill/lockfile-url
---

# Read monitor lockfile for actual URL in run skill

## Architecture Context

The eforge monitor server writes its actual bound port to `.eforge/monitor.lock` (JSON with `pid`, `port`, `startedAt` fields) via `src/monitor/lockfile.ts`. When port 4567 is already in use, the server binds to the next available port - but the `/eforge:run` skill hardcodes `http://localhost:4567` in three places, giving users a broken link.

## Implementation

### Overview

Add a new step between Launch (Step 2) and Monitor (Step 3) in the run skill that sleeps ~3 seconds, reads `.eforge/monitor.lock`, parses the JSON, and constructs the URL. Replace all three hardcoded URLs with the dynamic value. Bump the plugin version.

### Key Decisions

1. **3-second wait before reading lockfile** - The monitor server starts as a background subprocess and needs time to bind a port and write the lockfile. 3 seconds is sufficient based on the monitor's startup sequence (the `hasSeenActivity` gate in the monitor can take longer, but the lockfile is written at server bind time, not at first event).
2. **Fall back to `http://localhost:4567` if lockfile is missing/unreadable** - Graceful degradation so the skill never fails to report a URL. This matches the current behavior when the lockfile doesn't exist.
3. **Use Read tool + JSON parsing in the skill markdown** - The skill is a Claude Code skill (markdown instructions for Claude), so the "code" is instructional prose telling Claude to use its Read tool and parse the JSON. No TypeScript changes needed.

## Scope

### In Scope
- New "Step 3: Resolve Monitor URL" between current Step 2 and Step 3
- Replace all three hardcoded `http://localhost:4567` references with `{MONITOR_URL}` derived from lockfile
- Fallback to `http://localhost:4567` when lockfile is absent
- Version bump in `eforge-plugin/.claude-plugin/plugin.json`

### Out of Scope
- Changes to the monitor server or lockfile writing logic
- Changes to engine or CLI code

## Files

### Modify
- `eforge-plugin/skills/run/run.md` — Add lockfile-reading step between Step 2 (Launch) and Step 3 (Monitor). Replace three hardcoded `http://localhost:4567` URLs with the dynamically resolved URL. Renumber Step 3 → Step 4.
- `eforge-plugin/.claude-plugin/plugin.json` — Bump version from `1.7.0` to `1.7.1`

## Verification

- [ ] `eforge-plugin/skills/run/run.md` contains a step that reads `.eforge/monitor.lock` using the Read tool
- [ ] `eforge-plugin/skills/run/run.md` includes a ~3 second sleep/wait before reading the lockfile
- [ ] `eforge-plugin/skills/run/run.md` includes fallback to `http://localhost:4567` when lockfile is missing or unreadable
- [ ] Zero occurrences of hardcoded `http://localhost:4567` remain in the Monitor step of `eforge-plugin/skills/run/run.md`
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is `1.7.1`
