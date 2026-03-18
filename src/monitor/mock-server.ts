#!/usr/bin/env tsx
/**
 * Mock data server for monitor UI development.
 *
 * Usage: pnpm dev:mock
 * Then: pnpm dev:monitor (Vite proxy forwards /api to :4567)
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.js';
import { startServer } from './server.js';
import type { EforgeEvent } from '../engine/events.js';

const TEMP_DIR = mkdtempSync(join(tmpdir(), 'eforge-mock-'));
const DB_PATH = join(TEMP_DIR, 'monitor.db');

// Write mock expedition plan files to disk so servePlans() can read them
const MOCK_PLAN_DIR = join(TEMP_DIR, 'plans', 'build-notification-system');
mkdirSync(join(MOCK_PLAN_DIR, 'modules'), { recursive: true });

writeFileSync(join(MOCK_PLAN_DIR, 'architecture.md'), `# Notification System Architecture

## Overview

A multi-module notification system that provides a data model for storing notifications, an email delivery provider with template rendering and retry logic, and REST API endpoints for managing notifications.

## Module Dependency Graph

\`\`\`
notification-model (foundation)
├── email-provider (depends on model)
└── notification-api (depends on model)
\`\`\`

## Cross-Cutting Concerns

- **Error handling**: All modules should use shared error types from the model layer
- **Type safety**: Notification types defined in model module are the single source of truth
- **Testing**: Each module should have unit tests; integration tests validate cross-module flows

## Data Flow

1. API receives notification request via REST endpoints
2. Notification is persisted via the model layer
3. Email provider picks up pending notifications and delivers them
4. Delivery status is updated back in the model

## Key Decisions

- Email provider uses a retry queue with exponential backoff
- API supports pagination for listing notifications
- Model uses a migration-based schema approach
`);

writeFileSync(join(MOCK_PLAN_DIR, 'modules', 'notification-model.md'), `## Notification Model Module

### Scope
Core notification data model, storage layer, and CRUD operations.

### Implementation Details

1. **Schema** (\`src/models/notification.ts\`)
   - \`Notification\` interface: id, userId, type, title, body, status, createdAt, readAt
   - \`NotificationStatus\` enum: pending, sent, failed, read
   - \`CreateNotificationInput\` type for validated input

2. **Database Migration** (\`src/db/migrations/001-notifications.sql\`)
   - Create \`notifications\` table with indexes on userId and status
   - Add \`notification_templates\` table for reusable templates

3. **Repository** (\`src/db/notification-repo.ts\`)
   - \`create(input)\`: Insert new notification
   - \`findById(id)\`: Get single notification
   - \`findByUser(userId, opts)\`: Paginated listing
   - \`markAsRead(id)\`: Update status and readAt timestamp
   - \`updateStatus(id, status)\`: Generic status update

### Dependencies
None - this is the foundation module.

### Verification
- Unit tests for repository methods
- Migration runs cleanly on empty database
`);

writeFileSync(join(MOCK_PLAN_DIR, 'modules', 'email-provider.md'), `## Email Provider Module

### Scope
Email delivery provider with template rendering and retry logic.

### Implementation Details

1. **Provider Interface** (\`src/providers/email.ts\`)
   - \`EmailProvider\` class with \`send(notification)\` method
   - Template rendering via Handlebars
   - Configurable SMTP transport (dev: Ethereal, prod: SES)

2. **Retry Logic**
   - Exponential backoff: 1s, 5s, 30s, 5m
   - Max 4 retry attempts per notification
   - Dead letter queue for permanently failed deliveries

3. **Templates** (\`src/templates/\`)
   - \`notification.html\`: Default notification email template
   - \`digest.html\`: Daily digest template
   - Template variables: \`{{title}}\`, \`{{body}}\`, \`{{actionUrl}}\`

### Dependencies
- \`notification-model\`: Uses \`Notification\` type and \`updateStatus()\` for delivery tracking

### Verification
- Unit tests with mocked SMTP transport
- Template rendering tests with snapshot comparison
`);

writeFileSync(join(MOCK_PLAN_DIR, 'modules', 'notification-api.md'), `## Notification API Module

### Scope
REST endpoints for sending, listing, and marking notifications as read.

### Implementation Details

1. **Routes** (\`src/routes/notifications.ts\`)
   - \`POST /notifications\`: Create and optionally send a notification
   - \`GET /notifications\`: List notifications for authenticated user (paginated)
   - \`GET /notifications/:id\`: Get single notification
   - \`PATCH /notifications/:id/read\`: Mark as read

2. **Middleware**
   - Authentication required on all routes
   - Request validation via Zod schemas
   - Rate limiting: 100 req/min per user

3. **Integration** (\`src/app.ts\`)
   - Mount notification routes at \`/api/v1/notifications\`
   - Register email provider as singleton

### Dependencies
- \`notification-model\`: Uses repository for all data access

### Verification
- Integration tests for each endpoint
- Auth middleware tests
- Pagination and filtering tests
`);

const db = openDatabase(DB_PATH);

// ── Session IDs ──

const SESSION_1 = 'mock-session-errand';
const SESSION_2 = 'mock-session-excursion';
const SESSION_3 = 'mock-session-failed';
const SESSION_4 = 'mock-session-running';
const SESSION_5 = 'mock-session-validation-fix';
const SESSION_6 = 'mock-session-expedition';

// ── Helpers ──

let eventCounter = 0;
let agentIdCounter = 0;

function insertEvent(runId: string, event: EforgeEvent, offsetMs = 0): void {
  eventCounter++;
  const planId = 'planId' in event ? (event as Record<string, unknown>).planId as string | undefined
    : 'moduleId' in event ? (event as Record<string, unknown>).moduleId as string | undefined
    : undefined;
  const agent = 'agent' in event ? (event as Record<string, unknown>).agent as string | undefined : undefined;
  const ts = new Date(Date.now() - 3600_000 + offsetMs).toISOString();
  db.insertEvent({
    runId,
    type: event.type,
    planId: planId ?? undefined,
    agent: agent ?? undefined,
    data: JSON.stringify(event),
    timestamp: ts,
  });
}

function makeTimestamp(offsetMs: number): string {
  return new Date(Date.now() - 3600_000 + offsetMs).toISOString();
}

function nextAgentId(): string {
  agentIdCounter++;
  return `mock-agent-${String(agentIdCounter).padStart(3, '0')}`;
}

function agentResult(agent: string, durationMs: number, planId?: string): EforgeEvent {
  return {
    type: 'agent:result',
    planId,
    agent,
    result: {
      durationMs,
      durationApiMs: durationMs * 0.85,
      numTurns: Math.floor(3 + Math.random() * 5),
      totalCostUsd: 0.02 + Math.random() * 0.08,
      usage: { input: 15000 + Math.floor(Math.random() * 20000), output: 3000 + Math.floor(Math.random() * 5000), total: 20000 + Math.floor(Math.random() * 25000) },
      modelUsage: { 'claude-sonnet-4-5-20250514': { inputTokens: 15000, outputTokens: 3000, costUSD: 0.04 } },
    },
  } as unknown as EforgeEvent;
}

/** Insert agent:start + agent:result + agent:stop for a complete agent invocation. */
function insertAgentRun(runId: string, agent: string, startMs: number, endMs: number, planId?: string): void {
  const agentId = nextAgentId();
  insertEvent(runId, { type: 'agent:start', agentId, agent, planId, timestamp: makeTimestamp(startMs) } as unknown as EforgeEvent, startMs);
  insertEvent(runId, agentResult(agent, endMs - startMs, planId), endMs - 200);
  insertEvent(runId, { type: 'agent:stop', agentId, agent, planId, timestamp: makeTimestamp(endMs) } as unknown as EforgeEvent, endMs);
}

