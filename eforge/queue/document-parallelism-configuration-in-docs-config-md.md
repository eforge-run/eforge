---
title: Document parallelism configuration in docs/config.md
created: 2026-03-31
status: pending
---



# Document parallelism configuration in docs/config.md

## Problem / Motivation

The `docs/config.md` configuration reference is missing documentation for parallelism - a key operational concept with three distinct dimensions. The `prdQueue` YAML example block is also missing the `parallelism` field, making it harder for users to discover and configure concurrent build behavior.

## Goal

Add clear, complete parallelism documentation to `docs/config.md` so users understand how to configure and reason about concurrency at the queue level, the plan execution level, and enqueuing.

## Approach

1. Update the existing `prdQueue` YAML example block to include the `parallelism: 1` field, placed between `autoBuild` and `watchPollIntervalMs`.
2. Add a new `## Parallelism` section after the `## Config Layers` section covering all three dimensions of parallelism.

## Scope

**In scope:**
- Adding `parallelism: 1` to the `prdQueue` YAML example block
- New `## Parallelism` section documenting three dimensions:
  - **Queue processing (`prdQueue.parallelism`)** - max concurrent PRD builds from the queue, default 1, dependency-gated (PRDs wait for `depends_on` to complete, failures transitively block dependents), CLI override `--queue-parallelism <n>`
  - **Plan execution (`build.parallelism`)** - parallel plan execution within a single build via worktrees (expedition/multi-plan profiles), default is CPU core count via `os.availableParallelism()`, config only (no CLI override)
  - **Enqueuing** - always single-threaded, no config needed

**Out of scope:**
- Changes to any file other than `docs/config.md`
- Changes to actual parallelism behavior or implementation

## Acceptance Criteria

- The `prdQueue` YAML example block in `docs/config.md` includes `parallelism: 1` between `autoBuild` and `watchPollIntervalMs`
- A `## Parallelism` section exists after the `## Config Layers` section
- The Parallelism section documents queue processing parallelism (`prdQueue.parallelism`), including default value (1), dependency-gating behavior (PRDs wait for `depends_on` to complete, failures transitively block dependents), and CLI override (`--queue-parallelism <n>`)
- The Parallelism section documents plan execution parallelism (`build.parallelism`), including default value (`os.availableParallelism()`), worktree-based execution, and that it is config-only
- The Parallelism section documents that enqueuing is always single-threaded with no configuration needed
