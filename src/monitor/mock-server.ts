#!/usr/bin/env tsx
/**
 * Mock data server for monitor UI development.
 *
 * Usage: pnpm dev:mock
 * Then: pnpm dev:monitor (Vite proxy forwards /api to :4567)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { startServer } from './server.js';
import type { EforgeEvent } from '../engine/events.js';

const TEMP_DIR = mkdtempSync(join(tmpdir(), 'eforge-mock-'));
const DB_PATH = join(TEMP_DIR, 'monitor.db');

const db = openDatabase(DB_PATH);

// ── Helpers ──

let eventCounter = 0;

function insertEvent(runId: string, event: EforgeEvent, offsetMs = 0): void {
  eventCounter++;
  const planId = 'planId' in event ? (event as { planId?: string }).planId : undefined;
  const agent = 'agent' in event ? (event as { agent?: string }).agent as string : undefined;
  const ts = new Date(Date.now() - 3600_000 + offsetMs).toISOString();
  db.insertEvent({
    runId,
    type: event.type,
    planId: planId ?? undefined,
    agent,
    data: JSON.stringify(event),
    timestamp: ts,
  });
}

function makeTimestamp(offsetMs: number): string {
  return new Date(Date.now() - 3600_000 + offsetMs).toISOString();
}

function agentResult(agent: string, planId?: string): EforgeEvent {
  return {
    type: 'agent:result',
    planId,
    agent: agent as EforgeEvent extends { agent: infer A } ? A : never,
    result: {
      durationMs: 45000 + Math.random() * 30000,
      durationApiMs: 40000 + Math.random() * 25000,
      numTurns: Math.floor(3 + Math.random() * 5),
      totalCostUsd: 0.02 + Math.random() * 0.08,
      usage: { input: 15000 + Math.floor(Math.random() * 20000), output: 3000 + Math.floor(Math.random() * 5000), total: 20000 + Math.floor(Math.random() * 25000) },
      modelUsage: { 'claude-sonnet-4-5-20250514': { inputTokens: 15000, outputTokens: 3000, costUSD: 0.04 } },
    },
  } as unknown as EforgeEvent;
}

// ── Run 1: Completed single-plan (errand) ──

const RUN1_ID = 'mock-errand-completed';
const RUN1_PLAN_SET = 'add-health-check';
db.insertRun({
  id: RUN1_ID,
  planSet: RUN1_PLAN_SET,
  command: 'run',
  status: 'completed',
  startedAt: makeTimestamp(0),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN1_ID, 'completed', makeTimestamp(120_000));

insertEvent(RUN1_ID, { type: 'phase:start', runId: RUN1_ID, planSet: RUN1_PLAN_SET, command: 'compile', timestamp: makeTimestamp(0) }, 0);
insertEvent(RUN1_ID, { type: 'plan:start', source: 'docs/add-health-check.md' }, 1000);
insertEvent(RUN1_ID, { type: 'plan:scope', assessment: 'errand', justification: 'Single endpoint addition with no dependencies' }, 5000);
insertEvent(RUN1_ID, { type: 'plan:progress', message: 'Exploring codebase structure...' }, 10000);
insertEvent(RUN1_ID, { type: 'plan:progress', message: 'Analyzing existing route patterns...' }, 20000);
insertEvent(RUN1_ID, agentResult('planner'), 30000);
insertEvent(RUN1_ID, {
  type: 'plan:complete',
  plans: [{
    id: 'plan-01-health-endpoint',
    name: 'Add Health Check Endpoint',
    dependsOn: [],
    branch: 'plan-01-health-endpoint',
    body: `---
id: plan-01-health-endpoint
name: Add Health Check Endpoint
depends_on: []
branch: plan-01-health-endpoint
---

## Overview
Add a GET /health endpoint that returns service status.

## Implementation Steps
1. Create \`src/routes/health.ts\` with a simple handler returning \`{ status: "ok", timestamp: ... }\`
2. Register the route in \`src/app.ts\`
3. Add tests in \`test/routes/health.test.ts\`

## Acceptance Criteria
- GET /health returns 200 with JSON body
- Response includes \`status\` and \`timestamp\` fields
- Tests cover happy path and response schema
`,
    filePath: '/mock/todo-api/plans/add-health-check/plan-01-health-endpoint.md',
  }],
}, 31000);
insertEvent(RUN1_ID, { type: 'plan:review:start' }, 32000);
insertEvent(RUN1_ID, agentResult('plan-reviewer'), 45000);
insertEvent(RUN1_ID, { type: 'plan:review:complete', issues: [] }, 46000);
insertEvent(RUN1_ID, { type: 'plan:evaluate:start' }, 47000);
insertEvent(RUN1_ID, agentResult('plan-evaluator'), 50000);
insertEvent(RUN1_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 }, 51000);
insertEvent(RUN1_ID, { type: 'build:start', planId: 'plan-01-health-endpoint' }, 55000);
insertEvent(RUN1_ID, { type: 'build:implement:start', planId: 'plan-01-health-endpoint' }, 56000);
insertEvent(RUN1_ID, { type: 'build:implement:progress', planId: 'plan-01-health-endpoint', message: 'Creating health route handler...' }, 65000);
insertEvent(RUN1_ID, { type: 'build:implement:progress', planId: 'plan-01-health-endpoint', message: 'Adding tests...' }, 75000);
insertEvent(RUN1_ID, agentResult('builder', 'plan-01-health-endpoint'), 85000);
insertEvent(RUN1_ID, { type: 'build:implement:complete', planId: 'plan-01-health-endpoint' }, 86000);
insertEvent(RUN1_ID, { type: 'build:files_changed', planId: 'plan-01-health-endpoint', files: ['src/routes/health.ts', 'src/app.ts', 'test/routes/health.test.ts'] }, 87000);
insertEvent(RUN1_ID, { type: 'build:review:start', planId: 'plan-01-health-endpoint' }, 88000);
insertEvent(RUN1_ID, agentResult('reviewer', 'plan-01-health-endpoint'), 95000);
insertEvent(RUN1_ID, { type: 'build:review:complete', planId: 'plan-01-health-endpoint', issues: [{ severity: 'suggestion', category: 'style', file: 'src/routes/health.ts', description: 'Consider adding uptime to health response' }] }, 96000);
insertEvent(RUN1_ID, { type: 'build:evaluate:start', planId: 'plan-01-health-endpoint' }, 97000);
insertEvent(RUN1_ID, agentResult('evaluator', 'plan-01-health-endpoint'), 100000);
insertEvent(RUN1_ID, { type: 'build:evaluate:complete', planId: 'plan-01-health-endpoint', accepted: 1, rejected: 0 }, 101000);
insertEvent(RUN1_ID, { type: 'build:complete', planId: 'plan-01-health-endpoint' }, 102000);
insertEvent(RUN1_ID, { type: 'merge:start', planId: 'plan-01-health-endpoint' }, 103000);
insertEvent(RUN1_ID, { type: 'merge:complete', planId: 'plan-01-health-endpoint' }, 105000);
insertEvent(RUN1_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 106000);
insertEvent(RUN1_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 107000);
insertEvent(RUN1_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 0, output: '' }, 112000);
insertEvent(RUN1_ID, { type: 'validation:command:start', command: 'pnpm test' }, 113000);
insertEvent(RUN1_ID, { type: 'validation:command:complete', command: 'pnpm test', exitCode: 0, output: 'Tests: 12 passed' }, 118000);
insertEvent(RUN1_ID, { type: 'validation:complete', passed: true }, 119000);
insertEvent(RUN1_ID, { type: 'phase:end', runId: RUN1_ID, result: { status: 'completed', summary: '1 plan completed, all validation passed' }, timestamp: makeTimestamp(120000) }, 120000);

// ── Run 2: Completed multi-plan (excursion) with waves ──

const RUN2_ID = 'mock-excursion-completed';
const RUN2_PLAN_SET = 'add-jwt-auth';
db.insertRun({
  id: RUN2_ID,
  planSet: RUN2_PLAN_SET,
  command: 'run',
  status: 'completed',
  startedAt: makeTimestamp(200_000),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN2_ID, 'completed', makeTimestamp(500_000));

insertEvent(RUN2_ID, { type: 'phase:start', runId: RUN2_ID, planSet: RUN2_PLAN_SET, command: 'compile', timestamp: makeTimestamp(200000) }, 200000);
insertEvent(RUN2_ID, { type: 'plan:start', source: 'docs/add-jwt-auth.md' }, 201000);
insertEvent(RUN2_ID, { type: 'plan:scope', assessment: 'excursion', justification: 'Multi-file auth middleware + protected routes + tests' }, 210000);
insertEvent(RUN2_ID, agentResult('planner'), 240000);
insertEvent(RUN2_ID, {
  type: 'plan:complete',
  plans: [
    {
      id: 'plan-01-auth-middleware',
      name: 'JWT Auth Middleware',
      dependsOn: [],
      branch: 'plan-01-auth-middleware',
      body: `---
id: plan-01-auth-middleware
name: JWT Auth Middleware
depends_on: []
branch: plan-01-auth-middleware
---

## Overview
Create JWT verification middleware.

## Steps
1. Install jsonwebtoken dependency
2. Create \`src/middleware/auth.ts\` with JWT verification
3. Add auth config to environment
4. Unit tests for token validation
`,
      filePath: '/mock/plans/add-jwt-auth/plan-01-auth-middleware.md',
    },
    {
      id: 'plan-02-protected-routes',
      name: 'Protected Routes',
      dependsOn: ['plan-01-auth-middleware'],
      branch: 'plan-02-protected-routes',
      body: `---
id: plan-02-protected-routes
name: Protected Routes
depends_on: [plan-01-auth-middleware]
branch: plan-02-protected-routes
---

## Overview
Apply auth middleware to existing CRUD routes.

## Steps
1. Add auth middleware to todo routes
2. Update route handlers to use \`req.user\`
3. Integration tests with mock tokens
`,
      filePath: '/mock/plans/add-jwt-auth/plan-02-protected-routes.md',
    },
    {
      id: 'plan-03-login-endpoint',
      name: 'Login Endpoint',
      dependsOn: ['plan-01-auth-middleware'],
      branch: 'plan-03-login-endpoint',
      body: `---
id: plan-03-login-endpoint
name: Login Endpoint
depends_on: [plan-01-auth-middleware]
branch: plan-03-login-endpoint
---

## Overview
Add POST /auth/login endpoint that issues JWTs.

## Steps
1. Create \`src/routes/auth.ts\` with login handler
2. Add user lookup (hardcoded for now)
3. Return signed JWT on valid credentials
4. Tests for login flow
`,
      filePath: '/mock/plans/add-jwt-auth/plan-03-login-endpoint.md',
    },
  ],
}, 241000);
insertEvent(RUN2_ID, { type: 'plan:review:start' }, 242000);
insertEvent(RUN2_ID, agentResult('plan-reviewer'), 260000);
insertEvent(RUN2_ID, { type: 'plan:review:complete', issues: [{ severity: 'suggestion', category: 'completeness', file: 'plan-02-protected-routes', description: 'Consider adding rate limiting to auth endpoints' }] }, 261000);
insertEvent(RUN2_ID, { type: 'plan:evaluate:start' }, 262000);
insertEvent(RUN2_ID, agentResult('plan-evaluator'), 270000);
insertEvent(RUN2_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 1 }, 271000);

// Wave 1: auth middleware (no deps)
insertEvent(RUN2_ID, { type: 'wave:start', wave: 1, planIds: ['plan-01-auth-middleware'] }, 280000);
insertEvent(RUN2_ID, { type: 'build:start', planId: 'plan-01-auth-middleware' }, 281000);
insertEvent(RUN2_ID, { type: 'build:implement:start', planId: 'plan-01-auth-middleware' }, 282000);
insertEvent(RUN2_ID, agentResult('builder', 'plan-01-auth-middleware'), 310000);
insertEvent(RUN2_ID, { type: 'build:implement:complete', planId: 'plan-01-auth-middleware' }, 311000);
insertEvent(RUN2_ID, { type: 'build:files_changed', planId: 'plan-01-auth-middleware', files: ['src/middleware/auth.ts', 'src/config.ts', 'test/middleware/auth.test.ts', 'package.json'] }, 312000);
insertEvent(RUN2_ID, { type: 'build:review:start', planId: 'plan-01-auth-middleware' }, 313000);
insertEvent(RUN2_ID, agentResult('reviewer', 'plan-01-auth-middleware'), 325000);
insertEvent(RUN2_ID, { type: 'build:review:complete', planId: 'plan-01-auth-middleware', issues: [] }, 326000);
insertEvent(RUN2_ID, { type: 'build:evaluate:start', planId: 'plan-01-auth-middleware' }, 327000);
insertEvent(RUN2_ID, agentResult('evaluator', 'plan-01-auth-middleware'), 333000);
insertEvent(RUN2_ID, { type: 'build:evaluate:complete', planId: 'plan-01-auth-middleware', accepted: 0, rejected: 0 }, 334000);
insertEvent(RUN2_ID, { type: 'build:complete', planId: 'plan-01-auth-middleware' }, 335000);
insertEvent(RUN2_ID, { type: 'merge:start', planId: 'plan-01-auth-middleware' }, 336000);
insertEvent(RUN2_ID, { type: 'merge:complete', planId: 'plan-01-auth-middleware' }, 338000);
insertEvent(RUN2_ID, { type: 'wave:complete', wave: 1 }, 339000);

// Wave 2: protected routes + login (both depend on auth middleware)
insertEvent(RUN2_ID, { type: 'wave:start', wave: 2, planIds: ['plan-02-protected-routes', 'plan-03-login-endpoint'] }, 340000);

// Plan 2: protected routes
insertEvent(RUN2_ID, { type: 'build:start', planId: 'plan-02-protected-routes' }, 341000);
insertEvent(RUN2_ID, { type: 'build:implement:start', planId: 'plan-02-protected-routes' }, 342000);
insertEvent(RUN2_ID, agentResult('builder', 'plan-02-protected-routes'), 380000);
insertEvent(RUN2_ID, { type: 'build:implement:complete', planId: 'plan-02-protected-routes' }, 381000);
insertEvent(RUN2_ID, { type: 'build:files_changed', planId: 'plan-02-protected-routes', files: ['src/routes/todos.ts', 'test/routes/todos.test.ts'] }, 382000);
insertEvent(RUN2_ID, { type: 'build:review:start', planId: 'plan-02-protected-routes' }, 383000);
insertEvent(RUN2_ID, agentResult('reviewer', 'plan-02-protected-routes'), 395000);
insertEvent(RUN2_ID, { type: 'build:review:complete', planId: 'plan-02-protected-routes', issues: [] }, 396000);
insertEvent(RUN2_ID, { type: 'build:evaluate:start', planId: 'plan-02-protected-routes' }, 397000);
insertEvent(RUN2_ID, agentResult('evaluator', 'plan-02-protected-routes'), 403000);
insertEvent(RUN2_ID, { type: 'build:evaluate:complete', planId: 'plan-02-protected-routes', accepted: 0, rejected: 0 }, 404000);
insertEvent(RUN2_ID, { type: 'build:complete', planId: 'plan-02-protected-routes' }, 405000);

// Plan 3: login endpoint (parallel with plan 2)
insertEvent(RUN2_ID, { type: 'build:start', planId: 'plan-03-login-endpoint' }, 342000);
insertEvent(RUN2_ID, { type: 'build:implement:start', planId: 'plan-03-login-endpoint' }, 343000);
insertEvent(RUN2_ID, agentResult('builder', 'plan-03-login-endpoint'), 370000);
insertEvent(RUN2_ID, { type: 'build:implement:complete', planId: 'plan-03-login-endpoint' }, 371000);
insertEvent(RUN2_ID, { type: 'build:files_changed', planId: 'plan-03-login-endpoint', files: ['src/routes/auth.ts', 'src/app.ts', 'test/routes/auth.test.ts'] }, 372000);
insertEvent(RUN2_ID, { type: 'build:review:start', planId: 'plan-03-login-endpoint' }, 373000);
insertEvent(RUN2_ID, agentResult('reviewer', 'plan-03-login-endpoint'), 385000);
insertEvent(RUN2_ID, { type: 'build:review:complete', planId: 'plan-03-login-endpoint', issues: [{ severity: 'warning', category: 'security', file: 'src/routes/auth.ts', line: 15, description: 'JWT secret should not be hardcoded' }] }, 386000);
insertEvent(RUN2_ID, { type: 'build:evaluate:start', planId: 'plan-03-login-endpoint' }, 387000);
insertEvent(RUN2_ID, agentResult('evaluator', 'plan-03-login-endpoint'), 393000);
insertEvent(RUN2_ID, { type: 'build:evaluate:complete', planId: 'plan-03-login-endpoint', accepted: 1, rejected: 0 }, 394000);
insertEvent(RUN2_ID, { type: 'build:complete', planId: 'plan-03-login-endpoint' }, 395000);

// Merge wave 2 in topological order
insertEvent(RUN2_ID, { type: 'merge:start', planId: 'plan-02-protected-routes' }, 410000);
insertEvent(RUN2_ID, { type: 'merge:complete', planId: 'plan-02-protected-routes' }, 412000);
insertEvent(RUN2_ID, { type: 'merge:start', planId: 'plan-03-login-endpoint' }, 413000);
insertEvent(RUN2_ID, { type: 'merge:complete', planId: 'plan-03-login-endpoint' }, 415000);
insertEvent(RUN2_ID, { type: 'wave:complete', wave: 2 }, 416000);

// Validation
insertEvent(RUN2_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 420000);
insertEvent(RUN2_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 421000);
insertEvent(RUN2_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 0, output: '' }, 430000);
insertEvent(RUN2_ID, { type: 'validation:command:start', command: 'pnpm test' }, 431000);
insertEvent(RUN2_ID, { type: 'validation:command:complete', command: 'pnpm test', exitCode: 0, output: 'Tests: 24 passed' }, 445000);
insertEvent(RUN2_ID, { type: 'validation:complete', passed: true }, 446000);
insertEvent(RUN2_ID, { type: 'phase:end', runId: RUN2_ID, result: { status: 'completed', summary: '3 plans completed, all validation passed' }, timestamp: makeTimestamp(500000) }, 500000);

// ── Run 3: Failed build ──

const RUN3_ID = 'mock-failed-build';
const RUN3_PLAN_SET = 'add-rate-limiting';
db.insertRun({
  id: RUN3_ID,
  planSet: RUN3_PLAN_SET,
  command: 'run',
  status: 'failed',
  startedAt: makeTimestamp(600_000),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN3_ID, 'failed', makeTimestamp(700_000));

insertEvent(RUN3_ID, { type: 'phase:start', runId: RUN3_ID, planSet: RUN3_PLAN_SET, command: 'compile', timestamp: makeTimestamp(600000) }, 600000);
insertEvent(RUN3_ID, { type: 'plan:start', source: 'docs/add-rate-limiting.md' }, 601000);
insertEvent(RUN3_ID, { type: 'plan:scope', assessment: 'errand', justification: 'Single middleware addition' }, 610000);
insertEvent(RUN3_ID, agentResult('planner'), 630000);
insertEvent(RUN3_ID, {
  type: 'plan:complete',
  plans: [{
    id: 'plan-01-rate-limiter',
    name: 'Rate Limiting Middleware',
    dependsOn: [],
    branch: 'plan-01-rate-limiter',
    body: `---
id: plan-01-rate-limiter
name: Rate Limiting Middleware
depends_on: []
branch: plan-01-rate-limiter
---

## Overview
Add express-rate-limit middleware to API endpoints.
`,
    filePath: '/mock/plans/add-rate-limiting/plan-01-rate-limiter.md',
  }],
}, 631000);
insertEvent(RUN3_ID, { type: 'plan:review:start' }, 632000);
insertEvent(RUN3_ID, agentResult('plan-reviewer'), 645000);
insertEvent(RUN3_ID, { type: 'plan:review:complete', issues: [] }, 646000);
insertEvent(RUN3_ID, { type: 'plan:evaluate:start' }, 647000);
insertEvent(RUN3_ID, agentResult('plan-evaluator'), 652000);
insertEvent(RUN3_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 }, 653000);
insertEvent(RUN3_ID, { type: 'build:start', planId: 'plan-01-rate-limiter' }, 660000);
insertEvent(RUN3_ID, { type: 'build:implement:start', planId: 'plan-01-rate-limiter' }, 661000);
insertEvent(RUN3_ID, { type: 'build:implement:progress', planId: 'plan-01-rate-limiter', message: 'Installing express-rate-limit...' }, 665000);
insertEvent(RUN3_ID, { type: 'build:failed', planId: 'plan-01-rate-limiter', error: 'Agent exceeded maximum turns (10). The implementation was not completed.' }, 690000);
insertEvent(RUN3_ID, { type: 'phase:end', runId: RUN3_ID, result: { status: 'failed', summary: 'Build failed: plan-01-rate-limiter — agent exceeded max turns' }, timestamp: makeTimestamp(700000) }, 700000);

// ── Run 4: Currently running (simulated) ──

const RUN4_ID = 'mock-running-build';
const RUN4_PLAN_SET = 'add-pagination';
db.insertRun({
  id: RUN4_ID,
  planSet: RUN4_PLAN_SET,
  command: 'run',
  status: 'running',
  startedAt: new Date().toISOString(),
  cwd: '/mock/todo-api',
});

const now = Date.now();
function runTs(ms: number): string { return new Date(now - 60_000 + ms).toISOString(); }

db.insertEvent({ runId: RUN4_ID, type: 'phase:start', data: JSON.stringify({ type: 'phase:start', runId: RUN4_ID, planSet: RUN4_PLAN_SET, command: 'compile', timestamp: runTs(0) }), timestamp: runTs(0) });
db.insertEvent({ runId: RUN4_ID, type: 'plan:start', data: JSON.stringify({ type: 'plan:start', source: 'docs/add-pagination.md' }), timestamp: runTs(2000) });
db.insertEvent({ runId: RUN4_ID, type: 'plan:scope', data: JSON.stringify({ type: 'plan:scope', assessment: 'excursion', justification: 'Pagination touches list routes + query parsing + tests' }), timestamp: runTs(8000) });
db.insertEvent({ runId: RUN4_ID, type: 'plan:progress', data: JSON.stringify({ type: 'plan:progress', message: 'Exploring existing route patterns and query handling...' }), timestamp: runTs(15000) });

// Trickle in events for the running run
const liveEvents: Array<{ delay: number; event: Record<string, unknown> }> = [
  { delay: 5000, event: { type: 'plan:progress', message: 'Analyzing pagination strategies (cursor vs offset)...' } },
  { delay: 12000, event: { type: 'plan:progress', message: 'Drafting plan files...' } },
  { delay: 20000, event: agentResult('planner') },
  { delay: 21000, event: {
    type: 'plan:complete',
    plans: [{
      id: 'plan-01-pagination-core',
      name: 'Pagination Core',
      dependsOn: [],
      branch: 'plan-01-pagination-core',
      body: '---\nid: plan-01-pagination-core\nname: Pagination Core\ndepends_on: []\nbranch: plan-01-pagination-core\n---\n\n## Overview\nAdd cursor-based pagination to list endpoints.\n',
      filePath: '/mock/plans/add-pagination/plan-01-pagination-core.md',
    }, {
      id: 'plan-02-pagination-ui',
      name: 'Pagination Response Format',
      dependsOn: ['plan-01-pagination-core'],
      branch: 'plan-02-pagination-ui',
      body: '---\nid: plan-02-pagination-ui\nname: Pagination Response Format\ndepends_on: [plan-01-pagination-core]\nbranch: plan-02-pagination-ui\n---\n\n## Overview\nStandardize paginated response envelope.\n',
      filePath: '/mock/plans/add-pagination/plan-02-pagination-ui.md',
    }],
  } },
  { delay: 25000, event: { type: 'plan:review:start' } },
  { delay: 40000, event: agentResult('plan-reviewer') },
  { delay: 41000, event: { type: 'plan:review:complete', issues: [] } },
  { delay: 42000, event: { type: 'plan:evaluate:start' } },
  { delay: 48000, event: agentResult('plan-evaluator') },
  { delay: 49000, event: { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 } },
  { delay: 52000, event: { type: 'wave:start', wave: 1, planIds: ['plan-01-pagination-core'] } },
  { delay: 53000, event: { type: 'build:start', planId: 'plan-01-pagination-core' } },
  { delay: 54000, event: { type: 'build:implement:start', planId: 'plan-01-pagination-core' } },
  { delay: 65000, event: { type: 'build:implement:progress', planId: 'plan-01-pagination-core', message: 'Creating pagination utility...' } },
  { delay: 80000, event: { type: 'build:implement:progress', planId: 'plan-01-pagination-core', message: 'Adding cursor decoding...' } },
];

// ── Start server ──

console.log('Starting mock monitor server...');
const server = await startServer(db, 4567, { strictPort: true });
console.log(`Mock monitor: ${server.url}`);
console.log(`\nPopulated ${eventCounter} events across 4 runs:`);
console.log(`  ${RUN1_PLAN_SET} (completed, 1 plan)`);
console.log(`  ${RUN2_PLAN_SET} (completed, 3 plans, 2 waves)`);
console.log(`  ${RUN3_PLAN_SET} (failed)`);
console.log(`  ${RUN4_PLAN_SET} (running, live events)`);
console.log('\nRun "pnpm dev:monitor" in another terminal for the UI.\n');

// Trickle live events for the running run
let liveIndex = 0;
function tickleNextEvent(): void {
  if (liveIndex >= liveEvents.length) return;
  const { delay, event } = liveEvents[liveIndex];
  setTimeout(() => {
    const ts = new Date().toISOString();
    const type = (event as { type: string }).type;
    const planId = (event as { planId?: string }).planId;
    const agent = (event as { agent?: string }).agent;
    db.insertEvent({
      runId: RUN4_ID,
      type,
      planId: planId ?? undefined,
      agent: agent ?? undefined,
      data: JSON.stringify(event),
      timestamp: ts,
    });
    console.log(`  [live] ${type}${planId ? ` (${planId})` : ''}`);
    liveIndex++;
    tickleNextEvent();
  }, liveIndex === 0 ? delay : liveEvents[liveIndex].delay - (liveEvents[liveIndex - 1]?.delay ?? 0));
}
tickleNextEvent();

// Keep alive
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await server.stop();
  db.close();
  try { rmSync(TEMP_DIR, { recursive: true }); } catch {}
  process.exit(0);
});
