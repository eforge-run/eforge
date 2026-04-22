# eforge

[![npm version](https://img.shields.io/npm/v/@eforge-build/eforge)](https://www.npmjs.com/package/@eforge-build/eforge)
[![npm pi package](https://img.shields.io/npm/v/@eforge-build/pi-eforge)](https://www.npmjs.com/package/@eforge-build/pi-eforge)

An open source agentic build system for engineers who want to stay close to the code without writing or reviewing it. You're the detail planner — specs, architecture, decisions. eforge handles implementation, blind review, and validation in the background.

You drive eforge from the coding agent you already use (Claude Code or Pi). eforge delegates each pipeline stage to the agent library you configure — the Claude Agent SDK or pi-agent-core. Both paths let you use a subscription you already pay for: Claude Max on the SDK side, OpenAI Codex on the Pi side (plus 20+ other providers via Pi including open source and local models). The two choices are independent, so your UI doesn't lock you into a model.

The name: **E** from the [Expedition-Excursion-Errand methodology](https://www.markschaake.com/posts/expedition-excursion-errand/) + **forge** - shaping code from plans.

<img src="docs/images/monitor-full-pipeline.png" alt="eforge dashboard - full pipeline" width="800">

> **Status:** This is a young project moving fast. Used daily to build real features (including itself), but expect rough edges - bugs are likely, change is expected, and YMMV. Source is public so you can read, learn from, and fork it. Not accepting issues or PRs at this time.

## Why eforge

**Stay close, don't write.** You plan every detail — reading specs, making architecture decisions, understanding every choice before handoff. eforge implements faithfully and reviews its own output blind; you stay in control without being in the code.

**Use the tools you already pay for.** Drive eforge from Claude Code or Pi. Delegate execution to the Claude Agent SDK (your Claude Max subscription works) or pi-agent-core (your OpenAI Codex subscription works; plus Google, Mistral, Groq, xAI, Bedrock, Azure, OpenRouter, local models, and more). Mix and match — your UI and your execution stack don't have to share a vendor.

## What is an Agentic Build System?

Traditional build systems transform source code into artifacts. An agentic build system transforms *specifications* into source code - then verifies its own output.

The key insight: a single AI agent writing and reviewing its own code will almost always approve it. Quality requires **separation of concerns** - distinct agents for planning, building, reviewing, and evaluating.

An agentic build system applies build-system thinking to this multi-agent pipeline:

- **Spec-driven** - Input is a requirement, not a code edit. The system decides *how* to implement it.
- **Multi-stage pipeline** - Planning, implementation, review, and validation are separate stages with separate agents, not one conversation.
- **Blind review** - The reviewer operates without builder context (see below).
- **Dependency-aware orchestration** - Large work decomposes into modules with a dependency graph. Plans build in parallel across isolated git worktrees, merging in topological order.
- **Adaptive complexity** - The system assesses scope and selects the right workflow: a one-file fix doesn't need architecture review, and a cross-cutting refactor shouldn't skip it.

## Use Cases

Plan a feature interactively, then hand it off to eforge with `/eforge:build`. A daemon picks up the plan and runs planning, building, blind review, and validation autonomously. A web monitor (default `localhost:4567`) tracks progress, cost, and token usage in real time.

Because the coding agent you drive from and the agent library eforge delegates to are independent, a few ways this plays out:

- **Plan and execute on Claude.** Drive eforge from Claude Code and delegate to the Claude Agent SDK. Your Claude Max subscription covers both sides.
- **Plan and execute on OpenAI.** Drive eforge from Pi and delegate to pi-agent-core with GPT-5.4. Your OpenAI Codex subscription covers both sides.
- **Plan in Pi with GPT-5.4, execute on Claude.** Plan with a different model, then hand off to the Claude Agent SDK for the build via your Max subscription.
- **Plan with Opus in Claude Code, execute via pi-agent-core.** Plan with the model you trust, then dispatch builds across GPT-5.4, OpenRouter, or local models — match the tool to the workload.
- **Claude Code outage?** Switch to Pi and flip eforge's delegation to pi-agent-core. Keep working. No vendor owns your workflow.

<img src="docs/images/claude-code-handoff.png" alt="eforge invoked from Claude Code" width="800">

eforge also runs standalone. By default, `eforge build` enqueues and a daemon processes it. Use `--foreground` to run in the current process instead.

## How It Works

**Formatting and enqueue** - Whatever you hand eforge - a prompt, rough notes, a session plan, a detailed PRD - gets normalized into a structured PRD and committed to a queue directory on the current branch. The daemon watches this queue and picks up new PRDs to build.

**Workflow profiles** - The planner assesses complexity and selects a profile:
- **Errand** - Small, self-contained changes. Passthrough compile, fast build.
- **Excursion** - Multi-file features. Planner writes a plan, blind review cycle, then build.
- **Expedition** - Large cross-cutting work. Architecture doc, module decomposition, cohesion review across plans, parallel builds in dependency order.

**Blind review** - Every build gets reviewed by a separate agent with no builder context. Separating generation from evaluation [dramatically improves quality](https://www.anthropic.com/engineering/harness-design-long-running-apps) - solo agents tend to approve their own work regardless. A fixer applies suggestions, then an evaluator accepts strict improvements while rejecting intent changes. The goal is fidelity to the plan - minimizing drift and slop so the code that lands is what was specified, not a reinterpretation.

**Parallel orchestration** - Each plan builds in an isolated git worktree. Expeditions run multiple plans in parallel, merging in topological dependency order. Post-merge validation runs with auto-fix.

<img src="docs/images/monitor-timeline.png" alt="eforge dashboard - timeline view" width="800">

**Queue and merge** - Completed builds merge back to the base branch as merge commits via `--no-ff`, preserving the full branch history while keeping first-parent history clean. When the next build starts from the queue, the planner re-evaluates against the current codebase - so plans adapt to changes that landed since they were enqueued.

<img src="docs/images/eforge-commits.png" alt="eforge commits from an expedition build" width="800">

For a deeper look at the engine internals, see the [architecture docs](docs/architecture.md). For context on the workflow shift that motivated eforge, see [The Handoff](https://www.markschaake.com/posts/the-handoff/).

## Install

**Prerequisites:** Node.js 22+, [Claude Code](https://claude.ai/code) or [Pi](https://github.com/nicories/pi-mono), and an LLM provider credential - Anthropic API key or [Claude subscription](https://claude.ai/upgrade) for the `claude-sdk` backend, or a provider-specific API key or OAuth token for the `pi` backend

Claude Code plugin:

```
/plugin marketplace add eforge-build/eforge
/plugin install eforge@eforge
/eforge:init
```

Pi package:

```bash
pi install npm:@eforge-build/pi-eforge
/eforge:init
```

Add `-l` to `pi install` if you want to write to project settings (`.pi/settings.json`) instead of your global Pi settings:

```bash
pi install -l npm:@eforge-build/pi-eforge
```

The main `@eforge-build/eforge` npm package is the standalone CLI and daemon runtime. The Pi integration is published separately as `@eforge-build/pi-eforge`.

The `/eforge:init` command creates `eforge/config.yaml` with sensible defaults and adds `.eforge/` to your `.gitignore`. In Claude Code it presents a form to choose your backend (`claude-sdk` or `pi`); in Pi it defaults to `backend: pi`. For further customization, run `/eforge:config --edit`.

The Pi package also provides native interactive commands for backend profile management (`/eforge:backend`, `/eforge:backend:new`) and config viewing (`/eforge:config`) with interactive overlay UX. Both the Claude Code plugin and the Pi extension expose `/eforge:plan` for structured planning conversations — exploring scope, code impact, architecture, design decisions, documentation, and risks — before handing off to `/eforge:build`.

Standalone CLI:

```bash
npx @eforge-build/eforge build "Add rate limiting to the API"
npx @eforge-build/eforge build plans/my-feature-prd.md
```

Or install globally: `npm install -g @eforge-build/eforge`

For standalone use, create `eforge/config.yaml` with at minimum `backend: claude-sdk` (or `backend: pi` for the Pi multi-provider backend).

## Configuration

Configured via `eforge/config.yaml` (searched upward from cwd), a global config at `~/.config/eforge/config.yaml`, environment variables, and auto-discovered files. Backend profiles, custom workflow profiles, hooks, MCP servers, and plugins are all configurable. Backend profiles can be scoped to a project (`eforge/backends/`) or to the user (`~/.config/eforge/backends/`) for reuse across projects. See [docs/config.md](docs/config.md) and [docs/hooks.md](docs/hooks.md).

## Development

```bash
pnpm build        # Bundle all workspace packages
pnpm test         # Run unit tests (vitest)
pnpm type-check   # Type check without emitting
```

### npx convention

The eforge plugin uses `npx -y @eforge-build/eforge` to invoke the CLI. This ensures the plugin works for all users regardless of install method - global install, npx, or local development. The `-y` flag auto-confirms install prompts, which is required because the MCP server runs headless and cannot prompt interactively.

### Developer workflow

When developing eforge locally, `pnpm build` compiles the CLI to `dist/cli.js` and makes `eforge` available on PATH via the `bin` entry in `package.json`. After making changes to the engine or CLI, rebuild with `pnpm build` so the daemon picks up the latest code.

To restart the daemon after a local rebuild, use `/eforge:restart` from Claude Code. This calls the daemon's MCP tool to safely stop and restart, checking for active builds first.

For the eforge repository itself, the `/eforge-daemon-restart` project-local skill rebuilds from source and restarts the daemon in one step.

## Evaluation

See [eforge-build/eval](https://github.com/eforge-build/eval) for the end-to-end evaluation harness.

## License

eforge is licensed under [Apache-2.0](LICENSE).

### Third-party backend licenses

eforge's backend abstraction allows different AI providers. Each backend carries its own license terms:

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) is proprietary software owned by Anthropic PBC. By using eforge with this backend, you agree to Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (API users) or [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (Free/Pro/Max users), plus the [Acceptable Use Policy](https://www.anthropic.com/legal/aup). See [Anthropic's legal page](https://code.claude.com/docs/en/legal-and-compliance) for details.

  **Note:** If you are building a product or service on top of eforge, Anthropic requires API key authentication through [Claude Console](https://platform.claude.com/) - OAuth tokens from Free, Pro, or Max plans may not be used for third-party products.

- **Pi backend** (`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`) - a fully open-source backend alternative supporting 20+ LLM providers (OpenAI, Google, Mistral, Groq, xAI, Bedrock, Azure, OpenRouter, and more). All three packages are [MIT licensed](https://github.com/nicories/pi-mono/blob/main/LICENSE) from the [pi-mono](https://github.com/nicories/pi-mono) monorepo.

eforge's Apache 2.0 license applies to eforge's own source code. It does not extend to or override the license terms of its dependencies.