/** Insert agent:start + agent:stop with error (no result) for a failed agent invocation. */
function insertAgentFailed(runId: string, agent: string, startMs: number, endMs: number, error: string, planId?: string): void {
  const agentId = nextAgentId();
  insertEvent(runId, { type: 'agent:start', agentId, agent, planId, timestamp: makeTimestamp(startMs) } as unknown as EforgeEvent, startMs);
  insertEvent(runId, { type: 'agent:stop', agentId, agent, planId, error, timestamp: makeTimestamp(endMs) } as unknown as EforgeEvent, endMs);
}

// ── Run 1: Completed single-plan (errand) ──

const RUN1_ID = 'mock-errand-completed';
const RUN1_PLAN_SET = 'add-health-check';
db.insertRun({
  id: RUN1_ID,
  sessionId: SESSION_1,
  planSet: RUN1_PLAN_SET,
  command: 'run',
  status: 'completed',
  startedAt: makeTimestamp(0),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN1_ID, 'completed', makeTimestamp(120_000));

insertEvent(RUN1_ID, { type: 'phase:start', runId: RUN1_ID, planSet: RUN1_PLAN_SET, command: 'compile', timestamp: makeTimestamp(0) }, 0);
insertEvent(RUN1_ID, { type: 'plan:start', source: 'docs/add-health-check.md' }, 1000);
insertAgentRun(RUN1_ID, 'planner', 2000, 30000);
insertEvent(RUN1_ID, { type: 'plan:profile', profileName: 'errand', rationale: 'Single endpoint addition with no dependencies — errand profile fits best', config: { description: 'Small, self-contained changes.', compile: ['planner', 'plan-review-cycle'], build: ['implement', 'review', 'review-fix', 'evaluate'], agents: {}, review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } } } as unknown as EforgeEvent, 5500);
insertEvent(RUN1_ID, { type: 'plan:progress', message: 'Exploring codebase structure...' }, 10000);
insertEvent(RUN1_ID, { type: 'plan:progress', message: 'Analyzing existing route patterns...' }, 20000);
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
insertAgentRun(RUN1_ID, 'plan-reviewer', 33000, 45000);
insertEvent(RUN1_ID, { type: 'plan:review:complete', issues: [] }, 46000);
insertEvent(RUN1_ID, { type: 'plan:evaluate:start' }, 47000);
insertAgentRun(RUN1_ID, 'plan-evaluator', 48000, 50000);
insertEvent(RUN1_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 }, 51000);
insertEvent(RUN1_ID, { type: 'build:start', planId: 'plan-01-health-endpoint' }, 55000);
insertEvent(RUN1_ID, { type: 'build:implement:start', planId: 'plan-01-health-endpoint' }, 56000);
insertAgentRun(RUN1_ID, 'builder', 57000, 85000, 'plan-01-health-endpoint');
insertEvent(RUN1_ID, { type: 'build:implement:progress', planId: 'plan-01-health-endpoint', message: 'Creating health route handler...' }, 65000);
insertEvent(RUN1_ID, { type: 'build:implement:progress', planId: 'plan-01-health-endpoint', message: 'Adding tests...' }, 75000);
insertEvent(RUN1_ID, { type: 'build:implement:complete', planId: 'plan-01-health-endpoint' }, 86000);
insertEvent(RUN1_ID, { type: 'build:files_changed', planId: 'plan-01-health-endpoint', files: ['src/routes/health.ts', 'src/app.ts', 'test/routes/health.test.ts'] }, 87000);
insertEvent(RUN1_ID, { type: 'build:review:start', planId: 'plan-01-health-endpoint' }, 88000);
insertAgentRun(RUN1_ID, 'reviewer', 89000, 95000, 'plan-01-health-endpoint');
insertEvent(RUN1_ID, { type: 'build:review:complete', planId: 'plan-01-health-endpoint', issues: [{ severity: 'suggestion', category: 'style', file: 'src/routes/health.ts', description: 'Consider adding uptime to health response' }] }, 96000);
insertEvent(RUN1_ID, { type: 'build:evaluate:start', planId: 'plan-01-health-endpoint' }, 97000);
insertAgentRun(RUN1_ID, 'evaluator', 98000, 100000, 'plan-01-health-endpoint');
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
insertEvent(RUN1_ID, { type: 'session:end', sessionId: SESSION_1, result: { status: 'completed', summary: '1 plan completed, all validation passed' }, timestamp: makeTimestamp(121000) } as unknown as EforgeEvent, 121000);

// ── Run 2: Completed multi-plan (excursion) with approval, parallel review, review fix ──

const RUN2_ID = 'mock-excursion-completed';
const RUN2_PLAN_SET = 'add-jwt-auth';
db.insertRun({
  id: RUN2_ID,
  sessionId: SESSION_2,
  planSet: RUN2_PLAN_SET,
  command: 'run',
  status: 'completed',
  startedAt: makeTimestamp(200_000),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN2_ID, 'completed', makeTimestamp(500_000));

insertEvent(RUN2_ID, { type: 'phase:start', runId: RUN2_ID, planSet: RUN2_PLAN_SET, command: 'compile', timestamp: makeTimestamp(200000) }, 200000);
insertEvent(RUN2_ID, { type: 'plan:start', source: 'docs/add-jwt-auth.md' }, 201000);
insertAgentRun(RUN2_ID, 'planner', 202000, 240000);
insertEvent(RUN2_ID, { type: 'plan:profile', profileName: 'excursion', rationale: 'Multi-file auth work spanning middleware, routes, and tests — excursion profile for medium-complexity cross-file changes', config: { description: 'Multi-file feature work or refactors.', compile: ['planner', 'plan-review-cycle'], build: ['implement', 'review', 'review-fix', 'evaluate'], agents: {}, review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } } } as unknown as EforgeEvent, 210500);
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
insertAgentRun(RUN2_ID, 'plan-reviewer', 243000, 260000);
insertEvent(RUN2_ID, { type: 'plan:review:complete', issues: [{ severity: 'suggestion', category: 'completeness', file: 'plan-02-protected-routes', description: 'Consider adding rate limiting to auth endpoints' }] }, 261000);
insertEvent(RUN2_ID, { type: 'plan:evaluate:start' }, 262000);
insertAgentRun(RUN2_ID, 'plan-evaluator', 263000, 270000);
insertEvent(RUN2_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 1 }, 271000);

