---
title: Glossary
description: Definitions for eforge-specific terms used across the docs and agent-readable reference.
---

# Glossary

## Agent runtime profile

A named YAML file that selects the harness, model, and effort settings for eforge tiers. Profiles can live at user, project, or project-local scope and can be switched without editing `eforge/config.yaml`.

## Build source

The normalized input handed to the engine. It may originate from a CLI prompt, rough notes, a session plan, a playbook, a wrapper app, or a PRD file.

## Builder

The agent stage that implements a plan in an isolated worktree and commits the result.

## Compile phase

The once-per-build phase where eforge formats input, assesses complexity, chooses Errand/Excursion/Expedition, and writes the plan set and dependency graph.

## Daemon

The long-running background process that watches the queue, runs builds, exposes the HTTP API, and streams live events to the monitor and integrations.

## Errand, Excursion, Expedition

Workflow profiles selected by the planner. Errand handles small changes, Excursion handles multi-file work with plan review, and Expedition handles large decomposed work with architecture and cohesion review.

## Evaluator

The agent stage that judges proposed fixes against the original intent and accepts only strict improvements.

## Fixer

The agent stage that applies reviewer suggestions as candidate changes before evaluation.

## Harness

The agent execution backend used by a stage. eforge ships `claude-sdk` for the Anthropic Claude Agent SDK and `pi` for pi-agent-core multi-provider support.

## Playbook

A reusable workflow template for recurring work. Playbooks produce build source that can be enqueued like any other eforge input.

## Planner

The agent stage that sizes work, chooses the workflow profile, and writes implementation plans. This is separate from the driver-side planning conversation exposed by `/eforge:plan`.

## PRD

Product Requirements Document. A PRD file is one supported input surface, but eforge can also accept prompts, notes, session plans, playbooks, and wrapper-app input.

## Queue

The committed `eforge/queue/` directory where normalized PRDs wait for daemon processing. Queue items can depend on earlier items.

## Recovery sidecar

A structured recovery analysis artifact written for a failed build plan. It records whether eforge should retry, split, abandon, or require manual intervention.

## Reviewer

The blind review agent stage that evaluates a diff without the builder's reasoning or conversation context.

## Session plan

A driver-side planning artifact created by `/eforge:plan`. It captures scope, acceptance criteria, risks, and other dimensions before being converted into build source.

## Tier

A configuration slot such as `planning`, `implementation`, `review`, or `evaluation`. Tiers map agent roles to harness/model/effort settings.

## Worktree

An isolated git working tree used to build an individual plan without blocking or contaminating other concurrently running plans.
