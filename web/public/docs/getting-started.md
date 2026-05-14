---
title: Getting Started
description: Install eforge and run your first agentic build.
---

# Getting Started

eforge is an agentic build system that turns specifications into code. You describe what you want to build; eforge plans, implements, reviews, and validates it autonomously using a multi-stage pipeline across isolated worktrees.

## Prerequisites

- **Node.js 22+**
- One of: [Pi](https://github.com/earendil-works/pi-mono), [Claude Code](https://claude.ai/code), or an npm-capable shell
- An LLM credential for the runtime you choose: a provider-specific API key or OAuth token for the `pi` harness, or an Anthropic API key for the `claude-sdk` harness

## Install

### Pi package (recommended)

Start with Pi if you want the direction eforge is heading: provider-flexible, local, inspectable agent orchestration.

```bash
pi install npm:@eforge-build/pi-eforge
/eforge:init
```

Add `-l` to write to project settings (`.pi/settings.json`) instead of your global Pi settings:

```bash
pi install -l npm:@eforge-build/pi-eforge
```

### Claude Code plugin

Use the Claude Code plugin if Claude Code is already your daily environment. The surface you use to drive eforge and the runtime profile that executes builds are separate choices.

Run these three commands inside Claude Code:

```
/plugin marketplace add eforge-build/eforge
/plugin install eforge@eforge
/eforge:init
```

The `/eforge:init` command creates `eforge/config.yaml` with sensible defaults and adds `.eforge/` to your `.gitignore`. It walks you through a Quick setup (one harness and model for every tier) or a Mix-and-match flow (different harness, provider, or model per tier).

### Standalone CLI

```bash
npx @eforge-build/eforge build "Add rate limiting to the API"
```

Or install globally: `npm install -g @eforge-build/eforge`

For standalone use, run `/eforge:init` in Claude Code or Pi first to create `eforge/config.yaml` and an agent runtime profile.

## Your First Build

Once eforge is installed and initialized, start a build from Claude Code or Pi:

```
/eforge:plan
```

The `/eforge:plan` skill guides a structured planning conversation - exploring scope, architecture, and risks - before handing off to the build pipeline. When you are ready to build:

```
/eforge:build
```

Or enqueue directly with a prompt:

```
/eforge:build Add a dark mode toggle to the settings page
```

The daemon picks up the queued plan and runs the full pipeline in the background. A web monitor at `http://localhost:<port>` (port deterministically assigned per project in the 4567-4667 range) tracks progress, cost, and token usage in real time.

From the standalone CLI:

```bash
eforge build "Add a dark mode toggle to the settings page"
eforge build plans/my-feature-prd.md
```

## What Happens Next

1. **Formatting** - eforge normalizes your input into a structured PRD.
2. **Planning** - A planner agent assesses complexity and selects a workflow profile (Errand, Excursion, or Expedition), then writes a detailed plan or set of plans.
3. **Building** - Builder agents implement each plan in isolated git worktrees, in parallel where the dependency graph allows.
4. **Review** - Blind reviewers evaluate each plan's output without builder context. A fixer applies suggestions; an evaluator accepts only strict improvements.
5. **Merge** - Completed plans merge back to your branch in topological order.
6. **Validation** - Post-merge validation runs your configured commands. On failure, a validation-fixer agent attempts repairs.

## Where to Look Next

- [Concepts](./concepts) - How the pipeline works, what blind review means, and what harnesses do
- [Configuration](./configuration) - The most important config options and how to tune them
- [Glossary](./glossary) - Definitions for eforge-specific terms such as profiles, worktrees, and playbooks
- [CLI Reference](/reference/cli) - All CLI commands and flags
- [Configuration Reference](/reference/config) - Full `eforge/config.yaml` schema
