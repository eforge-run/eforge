# Recovery Analysis: replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack

**Generated:** 2026-04-28T19:28:56.355Z
**Set:** replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack
**Feature Branch:** `eforge/replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack`
**Base Branch:** `main`
**Failed At:** 2026-04-28T19:27:22.148Z

## Verdict

**MANUAL** (confidence: low)

**⚠ Partial summary** — context was incomplete: Claude Code process aborted by user

## Rationale

Recovery analyst failed or timed out.

## Plans

| Plan | Status | Error |
|------|--------|-------|
| plan-01-rename-backend-to-harness | failed | Shard coordinator verification failed (pnpm test): > eforge-monorepo@ test /Users/markschaake/projects/eforge-build/eforge-replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack-worktrees/__merge__ > node scripts/check-skill-parity.mjs && vitest run ✓ profile ↔ eforge-profile ✓ profile-new ↔ eforge-profile-new ✓ build ↔ eforge-build ✓ config ↔ eforge-config ✓ init ↔ eforge-init ✓ plan ↔ eforge-plan ✓ restart ↔ eforge-restart ✓ status ↔ eforge-status ✓ update ↔ eforge-update 9/9 pairs in sync.  RUN  v4.1.5 /Users/markschaake/projects/eforge-build/eforge-replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack-worktrees/__merge__  ❯ test/daemon-recovery.test.ts (14 tests \| 1 failed) 927ms      × is 9 4ms  Test Files  1 failed \| 112 passed (113)       Tests  1 failed \| 1886 passed (1887)    Start at  12:27:16    Duration  5.80s (transform 4.82s, setup 0ms, import 13.71s, tests 34.43s, environment 6ms)  ELIFECYCLE  Test failed. See above for more details. (node:1602) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) (node:1600) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) (node:1596) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) (node:1606) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) (node:1708) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) [eforge] Migrated eforge/backends/ -> eforge/profiles/ [eforge] Migrated .active-backend -> .active-profile [eforge] Both eforge/backends/ and eforge/profiles/ exist. Migration skipped; please resolve manually and remove eforge/backends/. [eforge] Migrated ~/.config/eforge/backends/ -> ~/.config/eforge/profiles/ [eforge] Migrated ~/.config/eforge/.active-backend -> .active-profile [eforge] Both ~/.config/eforge/backends/ and ~/.config/eforge/profiles/ exist. Migration skipped; please resolve manually and remove ~/.config/eforge/backends/. [eforge] Migrated orphaned ~/.config/eforge/.active-backend -> .active-profile [eforge] Migrated orphaned eforge/.active-backend -> .active-profile (node:1746) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' (node:4967) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) Switched to a new branch 'eforge/test-recovery-set' Switched to a new branch 'feature' Switched to branch 'main' Switched to a new branch 'eforge/test-recovery-set' Switched to a new branch 'feature' Switched to branch 'main' (node:7098) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) Switched to a new branch 'eforge/test-recovery-set' Switched to a new branch 'feature' Switched to branch 'main' (node:9074) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' (node:10613) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' (node:12189) ExperimentalWarning: SQLite is an experimental feature and might change at any time (Use `node --trace-warnings ...` to show where the warning was created) Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' Switched to a new branch 'feature' Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' Switched to a new branch 'feature' Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'feature' Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' Switched to a new branch 'eforge/test-recovery-set' Switched to branch 'main' ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯  FAIL  test/daemon-recovery.test.ts > DAEMON_API_VERSION > is 9 AssertionError: expected 10 to be 9 // Object.is equality - Expected + Received - 9 + 10  ❯ test/daemon-recovery.test.ts:132:32     130\| describe('DAEMON_API_VERSION', () => {     131\|   it('is 9', () => {     132\|     expect(DAEMON_API_VERSION).toBe(9);        \|                                ^     133\|   });     134\| }); ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯ |

## Failing Plan