// Approval gate before builds
insertEvent(RUN2_ID, { type: 'approval:needed', action: 'build', details: '3 plans ready to build (2 waves)' } as unknown as EforgeEvent, 275000);
insertEvent(RUN2_ID, { type: 'approval:response', approved: true } as unknown as EforgeEvent, 278000);

// Wave 1: auth middleware (no deps)
insertEvent(RUN2_ID, { type: 'schedule:start', planIds: ['plan-01-auth-middleware'] }, 280000);
insertEvent(RUN2_ID, { type: 'build:start', planId: 'plan-01-auth-middleware' }, 281000);
insertEvent(RUN2_ID, { type: 'build:implement:start', planId: 'plan-01-auth-middleware' }, 282000);
insertAgentRun(RUN2_ID, 'builder', 283000, 310000, 'plan-01-auth-middleware');
insertEvent(RUN2_ID, { type: 'build:implement:complete', planId: 'plan-01-auth-middleware' }, 311000);
insertEvent(RUN2_ID, { type: 'build:files_changed', planId: 'plan-01-auth-middleware', files: ['src/middleware/auth.ts', 'src/config.ts', 'test/middleware/auth.test.ts', 'package.json'] }, 312000);
insertEvent(RUN2_ID, { type: 'build:review:start', planId: 'plan-01-auth-middleware' }, 313000);
insertAgentRun(RUN2_ID, 'reviewer', 314000, 325000, 'plan-01-auth-middleware');
insertEvent(RUN2_ID, { type: 'build:review:complete', planId: 'plan-01-auth-middleware', issues: [] }, 326000);
insertEvent(RUN2_ID, { type: 'build:evaluate:start', planId: 'plan-01-auth-middleware' }, 327000);
insertAgentRun(RUN2_ID, 'evaluator', 328000, 333000, 'plan-01-auth-middleware');
insertEvent(RUN2_ID, { type: 'build:evaluate:complete', planId: 'plan-01-auth-middleware', accepted: 0, rejected: 0 }, 334000);
insertEvent(RUN2_ID, { type: 'build:complete', planId: 'plan-01-auth-middleware' }, 335000);
insertEvent(RUN2_ID, { type: 'merge:start', planId: 'plan-01-auth-middleware' }, 336000);
insertEvent(RUN2_ID, { type: 'merge:complete', planId: 'plan-01-auth-middleware' }, 338000);
insertEvent(RUN2_ID, { type: 'wave:complete', wave: 1 } as unknown as EforgeEvent, 339000);

// Wave 2: protected routes + login (both depend on auth middleware)
insertEvent(RUN2_ID, { type: 'schedule:start', planIds: ['plan-02-protected-routes', 'plan-03-login-endpoint'] }, 340000);

// Plan 2: protected routes — with parallel review + review fix
insertEvent(RUN2_ID, { type: 'build:start', planId: 'plan-02-protected-routes' }, 341000);
insertEvent(RUN2_ID, { type: 'build:implement:start', planId: 'plan-02-protected-routes' }, 342000);
insertAgentRun(RUN2_ID, 'builder', 343000, 380000, 'plan-02-protected-routes');
insertEvent(RUN2_ID, { type: 'build:implement:complete', planId: 'plan-02-protected-routes' }, 381000);
insertEvent(RUN2_ID, { type: 'build:files_changed', planId: 'plan-02-protected-routes', files: ['src/routes/todos.ts', 'src/middleware/require-auth.ts', 'test/routes/todos.test.ts', 'test/helpers/auth.ts'] }, 382000);
// Parallel review (changeset > threshold)
insertEvent(RUN2_ID, { type: 'build:review:start', planId: 'plan-02-protected-routes' }, 383000);
insertEvent(RUN2_ID, { type: 'build:review:parallel:start', planId: 'plan-02-protected-routes', perspectives: ['code', 'security'] } as unknown as EforgeEvent, 383500);
// Code perspective
insertEvent(RUN2_ID, { type: 'build:review:parallel:perspective:start', planId: 'plan-02-protected-routes', perspective: 'code' } as unknown as EforgeEvent, 384000);
insertAgentRun(RUN2_ID, 'reviewer', 384000, 391000, 'plan-02-protected-routes');
insertEvent(RUN2_ID, { type: 'build:review:parallel:perspective:complete', planId: 'plan-02-protected-routes', perspective: 'code', issues: [{ severity: 'warning', category: 'code-quality', file: 'src/routes/todos.ts', line: 28, description: 'Middleware ordering may cause auth bypass on error paths' }] } as unknown as EforgeEvent, 391500);
// Security perspective (runs in parallel — overlapping timestamps)
insertEvent(RUN2_ID, { type: 'build:review:parallel:perspective:start', planId: 'plan-02-protected-routes', perspective: 'security' } as unknown as EforgeEvent, 384000);
insertAgentRun(RUN2_ID, 'reviewer', 384500, 390000, 'plan-02-protected-routes');
insertEvent(RUN2_ID, { type: 'build:review:parallel:perspective:complete', planId: 'plan-02-protected-routes', perspective: 'security', issues: [{ severity: 'critical', category: 'security', file: 'src/routes/todos.ts', line: 12, description: 'Missing input validation on user ID parameter allows IDOR' }] } as unknown as EforgeEvent, 390500);
// Merged review result
insertEvent(RUN2_ID, { type: 'build:review:complete', planId: 'plan-02-protected-routes', issues: [
  { severity: 'critical', category: 'security', file: 'src/routes/todos.ts', line: 12, description: 'Missing input validation on user ID parameter allows IDOR' },
  { severity: 'warning', category: 'code-quality', file: 'src/routes/todos.ts', line: 28, description: 'Middleware ordering may cause auth bypass on error paths' },
] }, 392000);
// Review fix agent
insertEvent(RUN2_ID, { type: 'build:review:fix:start', planId: 'plan-02-protected-routes', issueCount: 2 } as unknown as EforgeEvent, 392500);
insertAgentRun(RUN2_ID, 'review-fixer', 393000, 398000, 'plan-02-protected-routes');
insertEvent(RUN2_ID, { type: 'build:review:fix:complete', planId: 'plan-02-protected-routes' } as unknown as EforgeEvent, 398500);
// Evaluate fixes
insertEvent(RUN2_ID, { type: 'build:evaluate:start', planId: 'plan-02-protected-routes' }, 399000);
insertAgentRun(RUN2_ID, 'evaluator', 399500, 403000, 'plan-02-protected-routes');
insertEvent(RUN2_ID, { type: 'build:evaluate:complete', planId: 'plan-02-protected-routes', accepted: 2, rejected: 0 }, 403500);
insertEvent(RUN2_ID, { type: 'build:complete', planId: 'plan-02-protected-routes' }, 404000);

