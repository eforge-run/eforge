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

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Codex backend** — `AgentBackend` implementation targeting OpenAI's Codex as the second provider, proving out the backend abstraction with a meaningfully different runtime
- **Monorepo** — Migrate to pnpm workspaces so the engine, eval harness, eforge-plugin, monitor UI, and marketing site each get their own package with isolated deps and build configs
- **npm distribution** — Publish CLI + library to npm, configure exports and files field

---

## Marketing Site (eforge.run)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.run
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
