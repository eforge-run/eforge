---
title: Daemon Enqueue: Fail Fast on Invalid Config
created: 2026-03-30
status: pending
---



# Daemon Enqueue: Fail Fast on Invalid Config

## Problem / Motivation

When the daemon's `/api/enqueue` endpoint receives a request, it spawns a detached worker process (`eforge enqueue ...`) with `stdio: 'ignore'` and immediately returns a success response with a `sessionId` and `pid`. If the spawned worker crashes - e.g., because `backend` is missing from `eforge/config.yaml` - the error is silently swallowed. The caller gets a 200 response with a valid-looking session ID, but nothing is actually enqueued. No queue file is written, no git commit is created, and there is zero feedback about the failure.

This was discovered in the eval harness: repeated enqueue calls via MCP all returned success, but the queue directory was never created. Running `eforge enqueue` directly on the CLI revealed `Error: No backend configured`.

## Goal

The `/api/enqueue` endpoint should validate config before spawning the worker and return an HTTP error if the config is invalid. Worker process output should also be captured to a log file so that unexpected failures are diagnosable.

## Approach

### 1. Validate config in the enqueue endpoint before spawning

In `src/monitor/server.ts`, the `POST /api/enqueue` handler (line 1034) should load and validate the config before calling `workerTracker.spawnWorker()`. Use `loadConfig(cwd)` (already available in the codebase) and check for the required `backend` field. If invalid, return a 400/422 with a clear error message - the same error the CLI would show.

The config is already loaded in `server-main.ts` during daemon startup (line ~372), so an alternative is to pass the loaded config (or a validation result) through `options` so the endpoint can check it without re-loading. Either approach works - the key constraint is that the check happens synchronously in the request handler, before `spawnWorker()`.

### 2. Capture worker stderr to a log file

In `src/monitor/server-main.ts`, the `spawnWorker()` method (line 145) currently uses `stdio: 'ignore'`. Change this to redirect stdout and stderr to a log file so that any worker failure is diagnosable after the fact. The log file should go in the `.eforge/` directory (e.g., `.eforge/worker-<sessionId>.log` or a shared `.eforge/worker.log` with append mode). This is defense-in-depth - the config validation in approach 1 is the primary fix.

## Scope

**In scope:**
- Config validation in the `/api/enqueue` endpoint (`server.ts`)
- Worker stderr capture to log file (`server-main.ts` `spawnWorker`)

**Out of scope:**
- Changes to the MCP proxy layer (`daemon-client.ts`, `mcp-proxy.ts`) - these already propagate HTTP errors correctly
- Changes to the enqueue engine logic (`eforge.ts`, `prd-queue.ts`)
- New API endpoints or CLI commands

## Acceptance Criteria

1. `POST /api/enqueue` returns an HTTP error (4xx) with a descriptive message when `eforge/config.yaml` is missing or has no `backend` field.
2. The MCP caller receives the error (not a fake success with a `sessionId`).
3. Spawned worker processes have their stderr captured to a log file in `.eforge/`.
4. `autoBuild` in the enqueue response reflects the actual config value, not the initial `false`.