// Plan 3: login endpoint (parallel with plan 2, simple review)
insertEvent(RUN2_ID, { type: 'build:start', planId: 'plan-03-login-endpoint' }, 342000);
insertEvent(RUN2_ID, { type: 'build:implement:start', planId: 'plan-03-login-endpoint' }, 343000);
insertAgentRun(RUN2_ID, 'builder', 344000, 370000, 'plan-03-login-endpoint');
insertEvent(RUN2_ID, { type: 'build:implement:complete', planId: 'plan-03-login-endpoint' }, 371000);
insertEvent(RUN2_ID, { type: 'build:files_changed', planId: 'plan-03-login-endpoint', files: ['src/routes/auth.ts', 'src/app.ts', 'test/routes/auth.test.ts'] }, 372000);
insertEvent(RUN2_ID, { type: 'build:review:start', planId: 'plan-03-login-endpoint' }, 373000);
insertAgentRun(RUN2_ID, 'reviewer', 374000, 385000, 'plan-03-login-endpoint');
insertEvent(RUN2_ID, { type: 'build:review:complete', planId: 'plan-03-login-endpoint', issues: [{ severity: 'warning', category: 'security', file: 'src/routes/auth.ts', line: 15, description: 'JWT secret should not be hardcoded' }] }, 386000);
insertEvent(RUN2_ID, { type: 'build:evaluate:start', planId: 'plan-03-login-endpoint' }, 387000);
insertAgentRun(RUN2_ID, 'evaluator', 388000, 393000, 'plan-03-login-endpoint');
insertEvent(RUN2_ID, { type: 'build:evaluate:complete', planId: 'plan-03-login-endpoint', accepted: 1, rejected: 0 }, 394000);
insertEvent(RUN2_ID, { type: 'build:complete', planId: 'plan-03-login-endpoint' }, 395000);

// Merge wave 2 in topological order
insertEvent(RUN2_ID, { type: 'merge:start', planId: 'plan-02-protected-routes' }, 410000);
insertEvent(RUN2_ID, { type: 'merge:complete', planId: 'plan-02-protected-routes' }, 412000);
insertEvent(RUN2_ID, { type: 'merge:start', planId: 'plan-03-login-endpoint' }, 413000);
insertEvent(RUN2_ID, { type: 'merge:complete', planId: 'plan-03-login-endpoint' }, 415000);
insertEvent(RUN2_ID, { type: 'wave:complete', wave: 2 } as unknown as EforgeEvent, 416000);

// Validation
insertEvent(RUN2_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 420000);
insertEvent(RUN2_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 421000);
insertEvent(RUN2_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 0, output: '' }, 430000);
insertEvent(RUN2_ID, { type: 'validation:command:start', command: 'pnpm test' }, 431000);
insertEvent(RUN2_ID, { type: 'validation:command:complete', command: 'pnpm test', exitCode: 0, output: 'Tests: 24 passed' }, 445000);
insertEvent(RUN2_ID, { type: 'validation:complete', passed: true }, 446000);
insertEvent(RUN2_ID, { type: 'phase:end', runId: RUN2_ID, result: { status: 'completed', summary: '3 plans completed, all validation passed' }, timestamp: makeTimestamp(500000) }, 500000);
insertEvent(RUN2_ID, { type: 'session:end', sessionId: SESSION_2, result: { status: 'completed', summary: '3 plans completed, all validation passed' }, timestamp: makeTimestamp(501000) } as unknown as EforgeEvent, 501000);

// ── Run 3: Failed build ──

const RUN3_ID = 'mock-failed-build';
const RUN3_PLAN_SET = 'add-rate-limiting';
db.insertRun({
  id: RUN3_ID,
  sessionId: SESSION_3,
  planSet: RUN3_PLAN_SET,
  command: 'run',
  status: 'failed',
  startedAt: makeTimestamp(600_000),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN3_ID, 'failed', makeTimestamp(700_000));

insertEvent(RUN3_ID, { type: 'phase:start', runId: RUN3_ID, planSet: RUN3_PLAN_SET, command: 'compile', timestamp: makeTimestamp(600000) }, 600000);
insertEvent(RUN3_ID, { type: 'plan:start', source: 'docs/add-rate-limiting.md' }, 601000);
insertAgentRun(RUN3_ID, 'planner', 602000, 630000);
insertEvent(RUN3_ID, { type: 'plan:profile', profileName: 'errand', rationale: 'Single middleware addition — errand profile for low-risk single-area change', config: { description: 'Small, self-contained changes.', compile: ['planner', 'plan-review-cycle'], build: ['implement', 'review', 'review-fix', 'evaluate'], agents: {}, review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } } } as unknown as EforgeEvent, 610500);
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
insertAgentRun(RUN3_ID, 'plan-reviewer', 633000, 645000);
insertEvent(RUN3_ID, { type: 'plan:review:complete', issues: [] }, 646000);
insertEvent(RUN3_ID, { type: 'plan:evaluate:start' }, 647000);
insertAgentRun(RUN3_ID, 'plan-evaluator', 648000, 652000);
insertEvent(RUN3_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 }, 653000);
insertEvent(RUN3_ID, { type: 'build:start', planId: 'plan-01-rate-limiter' }, 660000);
insertEvent(RUN3_ID, { type: 'build:implement:start', planId: 'plan-01-rate-limiter' }, 661000);
insertAgentFailed(RUN3_ID, 'builder', 662000, 689000, 'Agent exceeded maximum turns (10)', 'plan-01-rate-limiter');
insertEvent(RUN3_ID, { type: 'build:implement:progress', planId: 'plan-01-rate-limiter', message: 'Installing express-rate-limit...' }, 665000);
insertEvent(RUN3_ID, { type: 'build:failed', planId: 'plan-01-rate-limiter', error: 'Agent exceeded maximum turns (10). The implementation was not completed.' }, 690000);
insertEvent(RUN3_ID, { type: 'phase:end', runId: RUN3_ID, result: { status: 'failed', summary: 'Build failed: plan-01-rate-limiter — agent exceeded max turns' }, timestamp: makeTimestamp(700000) }, 700000);
insertEvent(RUN3_ID, { type: 'session:end', sessionId: SESSION_3, result: { status: 'failed', summary: 'Build failed: plan-01-rate-limiter — agent exceeded max turns' }, timestamp: makeTimestamp(701000) } as unknown as EforgeEvent, 701000);

// ── Run 5: Validation failure with fix attempts ──

const RUN5_ID = 'mock-validation-fix';
const RUN5_PLAN_SET = 'add-caching';
db.insertRun({
  id: RUN5_ID,
  sessionId: SESSION_5,
  planSet: RUN5_PLAN_SET,
  command: 'run',
  status: 'failed',
  startedAt: makeTimestamp(750_000),
  cwd: '/mock/todo-api',
});
db.updateRunStatus(RUN5_ID, 'failed', makeTimestamp(910_000));