**Plan ID:** plan-01-rename-backend-to-harness
**Error:** Shard coordinator verification failed (pnpm test): > eforge-monorepo@ test /Users/markschaake/projects/eforge-build/eforge-replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack-worktrees/__merge__
> node scripts/check-skill-parity.mjs && vitest run

✓ profile ↔ eforge-profile
✓ profile-new ↔ eforge-profile-new
✓ build ↔ eforge-build
✓ config ↔ eforge-config
✓ init ↔ eforge-init
✓ plan ↔ eforge-plan
✓ restart ↔ eforge-restart
✓ status ↔ eforge-status
✓ update ↔ eforge-update

9/9 pairs in sync.

 RUN  v4.1.5 /Users/markschaake/projects/eforge-build/eforge-replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack-worktrees/__merge__

 ❯ test/daemon-recovery.test.ts (14 tests | 1 failed) 927ms
     × is 9 4ms

 Test Files  1 failed | 112 passed (113)
      Tests  1 failed | 1886 passed (1887)
   Start at  12:27:16
   Duration  5.80s (transform 4.82s, setup 0ms, import 13.71s, tests 34.43s, environment 6ms)

 ELIFECYCLE  Test failed. See above for more details.
(node:1602) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1600) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1596) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1606) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
(node:1708) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
[eforge] Migrated eforge/backends/ -> eforge/profiles/
[eforge] Migrated .active-backend -> .active-profile
[eforge] Both eforge/backends/ and eforge/profiles/ exist. Migration skipped; please resolve manually and remove eforge/backends/.
[eforge] Migrated ~/.config/eforge/backends/ -> ~/.config/eforge/profiles/
[eforge] Migrated ~/.config/eforge/.active-backend -> .active-profile
[eforge] Both ~/.config/eforge/backends/ and ~/.config/eforge/profiles/ exist. Migration skipped; please resolve manually and remove ~/.config/eforge/backends/.
[eforge] Migrated orphaned ~/.config/eforge/.active-backend -> .active-profile
[eforge] Migrated orphaned eforge/.active-backend -> .active-profile
(node:1746) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
(node:4967) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Switched to a new branch 'eforge/test-recovery-set'
Switched to a new branch 'feature'
Switched to branch 'main'
Switched to a new branch 'eforge/test-recovery-set'
Switched to a new branch 'feature'
Switched to branch 'main'
(node:7098) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Switched to a new branch 'eforge/test-recovery-set'
Switched to a new branch 'feature'
Switched to branch 'main'
(node:9074) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
(node:10613) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
(node:12189) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
Switched to a new branch 'feature'
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
Switched to a new branch 'feature'
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'feature'
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'
Switched to a new branch 'eforge/test-recovery-set'
Switched to branch 'main'

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/daemon-recovery.test.ts > DAEMON_API_VERSION > is 9
AssertionError: expected 10 to be 9 // Object.is equality

- Expected
+ Received

- 9
+ 10

 ❯ test/daemon-recovery.test.ts:132:32
    130| describe('DAEMON_API_VERSION', () => {
    131|   it('is 9', () => {
    132|     expect(DAEMON_API_VERSION).toBe(9);
       |                                ^
    133|   });
    134| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

## Landed Commits

| SHA | Subject | Author | Date |
|-----|---------|--------|------|
| `35ae20b2` | plan(replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack): initial planning artifacts | Mark Schaake | 2026-04-28T12:15:20-07:00 |
| `d313cb16` | plan(replace-backend-with-harness-across-the-eforge-mcp-http-skill-stack): initial planning artifacts | Mark Schaake | 2026-04-28T11:34:15-07:00 |

## Models Used

- claude-opus-4-7

## Diff Stat

```
.../orchestration.yaml                             | 100 ++++++++++++++
 .../plan-01-rename-backend-to-harness.md           | 152 +++++++++++++++++++++
 2 files changed, 252 insertions(+)
```
