# Eforge Roadmap

## Eval & Observability

**Goal**: Use evaluation data and runtime observability to drive evidence-based improvement of workflow profiles and agent behavior.

- **Code quality metrics** — Add static analysis metrics (complexity, duplication, lint violations) to the eval harness so profile tuning goes beyond pass/fail, tokens, and cost
- **Comparative profile tuning** — Run profiles head-to-head on the same PRDs and use outcome data (including code quality) to refine profiles from intuition toward evidence
- **Acceptance coverage gaps** — Detect PRD requirements that lack corresponding test cases and flag builds where acceptance coverage is incomplete

---

## Daemon & MCP Server

**Goal**: Extend the daemon as the single orchestration authority with richer controls and safety checks.

- **Queue reordering & priority** — Web UI and MCP controls for reordering queued PRDs and setting build priority
- **Re-guidance** — Build interruption with amended context, daemon-to-worker IPC for mid-build guidance changes
- **Plugin–engine version compatibility** — Add `version` to the daemon health endpoint and `minEngineVersion` to plugin.json. The MCP proxy checks compatibility at startup and warns (or refuses) if the installed eforge version is too old for the plugin.

---

## Multimodal Input

**Goal**: Let users attach images and PDFs alongside text to give agents richer context - wireframes, bug screenshots, design specs.

- **CLI `--attach` support** - Accept image/PDF file paths on `eforge run` and `eforge enqueue`, save to temp dir, inject prompt hints so planner and builder agents read them
- **Queue attachment storage** - Companion directory alongside PRD files so attachments persist through enqueue-then-run workflows
- **Plugin skill forwarding** - Update `/eforge:build` skill to accept and forward `--attach` arguments

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Multi-provider backend via pi-mono** — `AgentBackend` implementation using `@mariozechner/pi-ai` (unified LLM streaming, 20+ direct providers including OpenAI, Anthropic, Google, Mistral, Groq, xAI, Bedrock, Azure, OpenRouter) and `@mariozechner/pi-agent-core` (agent loop with built-in coding tools: read, write, edit, bash). Three integration layers: (1) event translation from pi's lifecycle events (`agent_start`, `turn_start`, `message_update`, `tool_execution_start/end`, `agent_end`) to eforge's `EforgeEvent`s, (2) MCP bridge wrapping MCP server tools as pi `AgentTool` instances (TypeBox schemas), and (3) TypeBox↔Zod schema adapter for tool parameter definitions. Pi provides AbortSignal support and cache token tracking (Anthropic models) out of the box.
- **Monorepo** — Extend pnpm workspaces (currently only monitor UI) so the engine, eval harness, eforge-plugin, and marketing site each get their own package with isolated deps and build configs

---

## Marketing Site (eforge.build)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.build
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