insertEvent(RUN5_ID, { type: 'phase:start', runId: RUN5_ID, planSet: RUN5_PLAN_SET, command: 'compile', timestamp: makeTimestamp(750000) }, 750000);
insertEvent(RUN5_ID, { type: 'plan:start', source: 'docs/add-caching.md' }, 751000);
insertAgentRun(RUN5_ID, 'planner', 752000, 770000);
insertEvent(RUN5_ID, { type: 'plan:profile', profileName: 'errand', rationale: 'Caching layer addition to existing endpoints — errand profile fits', config: { description: 'Small, self-contained changes.', compile: ['planner', 'plan-review-cycle'], build: ['implement', 'review', 'review-fix', 'evaluate'], agents: {}, review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } } } as unknown as EforgeEvent, 755500);
insertEvent(RUN5_ID, {
  type: 'plan:complete',
  plans: [{
    id: 'plan-01-caching',
    name: 'Redis Caching Layer',
    dependsOn: [],
    branch: 'plan-01-caching',
    body: '---\nid: plan-01-caching\nname: Redis Caching Layer\ndepends_on: []\nbranch: plan-01-caching\n---\n\n## Overview\nAdd Redis-backed caching middleware for GET endpoints.\n',
    filePath: '/mock/plans/add-caching/plan-01-caching.md',
  }],
}, 771000);
insertEvent(RUN5_ID, { type: 'plan:review:start' }, 772000);
insertAgentRun(RUN5_ID, 'plan-reviewer', 773000, 780000);
insertEvent(RUN5_ID, { type: 'plan:review:complete', issues: [] }, 781000);
insertEvent(RUN5_ID, { type: 'plan:evaluate:start' }, 782000);
insertAgentRun(RUN5_ID, 'plan-evaluator', 783000, 786000);
insertEvent(RUN5_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 }, 787000);

// Build succeeds
insertEvent(RUN5_ID, { type: 'build:start', planId: 'plan-01-caching' }, 790000);
insertEvent(RUN5_ID, { type: 'build:implement:start', planId: 'plan-01-caching' }, 791000);
insertAgentRun(RUN5_ID, 'builder', 792000, 820000, 'plan-01-caching');
insertEvent(RUN5_ID, { type: 'build:implement:complete', planId: 'plan-01-caching' }, 821000);
insertEvent(RUN5_ID, { type: 'build:files_changed', planId: 'plan-01-caching', files: ['src/middleware/cache.ts', 'src/config.ts', 'src/routes/todos.ts', 'test/middleware/cache.test.ts'] }, 822000);
insertEvent(RUN5_ID, { type: 'build:review:start', planId: 'plan-01-caching' }, 823000);
insertAgentRun(RUN5_ID, 'reviewer', 824000, 832000, 'plan-01-caching');
insertEvent(RUN5_ID, { type: 'build:review:complete', planId: 'plan-01-caching', issues: [] }, 833000);
insertEvent(RUN5_ID, { type: 'build:evaluate:start', planId: 'plan-01-caching' }, 834000);
insertAgentRun(RUN5_ID, 'evaluator', 835000, 840000, 'plan-01-caching');
insertEvent(RUN5_ID, { type: 'build:evaluate:complete', planId: 'plan-01-caching', accepted: 0, rejected: 0 }, 841000);
insertEvent(RUN5_ID, { type: 'build:complete', planId: 'plan-01-caching' }, 842000);
insertEvent(RUN5_ID, { type: 'merge:start', planId: 'plan-01-caching' }, 843000);
insertEvent(RUN5_ID, { type: 'merge:complete', planId: 'plan-01-caching' }, 845000);

// Validation fails
insertEvent(RUN5_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 846000);
insertEvent(RUN5_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 847000);
insertEvent(RUN5_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 1, output: 'src/middleware/cache.ts(14,5): error TS2345: Argument of type \'string | undefined\' is not assignable to parameter of type \'string\'.' }, 852000);
insertEvent(RUN5_ID, { type: 'validation:complete', passed: false }, 853000);

// Fix attempt 1
insertEvent(RUN5_ID, { type: 'validation:fix:start', attempt: 1, maxAttempts: 2 } as unknown as EforgeEvent, 854000);
insertAgentRun(RUN5_ID, 'validation-fixer', 855000, 870000);
insertEvent(RUN5_ID, { type: 'validation:fix:complete', attempt: 1 } as unknown as EforgeEvent, 871000);

// Re-validate — still fails
insertEvent(RUN5_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 872000);
insertEvent(RUN5_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 873000);
insertEvent(RUN5_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 1, output: 'src/config.ts(8,3): error TS2322: Type \'number\' is not assignable to type \'string\'.' }, 878000);
insertEvent(RUN5_ID, { type: 'validation:complete', passed: false }, 879000);

// Fix attempt 2
insertEvent(RUN5_ID, { type: 'validation:fix:start', attempt: 2, maxAttempts: 2 } as unknown as EforgeEvent, 880000);
insertAgentRun(RUN5_ID, 'validation-fixer', 881000, 895000);
insertEvent(RUN5_ID, { type: 'validation:fix:complete', attempt: 2 } as unknown as EforgeEvent, 896000);

// Final validation — still fails, max retries exhausted
insertEvent(RUN5_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 897000);
insertEvent(RUN5_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 898000);
insertEvent(RUN5_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 1, output: 'src/config.ts(8,3): error TS2322: Type \'number\' is not assignable to type \'string\'.' }, 903000);
insertEvent(RUN5_ID, { type: 'validation:complete', passed: false }, 904000);

insertEvent(RUN5_ID, { type: 'phase:end', runId: RUN5_ID, result: { status: 'failed', summary: 'Validation failed after 2 fix attempts: type-check errors persist' }, timestamp: makeTimestamp(905000) }, 905000);
insertEvent(RUN5_ID, { type: 'session:end', sessionId: SESSION_5, result: { status: 'failed', summary: 'Validation failed after 2 fix attempts: type-check errors persist' }, timestamp: makeTimestamp(906000) } as unknown as EforgeEvent, 906000);

// ── Run 6: Completed expedition (two phases sharing a session) ──

const RUN6_PLAN_SET = 'build-notification-system';
const RUN6A_ID = 'mock-expedition-compile';
const RUN6B_ID = 'mock-expedition-build';

const expeditionPlans = [
  {
    id: 'plan-01-notification-model',
    name: 'Notification Model',
    dependsOn: [] as string[],
    branch: 'plan-01-notification-model',
    body: '---\nid: plan-01-notification-model\nname: Notification Model\ndepends_on: []\nbranch: plan-01-notification-model\n---\n\n## Overview\nCore notification data model, storage layer, and CRUD operations.\n',
    filePath: '/mock/plans/build-notification-system/plan-01-notification-model.md',
  },
  {
    id: 'plan-02-email-provider',
    name: 'Email Provider',
    dependsOn: ['plan-01-notification-model'],
    branch: 'plan-02-email-provider',
    body: '---\nid: plan-02-email-provider\nname: Email Provider\ndepends_on: [plan-01-notification-model]\nbranch: plan-02-email-provider\n---\n\n## Overview\nEmail delivery provider with template rendering and retry logic.\n',
    filePath: '/mock/plans/build-notification-system/plan-02-email-provider.md',
  },
  {
    id: 'plan-03-notification-api',
    name: 'Notification API',
    dependsOn: ['plan-01-notification-model'],
    branch: 'plan-03-notification-api',
    body: '---\nid: plan-03-notification-api\nname: Notification API\ndepends_on: [plan-01-notification-model]\nbranch: plan-03-notification-api\n---\n\n## Overview\nREST endpoints for sending, listing, and marking notifications as read.\n',
    filePath: '/mock/plans/build-notification-system/plan-03-notification-api.md',
  },
];

