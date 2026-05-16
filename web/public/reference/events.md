<!-- Generated file. Do not edit. -->
<!-- eforge version: 0.7.12 -->
<!-- Commit: f64aec79 -->
<!-- Source: packages/client/src/events.schemas.ts -->

# eforge Event Protocol Reference

All events emitted on the eforge SSE stream conform to the `EforgeEvent` discriminated
union defined in `packages/client/src/events.schemas.ts`.

Each event carries an optional envelope (`sessionId`, `runId`, `timestamp`) intersected
with one of the variant objects below. The `type` field discriminates the variant.

## Event Variants

Total variants: 165

| Event type | Additional fields |
|------------|-------------------|
| `session:start` | `sessionId` |
| `session:end` | `result`, `sessionId` |
| `session:profile` | `config`, `profileName`, `scope`, `source` |
| `phase:start` | `command`, `planSet`, `runId` |
| `phase:end` | `result`, `runId` |
| `config:warning` | `details`, `message`, `source` |
| `planning:warning` | `details`, `message`, `planId`, `source` |
| `planning:module:build-config:invalid` | `errors`, `moduleId`, `reason` |
| `extension:event-handler:failed` | `extensionName`, `extensionPath`, `message`, `pattern`, `stack`, `triggeringEventType` |
| `extension:event-handler:timeout` | `extensionName`, `extensionPath`, `pattern`, `timeoutMs`, `triggeringEventType` |
| `extension:agent-context:applied` | `extensionName`, `extensionPath`, `fragmentCount`, `harness`, `phase`, `planId`, `profile`, `projectMcpSelection`, `promptCharCount`, `role`, `stage`, `tier`, `toolbelt` |
| `extension:agent-context:failed` | `extensionName`, `extensionPath`, `harness`, `message`, `phase`, `planId`, `profile`, `projectMcpSelection`, `role`, `stack`, `stage`, `tier`, `toolbelt` |
| `extension:agent-context:timeout` | `extensionName`, `extensionPath`, `harness`, `phase`, `planId`, `profile`, `projectMcpSelection`, `role`, `stage`, `tier`, `timeoutMs`, `toolbelt` |
| `extension:agent-context:unsupported` | `extensionName`, `extensionPath`, `fields`, `harness`, `phase`, `planId`, `profile`, `projectMcpSelection`, `role`, `stage`, `tier`, `toolbelt` |
| `extension:agent-tools:applied` | `allowedToolCount`, `allowedToolsAdded`, `disallowedToolCount`, `disallowedToolsAdded`, `effectiveToolNames`, `excludedToolCount`, `excludedToolNames`, `extensionName`, `extensionPath`, `harness`, `inlineToolNames`, `phase`, `planId`, `profile`, `projectMcpSelection`, `projectMcpServerNames`, `registeredToolNames`, `role`, `stage`, `tier`, `toolCount`, `toolNames`, `toolbelt` |
| `queue:profile:selected` | `baseProfile`, `confidence`, `extensionName`, `extensionPath`, `prdId`, `prdTitle`, `profile`, `reason`, `routerName` |
| `queue:profile:router-failed` | `extensionName`, `extensionPath`, `message`, `prdId`, `routerName`, `stack` |
| `queue:profile:router-timeout` | `extensionName`, `extensionPath`, `prdId`, `routerName`, `timeoutMs` |
| `queue:profile:invalid-selection` | `extensionName`, `extensionPath`, `message`, `prdId`, `reason`, `requestedProfile`, `routerName` |
| `planning:start` | `label`, `source` |
| `planning:skip` | `reason` |
| `planning:submission` | `hasMigrations`, `planCount`, `totalBodySize` |
| `planning:error` | `reason` |
| `planning:clarification` | `questions` |
| `planning:clarification:answer` | `answers` |
| `planning:progress` | `message` |
| `planning:continuation` | `attempt`, `maxContinuations`, `reason` |
| `planning:pipeline` | `compile`, `defaultBuild`, `defaultReview`, `rationale`, `scope` |
| `planning:complete` | `planConfigs`, `plans` |
| `planning:review:start` | - |
| `planning:review:complete` | `issues` |
| `planning:evaluate:start` | - |
| `planning:evaluate:continuation` | `attempt`, `maxContinuations` |
| `planning:evaluate:complete` | `accepted`, `rejected`, `verdicts` |
| `planning:architecture:review:start` | - |
| `planning:architecture:review:complete` | `issues` |
| `planning:architecture:evaluate:start` | - |
| `planning:architecture:evaluate:continuation` | `attempt`, `maxContinuations` |
| `planning:architecture:evaluate:complete` | `accepted`, `rejected`, `verdicts` |
| `planning:cohesion:start` | - |
| `planning:cohesion:complete` | `issues` |
| `planning:cohesion:evaluate:start` | - |
| `planning:cohesion:evaluate:continuation` | `attempt`, `maxContinuations` |
| `planning:cohesion:evaluate:complete` | `accepted`, `rejected`, `verdicts` |
| `plan:build:start` | `planId` |
| `plan:build:implement:start` | `planId` |
| `plan:build:implement:progress` | `message`, `planId` |
| `plan:build:implement:continuation` | `attempt`, `maxContinuations`, `planId`, `shardId` |
| `plan:build:implement:complete` | `planId` |
| `plan:build:files_changed` | `baseBranch`, `diffs`, `files`, `planId` |
| `plan:build:review:start` | `planId` |
| `plan:build:review:complete` | `issues`, `planId` |
| `plan:build:review:parallel:start` | `perspectives`, `planId` |
| `plan:build:review:parallel:perspective:start` | `perspective`, `planId` |
| `plan:build:review:parallel:perspective:complete` | `issues`, `perspective`, `planId` |
| `plan:build:review:parallel:perspective:error` | `error`, `perspective`, `planId` |
| `plan:build:review:fix:start` | `issueCount`, `planId` |
| `plan:build:review:fix:complete` | `planId` |
| `plan:build:evaluate:start` | `planId` |
| `plan:build:evaluate:continuation` | `attempt`, `maxContinuations`, `planId` |
| `plan:build:evaluate:complete` | `accepted`, `planId`, `rejected`, `verdicts` |
| `plan:build:doc-author:start` | `planId` |
| `plan:build:doc-author:complete` | `docsAuthored`, `planId` |
| `plan:build:doc-sync:start` | `planId` |
| `plan:build:doc-sync:complete` | `docsSynced`, `planId` |
| `plan:build:test:write:start` | `planId` |
| `plan:build:test:write:complete` | `planId`, `testsWritten` |
| `plan:build:test:start` | `planId` |
| `plan:build:test:complete` | `failed`, `passed`, `planId`, `productionIssues`, `testBugsFixed` |
| `plan:build:complete` | `planId` |
| `plan:build:failed` | `error`, `planId`, `terminalSubtype` |
| `plan:build:progress` | `message`, `planId` |
| `plan:status:change` | `planId`, `status` |
| `plan:error:set` | `error`, `planId` |
| `plan:error:clear` | `planId` |
| `schedule:start` | `planIds` |
| `plan:schedule:ready` | `planId`, `reason` |
| `plan:merge:start` | `planId` |
| `plan:merge:complete` | `commitSha`, `planId` |
| `plan:merge:resolve:start` | `planId` |
| `plan:merge:resolve:complete` | `planId`, `resolved` |
| `merge:finalize:start` | `baseBranch`, `featureBranch` |
| `merge:finalize:complete` | `baseBranch`, `commitSha`, `featureBranch` |
| `merge:finalize:skipped` | `baseBranch`, `featureBranch`, `reason` |
| `merge:worktree:set` | `path` |
| `merge:worktree:clear` | - |
| `expedition:architecture:complete` | `modules` |
| `expedition:wave:start` | `moduleIds`, `wave` |
| `expedition:wave:complete` | `wave` |
| `expedition:module:start` | `moduleId` |
| `expedition:module:complete` | `moduleId` |
| `expedition:compile:start` | - |
| `expedition:compile:complete` | `plans` |
| `agent:start` | `agent`, `agentId`, `effort`, `effortClamped`, `effortOriginal`, `effortSource`, `harness`, `harnessSource`, `model`, `perspective`, `planId`, `projectMcpSelection`, `projectMcpServerNames`, `thinking`, `thinkingCoerced`, `thinkingOriginal`, `thinkingSource`, `tier`, `tierSource`, `toolbelt`, `toolbeltSource` |
| `agent:warning` | `agent`, `agentId`, `code`, `message`, `planId` |
| `agent:stop` | `agent`, `agentId`, `error`, `planId` |
| `agent:usage` | `agent`, `agentId`, `costUsd`, `final`, `numTurns`, `planId`, `usage` |
| `agent:message` | `agent`, `agentId`, `content`, `planId` |
| `agent:tool_use` | `agent`, `agentId`, `input`, `planId`, `tool`, `toolUseId` |
| `agent:tool_result` | `agent`, `agentId`, `output`, `planId`, `tool`, `toolUseId` |
| `agent:result` | `agent`, `agentId`, `planId`, `result` |
| `agent:activity` | `agent`, `agentId`, `attribution`, `files`, `notes`, `planId`, `totals` |
| `agent:retry` | `agent`, `attempt`, `label`, `maxAttempts`, `planId`, `shardId`, `subtype` |
| `validation:start` | `commands` |
| `validation:command:start` | `command` |
| `validation:command:complete` | `command`, `exitCode`, `output` |
| `validation:command:timeout` | `command`, `pid`, `timeoutMs` |
| `validation:complete` | `passed` |
| `validation:fix:start` | `attempt`, `maxAttempts` |
| `validation:fix:complete` | `attempt` |
| `prd_validation:start` | - |
| `prd_validation:complete` | `completionPercent`, `gaps`, `passed` |
| `gap_close:start` | `completionPercent`, `gapCount` |
| `gap_close:plan_ready` | `gaps`, `planBody` |
| `gap_close:complete` | `passed` |
| `reconciliation:start` | - |
| `reconciliation:complete` | `report` |
| `cleanup:start` | `planSet` |
| `cleanup:complete` | `planSet` |
| `approval:needed` | `action`, `details`, `planId` |
| `approval:response` | `approved` |
| `enqueue:start` | `source` |
| `enqueue:complete` | `filePath`, `id`, `planSet`, `title` |
| `enqueue:failed` | `error` |
| `enqueue:commit-failed` | `error` |
| `recovery:start` | `prdId`, `setName` |
| `recovery:summary` | `prdId`, `summary` |
| `recovery:complete` | `prdId`, `sidecarJsonPath`, `sidecarMdPath`, `verdict` |
| `recovery:error` | `error`, `prdId`, `rawOutput` |
| `recovery:apply:start` | `prdId` |
| `recovery:apply:complete` | `noAction`, `prdId`, `successorPrdId`, `verdict` |
| `recovery:apply:error` | `message`, `prdId` |
| `daemon:run:upsert` | `run` |
| `daemon:auto-build:paused` | `reason` |
| `daemon:lifecycle:starting` | `mode`, `pid`, `port`, `version` |
| `daemon:lifecycle:ready` | `mode`, `pid`, `port`, `recoveryDurationMs`, `version` |
| `daemon:lifecycle:shutdown:start` | `reason`, `signal` |
| `daemon:lifecycle:shutdown:complete` | `durationMs` |
| `daemon:heartbeat` | `autoBuild`, `queueDepth`, `runningBuilds`, `subscribers`, `uptime` |
| `daemon:scheduler:dequeued` | `capacityRemaining`, `prdId`, `queueDepth` |
| `daemon:scheduler:capacity-blocked` | `limit`, `queueDepth`, `runningCount` |
| `daemon:scheduler:dependency-blocked` | `blockedBy`, `prdId` |
| `daemon:scheduler:paused` | - |
| `daemon:scheduler:resumed` | - |
| `daemon:auto-build:enabled` | - |
| `daemon:auto-build:disabled` | - |
| `daemon:auto-build:resumed` | - |
| `daemon:auto-build:triggered` | `prdsEnqueued`, `trigger` |
| `daemon:recovery:start` | - |
| `daemon:recovery:run-marked-failed` | `planSet`, `reason`, `runId` |
| `daemon:recovery:lock-removed` | `path`, `pid` |
| `daemon:recovery:complete` | `durationMs`, `locksRemoved`, `runsFailed` |
| `daemon:orphan:reaped` | `pid`, `planSet`, `runId`, `sessionId` |
| `daemon:warning` | `details`, `message`, `source` |
| `daemon:error` | `message`, `source`, `stack` |
| `queue:start` | `dir`, `prdCount` |
| `queue:prd:start` | `prdId`, `title` |
| `queue:prd:discovered` | `prdId`, `title` |
| `queue:prd:stale` | `justification`, `prdId`, `revision`, `title`, `verdict` |
| `queue:prd:skip` | `prdId`, `reason` |
| `queue:prd:commit-failed` | `error`, `prdId`, `title` |
| `queue:prd:complete` | `prdId`, `status` |
| `queue:complete` | `processed`, `skipped` |
| `plan:build:decision` | `decision`, `planId` |
| `planning:decision` | `decision`, `planId` |

## JSON Schema

The complete machine-readable schema is at [`/schemas/events.schema.json`](/schemas/events.schema.json).
Use `safeParseEforgeEvent(value)` from `@eforge-build/client` to validate at runtime.
