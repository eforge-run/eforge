# Eforge Roadmap

## Hardening

**Goal**: Stabilize what exists before building new features - expand eval coverage, tune profiles with evidence, and fix rough edges in the monitor.

- **Eval scenario breadth** - More fixtures and scenarios across all three profiles (errand, excursion, expedition) so regressions surface before they ship
- **Profile tuning** - Use eval results and Langfuse traces to refine agent parameters, stage composition, and review strategies in built-in profiles

---

## Eval & Observability

**Goal**: Use evaluation data and runtime observability to drive continuous improvement of workflow profiles and agent behavior.

- **Comparative profile tuning** — Run profiles head-to-head on the same PRDs (the scenario harness already tracks pass/fail, token usage, cost, and duration per scenario). Add code quality metrics. Use outcome data to refine profiles from intuition toward evidence.

---

## Parallel Execution Reliability

**Goal**: Verify requirement fulfillment in multi-plan builds.

- **Acceptance validation agent** — Post-build agent that checks whether the implementation satisfies the original PRD requirements, not just mechanical correctness (type-check, tests). Closes the loop between what was asked for and what was built.

---

## Multimodal Input

**Goal**: Let users attach images and PDFs alongside text to give agents richer context - wireframes, bug screenshots, design specs.

- **CLI `--attach` support** - Accept image/PDF file paths on `eforge run` and `eforge enqueue`, save to temp dir, inject prompt hints so planner and builder agents read them
- **Queue attachment storage** - Companion directory alongside PRD files so attachments persist through enqueue-then-run workflows
- **Plugin skill forwarding** - Update `/eforge:run` and `/eforge:enqueue` skills to accept and forward `--attach` arguments

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **OpenRouter backend** — `AgentBackend` implementation using the `openai` npm package pointed at OpenRouter's API, unlocking 400+ models (GPT-4, Gemini, Llama, etc.) as the second provider. Requires a self-managed agent loop and tool executors since OpenRouter is a chat completion API, not an agentic framework.
- **Monorepo** — Migrate to pnpm workspaces so the engine, eval harness, eforge-plugin, monitor UI, and marketing site each get their own package with isolated deps and build configs

---

## Marketing Site (eforge.run)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.run
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