// Run 6a: Compile phase (expedition planning)
db.insertRun({
  id: RUN6A_ID,
  sessionId: SESSION_6,
  planSet: RUN6_PLAN_SET,
  command: 'compile',
  status: 'completed',
  startedAt: makeTimestamp(1_000_000),
  cwd: TEMP_DIR,
});
db.updateRunStatus(RUN6A_ID, 'completed', makeTimestamp(1_200_000));

insertEvent(RUN6A_ID, { type: 'phase:start', runId: RUN6A_ID, planSet: RUN6_PLAN_SET, command: 'compile', timestamp: makeTimestamp(1000000) }, 1000000);
insertEvent(RUN6A_ID, { type: 'plan:start', source: 'docs/build-notification-system.md' }, 1001000);
insertAgentRun(RUN6A_ID, 'planner', 1002000, 1050000);
insertEvent(RUN6A_ID, { type: 'plan:profile', profileName: 'expedition', rationale: 'Multi-module system with data model, email provider, and API — expedition profile for cross-cutting parallel work', config: { description: 'Large cross-cutting work spanning multiple modules.', compile: ['planner', 'module-planning', 'cohesion-review-cycle', 'compile-expedition'], build: ['implement', 'review', 'review-fix', 'evaluate'], agents: {}, review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } } } as unknown as EforgeEvent, 1010500);
insertEvent(RUN6A_ID, { type: 'plan:progress', message: 'Exploring existing codebase architecture...' }, 1020000);
insertEvent(RUN6A_ID, { type: 'plan:progress', message: 'Identifying module boundaries and dependencies...' }, 1035000);

// Architecture complete — modules identified
insertEvent(RUN6A_ID, { type: 'expedition:architecture:complete', modules: [
  { id: 'notification-model', description: 'Core notification data model and storage layer', dependsOn: [] },
  { id: 'email-provider', description: 'Email delivery provider with templates and retry', dependsOn: ['notification-model'] },
  { id: 'notification-api', description: 'REST API endpoints for notification management', dependsOn: ['notification-model'] },
] } as unknown as EforgeEvent, 1051000);

// Module planning wave 1: notification-model (no deps)
insertEvent(RUN6A_ID, { type: 'expedition:wave:start', wave: 1, moduleIds: ['notification-model'] } as unknown as EforgeEvent, 1055000);
insertEvent(RUN6A_ID, { type: 'expedition:module:start', moduleId: 'notification-model' } as unknown as EforgeEvent, 1056000);
insertAgentRun(RUN6A_ID, 'module-planner', 1057000, 1080000);
insertEvent(RUN6A_ID, { type: 'expedition:module:complete', moduleId: 'notification-model' } as unknown as EforgeEvent, 1081000);
insertEvent(RUN6A_ID, { type: 'expedition:wave:complete', wave: 1 } as unknown as EforgeEvent, 1082000);

// Module planning wave 2: email-provider + notification-api (both depend on model)
insertEvent(RUN6A_ID, { type: 'expedition:wave:start', wave: 2, moduleIds: ['email-provider', 'notification-api'] } as unknown as EforgeEvent, 1085000);
insertEvent(RUN6A_ID, { type: 'expedition:module:start', moduleId: 'email-provider' } as unknown as EforgeEvent, 1086000);
insertAgentRun(RUN6A_ID, 'module-planner', 1087000, 1105000);
insertEvent(RUN6A_ID, { type: 'expedition:module:complete', moduleId: 'email-provider' } as unknown as EforgeEvent, 1106000);
insertEvent(RUN6A_ID, { type: 'expedition:module:start', moduleId: 'notification-api' } as unknown as EforgeEvent, 1086000);
insertAgentRun(RUN6A_ID, 'module-planner', 1087500, 1110000);
insertEvent(RUN6A_ID, { type: 'expedition:module:complete', moduleId: 'notification-api' } as unknown as EforgeEvent, 1111000);
insertEvent(RUN6A_ID, { type: 'expedition:wave:complete', wave: 2 } as unknown as EforgeEvent, 1112000);

// Cohesion review
insertEvent(RUN6A_ID, { type: 'plan:cohesion:start' } as unknown as EforgeEvent, 1115000);
insertAgentRun(RUN6A_ID, 'cohesion-reviewer', 1116000, 1130000);
insertEvent(RUN6A_ID, { type: 'plan:cohesion:complete', issues: [
  { severity: 'warning', category: 'integration', file: 'notification-api', description: 'API module should import notification types from model module, not redefine them' },
  { severity: 'suggestion', category: 'consistency', file: 'email-provider', description: 'Consider using shared error types across modules' },
] } as unknown as EforgeEvent, 1131000);
insertEvent(RUN6A_ID, { type: 'plan:cohesion:evaluate:start' } as unknown as EforgeEvent, 1132000);
insertAgentRun(RUN6A_ID, 'cohesion-evaluator', 1133000, 1140000);
insertEvent(RUN6A_ID, { type: 'plan:cohesion:evaluate:complete', accepted: 1, rejected: 1 } as unknown as EforgeEvent, 1141000);

// Compile modules into plan files
insertEvent(RUN6A_ID, { type: 'expedition:compile:start' } as unknown as EforgeEvent, 1145000);
insertEvent(RUN6A_ID, { type: 'expedition:compile:complete', plans: expeditionPlans } as unknown as EforgeEvent, 1146000);
insertEvent(RUN6A_ID, { type: 'plan:complete', plans: expeditionPlans }, 1147000);

// Plan review
insertEvent(RUN6A_ID, { type: 'plan:review:start' }, 1150000);
insertAgentRun(RUN6A_ID, 'plan-reviewer', 1151000, 1170000);
insertEvent(RUN6A_ID, { type: 'plan:review:complete', issues: [] }, 1171000);
insertEvent(RUN6A_ID, { type: 'plan:evaluate:start' }, 1172000);
insertAgentRun(RUN6A_ID, 'plan-evaluator', 1173000, 1180000);
insertEvent(RUN6A_ID, { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 }, 1181000);

insertEvent(RUN6A_ID, { type: 'phase:end', runId: RUN6A_ID, result: { status: 'completed', summary: 'Expedition compiled: 3 modules → 3 plans' }, timestamp: makeTimestamp(1200000) }, 1200000);

// Run 6b: Build phase
db.insertRun({
  id: RUN6B_ID,
  sessionId: SESSION_6,
  planSet: RUN6_PLAN_SET,
  command: 'build',
  status: 'completed',
  startedAt: makeTimestamp(1_210_000),
  cwd: TEMP_DIR,
});
db.updateRunStatus(RUN6B_ID, 'completed', makeTimestamp(1_400_000));

