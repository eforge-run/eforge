<!-- Generated file. Do not edit. -->
<!-- eforge version: 0.7.12 -->
<!-- Commit: 85dd5c6c -->
<!-- Source: packages/client/src/routes.ts -->

# eforge Daemon HTTP API Reference

The eforge daemon exposes an HTTP API at `http://localhost:{port}/api/...`.
Clients should import route constants from `@eforge-build/client` (`API_ROUTES`) rather
than embedding literal path strings.

## Routes

Total routes: 56

| Route key | Path pattern |
|-----------|-------------|
| `applyRecovery` | `/api/recover/apply` |
| `autoBuildGet` | `/api/auto-build` |
| `autoBuildSet` | `/api/auto-build` |
| `cancel` | `/api/cancel/:sessionId` |
| `configShow` | `/api/config/show` |
| `configValidate` | `/api/config/validate` |
| `daemonEvents` | `/api/daemon-events` |
| `daemonStop` | `/api/daemon/stop` |
| `diff` | `/api/diff/:sessionId/:planId` |
| `enqueue` | `/api/enqueue` |
| `events` | `/api/events/:runId` |
| `extensionList` | `/api/extensions/list` |
| `extensionNew` | `/api/extensions/new` |
| `extensionReload` | `/api/extensions/reload` |
| `extensionShow` | `/api/extensions/show` |
| `extensionTest` | `/api/extensions/test` |
| `extensionTrust` | `/api/extensions/trust` |
| `extensionUntrust` | `/api/extensions/untrust` |
| `extensionValidate` | `/api/extensions/validate` |
| `health` | `/api/health` |
| `keepAlive` | `/api/keep-alive` |
| `modelList` | `/api/models/list` |
| `modelProviders` | `/api/models/providers` |
| `plans` | `/api/plans/:runId` |
| `playbookCopy` | `/api/playbook/copy` |
| `playbookDemote` | `/api/playbook/demote` |
| `playbookEnqueue` | `/api/playbook/enqueue` |
| `playbookList` | `/api/playbook/list` |
| `playbookPromote` | `/api/playbook/promote` |
| `playbookSave` | `/api/playbook/save` |
| `playbookShow` | `/api/playbook/show` |
| `playbookValidate` | `/api/playbook/validate` |
| `profileCreate` | `/api/profile/create` |
| `profileDelete` | `/api/profile/:name` |
| `profileList` | `/api/profile/list` |
| `profileShow` | `/api/profile/show` |
| `profileUse` | `/api/profile/use` |
| `projectContext` | `/api/project-context` |
| `queue` | `/api/queue` |
| `readRecoverySidecar` | `/api/recovery/sidecar` |
| `recover` | `/api/recover` |
| `runs` | `/api/runs` |
| `runState` | `/api/run-state/:id` |
| `runSummary` | `/api/run-summary/:id` |
| `schedulerKick` | `/api/scheduler/kick` |
| `sessionMetadata` | `/api/session-metadata` |
| `sessionPlanCreate` | `/api/session-plan/create` |
| `sessionPlanList` | `/api/session-plan/list` |
| `sessionPlanMigrateLegacy` | `/api/session-plan/migrate-legacy` |
| `sessionPlanReadiness` | `/api/session-plan/readiness` |
| `sessionPlanSelectDimensions` | `/api/session-plan/select-dimensions` |
| `sessionPlanSetSection` | `/api/session-plan/set-section` |
| `sessionPlanSetStatus` | `/api/session-plan/set-status` |
| `sessionPlanShow` | `/api/session-plan/show` |
| `sessionPlanSkipDimension` | `/api/session-plan/skip-dimension` |
| `version` | `/api/version` |

## SSE Streams

- `GET /api/daemon-events` — daemon-wide event stream with `stream:hello` snapshot on connect.
- `GET /api/events/:runId` — session-specific event stream with `stream:hello` snapshot on connect.

Use `buildPath(pattern, params)` from `@eforge-build/client` to resolve `:param` placeholders.
