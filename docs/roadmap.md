# Eforge Roadmap

## Daemon & MCP Server

**Goal**: Extend the daemon as the single orchestration authority with richer controls and safety checks.

- **Queue reordering & priority** — MCP tool and web UI controls for changing priority on queued PRDs at runtime (priority field exists in frontmatter and affects execution order, but there's no way to modify it after enqueue)
- **Re-guidance** — Build interruption with amended context, daemon-to-worker IPC for mid-build guidance changes
- **Plugin-engine version compatibility** — Add `version` to the daemon health endpoint and `minEngineVersion` to plugin.json. The MCP proxy checks compatibility at startup and warns (or refuses) if the installed eforge version is too old for the plugin.
- **Config initialization via MCP elicitation** — Add `init` action to `eforge_config` tool that walks users through `eforge/config.yaml` setup via interactive form steps (basics, build settings, integrations) using the MCP elicitation protocol

---

## Multimodal Input

**Goal**: Let users attach images and PDFs alongside text to give agents richer context - wireframes, bug screenshots, design specs.

- **CLI `--attach` support** - Accept image/PDF file paths on `eforge run` and `eforge enqueue`, save to temp dir, inject prompt hints so planner and builder agents read them
- **Queue attachment storage** - Companion directory alongside PRD files so attachments persist through enqueue-then-run workflows
- **Plugin skill forwarding** - Update `/eforge:build` skill to accept and forward `--attach` arguments

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Test and evaluate pi backend** — PiBackend is implemented but not yet tested end-to-end. Run builds against real providers, compare output quality and cost against ClaudeSDKBackend, and fix integration gaps.
- **OpenAI Agents JS backend** — Evaluated (`@openai/agents` v0.8.1) and deferred. PiBackend already covers OpenAI models with turnkey coding tools. The SDK lacks a coding agent preset (Shell/Editor must be implemented from scratch) and is pre-1.0. Revisit when OpenAI ships a turnkey coding preset or a unique feature (hosted code interpreter, multi-agent handoffs) becomes valuable.
- **Monorepo** — Extend pnpm workspaces (currently only monitor UI) so the engine, eforge-plugin, and marketing site each get their own package with isolated deps and build configs

---

## Marketing Site (eforge.build)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.build
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