insertEvent(RUN6B_ID, { type: 'phase:start', runId: RUN6B_ID, planSet: RUN6_PLAN_SET, command: 'build', timestamp: makeTimestamp(1210000) }, 1210000);

// Wave 1: notification model
insertEvent(RUN6B_ID, { type: 'schedule:start', planIds: ['plan-01-notification-model'] }, 1215000);
insertEvent(RUN6B_ID, { type: 'build:start', planId: 'plan-01-notification-model' }, 1216000);
insertEvent(RUN6B_ID, { type: 'build:implement:start', planId: 'plan-01-notification-model' }, 1217000);
insertAgentRun(RUN6B_ID, 'builder', 1218000, 1250000, 'plan-01-notification-model');
insertEvent(RUN6B_ID, { type: 'build:implement:complete', planId: 'plan-01-notification-model' }, 1251000);
insertEvent(RUN6B_ID, { type: 'build:files_changed', planId: 'plan-01-notification-model', files: ['src/models/notification.ts', 'src/db/migrations/001-notifications.sql', 'test/models/notification.test.ts'] }, 1252000);
insertEvent(RUN6B_ID, { type: 'build:review:start', planId: 'plan-01-notification-model' }, 1253000);
insertAgentRun(RUN6B_ID, 'reviewer', 1254000, 1265000, 'plan-01-notification-model');
insertEvent(RUN6B_ID, { type: 'build:review:complete', planId: 'plan-01-notification-model', issues: [] }, 1266000);
insertEvent(RUN6B_ID, { type: 'build:evaluate:start', planId: 'plan-01-notification-model' }, 1267000);
insertAgentRun(RUN6B_ID, 'evaluator', 1268000, 1273000, 'plan-01-notification-model');
insertEvent(RUN6B_ID, { type: 'build:evaluate:complete', planId: 'plan-01-notification-model', accepted: 0, rejected: 0 }, 1274000);
insertEvent(RUN6B_ID, { type: 'build:complete', planId: 'plan-01-notification-model' }, 1275000);
insertEvent(RUN6B_ID, { type: 'merge:start', planId: 'plan-01-notification-model' }, 1276000);
insertEvent(RUN6B_ID, { type: 'merge:complete', planId: 'plan-01-notification-model' }, 1278000);
insertEvent(RUN6B_ID, { type: 'wave:complete', wave: 1 } as unknown as EforgeEvent, 1279000);

// Wave 2: email provider + notification API (parallel)
insertEvent(RUN6B_ID, { type: 'schedule:start', planIds: ['plan-02-email-provider', 'plan-03-notification-api'] }, 1280000);

// Plan 2: email provider
insertEvent(RUN6B_ID, { type: 'build:start', planId: 'plan-02-email-provider' }, 1281000);
insertEvent(RUN6B_ID, { type: 'build:implement:start', planId: 'plan-02-email-provider' }, 1282000);
insertAgentRun(RUN6B_ID, 'builder', 1283000, 1310000, 'plan-02-email-provider');
insertEvent(RUN6B_ID, { type: 'build:implement:complete', planId: 'plan-02-email-provider' }, 1311000);
insertEvent(RUN6B_ID, { type: 'build:files_changed', planId: 'plan-02-email-provider', files: ['src/providers/email.ts', 'src/templates/notification.html', 'test/providers/email.test.ts'] }, 1312000);
insertEvent(RUN6B_ID, { type: 'build:review:start', planId: 'plan-02-email-provider' }, 1313000);
insertAgentRun(RUN6B_ID, 'reviewer', 1314000, 1325000, 'plan-02-email-provider');
insertEvent(RUN6B_ID, { type: 'build:review:complete', planId: 'plan-02-email-provider', issues: [] }, 1326000);
insertEvent(RUN6B_ID, { type: 'build:evaluate:start', planId: 'plan-02-email-provider' }, 1327000);
insertAgentRun(RUN6B_ID, 'evaluator', 1328000, 1333000, 'plan-02-email-provider');
insertEvent(RUN6B_ID, { type: 'build:evaluate:complete', planId: 'plan-02-email-provider', accepted: 0, rejected: 0 }, 1334000);
insertEvent(RUN6B_ID, { type: 'build:complete', planId: 'plan-02-email-provider' }, 1335000);

// Plan 3: notification API (parallel with plan 2)
insertEvent(RUN6B_ID, { type: 'build:start', planId: 'plan-03-notification-api' }, 1281000);
insertEvent(RUN6B_ID, { type: 'build:implement:start', planId: 'plan-03-notification-api' }, 1282000);
insertAgentRun(RUN6B_ID, 'builder', 1283500, 1315000, 'plan-03-notification-api');
insertEvent(RUN6B_ID, { type: 'build:implement:complete', planId: 'plan-03-notification-api' }, 1316000);
insertEvent(RUN6B_ID, { type: 'build:files_changed', planId: 'plan-03-notification-api', files: ['src/routes/notifications.ts', 'src/app.ts', 'test/routes/notifications.test.ts'] }, 1317000);
insertEvent(RUN6B_ID, { type: 'build:review:start', planId: 'plan-03-notification-api' }, 1318000);
insertAgentRun(RUN6B_ID, 'reviewer', 1319000, 1330000, 'plan-03-notification-api');
insertEvent(RUN6B_ID, { type: 'build:review:complete', planId: 'plan-03-notification-api', issues: [{ severity: 'suggestion', category: 'api', file: 'src/routes/notifications.ts', description: 'Consider adding pagination to GET /notifications' }] }, 1331000);
insertEvent(RUN6B_ID, { type: 'build:evaluate:start', planId: 'plan-03-notification-api' }, 1332000);
insertAgentRun(RUN6B_ID, 'evaluator', 1333000, 1338000, 'plan-03-notification-api');
insertEvent(RUN6B_ID, { type: 'build:evaluate:complete', planId: 'plan-03-notification-api', accepted: 0, rejected: 1 }, 1339000);
insertEvent(RUN6B_ID, { type: 'build:complete', planId: 'plan-03-notification-api' }, 1340000);

// Merge wave 2
insertEvent(RUN6B_ID, { type: 'merge:start', planId: 'plan-02-email-provider' }, 1345000);
insertEvent(RUN6B_ID, { type: 'merge:complete', planId: 'plan-02-email-provider' }, 1347000);
insertEvent(RUN6B_ID, { type: 'merge:start', planId: 'plan-03-notification-api' }, 1348000);
insertEvent(RUN6B_ID, { type: 'merge:complete', planId: 'plan-03-notification-api' }, 1350000);
insertEvent(RUN6B_ID, { type: 'wave:complete', wave: 2 } as unknown as EforgeEvent, 1351000);

// Validation
insertEvent(RUN6B_ID, { type: 'validation:start', commands: ['pnpm type-check', 'pnpm test'] }, 1355000);
insertEvent(RUN6B_ID, { type: 'validation:command:start', command: 'pnpm type-check' }, 1356000);
insertEvent(RUN6B_ID, { type: 'validation:command:complete', command: 'pnpm type-check', exitCode: 0, output: '' }, 1362000);
insertEvent(RUN6B_ID, { type: 'validation:command:start', command: 'pnpm test' }, 1363000);
insertEvent(RUN6B_ID, { type: 'validation:command:complete', command: 'pnpm test', exitCode: 0, output: 'Tests: 36 passed' }, 1375000);
insertEvent(RUN6B_ID, { type: 'validation:complete', passed: true }, 1376000);

// Cleanup
insertEvent(RUN6B_ID, { type: 'cleanup:start', planSet: RUN6_PLAN_SET } as unknown as EforgeEvent, 1380000);
insertEvent(RUN6B_ID, { type: 'cleanup:complete', planSet: RUN6_PLAN_SET } as unknown as EforgeEvent, 1382000);

insertEvent(RUN6B_ID, { type: 'phase:end', runId: RUN6B_ID, result: { status: 'completed', summary: '3 plans completed, all validation passed' }, timestamp: makeTimestamp(1385000) }, 1385000);
insertEvent(RUN6B_ID, { type: 'session:end', sessionId: SESSION_6, result: { status: 'completed', summary: 'Expedition complete: 3 modules built and validated' }, timestamp: makeTimestamp(1386000) } as unknown as EforgeEvent, 1386000);

// ── Run 4: Currently running (simulated) ──

const RUN4_ID = 'mock-running-build';
const RUN4_PLAN_SET = 'add-pagination';
db.insertRun({
  id: RUN4_ID,
  sessionId: SESSION_4,
  planSet: RUN4_PLAN_SET,
  command: 'run',
  status: 'running',
  startedAt: new Date().toISOString(),
  cwd: '/mock/todo-api',
});

const now = Date.now();
function runTs(ms: number): string { return new Date(now - 60_000 + ms).toISOString(); }

// Static initial events (already happened before server started)
const plannerAgentId = nextAgentId();
db.insertEvent({ runId: RUN4_ID, type: 'phase:start', data: JSON.stringify({ type: 'phase:start', runId: RUN4_ID, planSet: RUN4_PLAN_SET, command: 'compile', timestamp: runTs(0) }), timestamp: runTs(0) });
db.insertEvent({ runId: RUN4_ID, type: 'plan:start', data: JSON.stringify({ type: 'plan:start', source: 'docs/add-pagination.md' }), timestamp: runTs(2000) });
db.insertEvent({ runId: RUN4_ID, type: 'agent:start', agent: 'planner', data: JSON.stringify({ type: 'agent:start', agentId: plannerAgentId, agent: 'planner', timestamp: runTs(3000) }), timestamp: runTs(3000) });
db.insertEvent({ runId: RUN4_ID, type: 'plan:profile', data: JSON.stringify({ type: 'plan:profile', profileName: 'excursion', rationale: 'Pagination across routes, query parsing, and tests — excursion profile for multi-file feature work', config: { description: 'Multi-file feature work or refactors.', compile: ['planner', 'plan-review-cycle'], build: ['implement', 'review', 'review-fix', 'evaluate'], agents: {}, review: { strategy: 'auto', perspectives: ['code'], maxRounds: 1, evaluatorStrictness: 'standard' } } }), timestamp: runTs(8500) });
db.insertEvent({ runId: RUN4_ID, type: 'plan:progress', data: JSON.stringify({ type: 'plan:progress', message: 'Exploring existing route patterns and query handling...' }), timestamp: runTs(15000) });

// Trickle in events for the running run
const liveEvents: Array<{ delay: number; event: Record<string, unknown> }> = [
  { delay: 3000, event: { type: 'plan:progress', message: 'Analyzing pagination strategies (cursor vs offset)...' } },
  // Clarification loop
  { delay: 8000, event: {
    type: 'plan:clarification',
    questions: [{
      id: 'pagination-strategy',
      question: 'Should pagination use cursor-based or offset-based approach?',
      context: 'The codebase currently has no pagination. Cursor-based is more performant for large datasets but offset-based is simpler to implement.',
      options: ['cursor-based', 'offset-based'],
      default: 'cursor-based',
    }],
  } },
  { delay: 15000, event: {
    type: 'plan:clarification:answer',
    answers: { 'pagination-strategy': 'cursor-based' },
  } },
  { delay: 18000, event: { type: 'plan:progress', message: 'Drafting plan files with cursor-based pagination...' } },
  { delay: 25000, event: { type: 'agent:stop', agentId: plannerAgentId, agent: 'planner', timestamp: new Date(now + 25000).toISOString() } },
  { delay: 25500, event: agentResult('planner', 22000) },
  { delay: 26000, event: {
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
  { delay: 30000, event: { type: 'plan:review:start' } },
  { delay: 45000, event: agentResult('plan-reviewer', 14000) },
  { delay: 46000, event: { type: 'plan:review:complete', issues: [] } },
  { delay: 47000, event: { type: 'plan:evaluate:start' } },
  { delay: 53000, event: agentResult('plan-evaluator', 5000) },
  { delay: 54000, event: { type: 'plan:evaluate:complete', accepted: 0, rejected: 0 } },
  { delay: 57000, event: { type: 'schedule:start', planIds: ['plan-01-pagination-core'] } },
  { delay: 58000, event: { type: 'build:start', planId: 'plan-01-pagination-core' } },
  { delay: 59000, event: { type: 'build:implement:start', planId: 'plan-01-pagination-core' } },
  { delay: 70000, event: { type: 'build:implement:progress', planId: 'plan-01-pagination-core', message: 'Creating pagination utility...' } },
  { delay: 85000, event: { type: 'build:implement:progress', planId: 'plan-01-pagination-core', message: 'Adding cursor decoding...' } },
];

// ── Start server ──

console.log('Starting mock monitor server...');
const server = await startServer(db, 4567, { strictPort: true });
console.log(`Mock monitor: ${server.url}`);
console.log(`\nPopulated ${eventCounter} events across 7 runs:`);
console.log(`  ${RUN1_PLAN_SET} (completed, 1 plan — errand)`);
console.log(`  ${RUN2_PLAN_SET} (completed, 3 plans, 2 waves — excursion w/ parallel review + approval)`);
console.log(`  ${RUN3_PLAN_SET} (failed — build agent exceeded max turns)`);
console.log(`  ${RUN5_PLAN_SET} (failed — validation fix retries exhausted)`);
console.log(`  ${RUN6_PLAN_SET} (completed, 3 modules → 3 plans — expedition w/ cohesion review)`);
console.log(`  ${RUN4_PLAN_SET} (running, live events w/ clarification)`);
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
    const moduleId = (event as { moduleId?: string }).moduleId;
    const agent = (event as { agent?: string }).agent;
    db.insertEvent({
      runId: RUN4_ID,
      type,
      planId: planId ?? moduleId ?? undefined,
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
