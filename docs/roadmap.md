# Eforge Roadmap

## Planning Intelligence

**Goal**: Go from rough idea to refined, reviewed plans entirely within Claude Code.

- **Plan iteration** — Review and refine generated plans in-conversation, re-run review cycle
- **Plan templates** — Common patterns (API endpoint, migration, refactor, feature flag)

---

## Eval & Observability

**Goal**: Use evaluation data and runtime observability to drive continuous improvement of workflow profiles and agent behavior.

- **Comparative profile tuning** — Run profiles head-to-head on the same PRDs (the scenario harness and pass/fail tracking already exist). Add code quality, token cost, and time metrics. Use outcome data to refine profiles from intuition toward evidence.

---

## Parallel Execution Reliability

**Goal**: Verify requirement fulfillment in multi-plan builds.

- **Acceptance validation agent** — Post-build agent that checks whether the implementation satisfies the original PRD requirements, not just mechanical correctness (type-check, tests). Closes the loop between what was asked for and what was built.

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Provider abstraction** — Second `AgentBackend` implementation for non-SDK environments
- **npm distribution** — Publish CLI + library to npm, configure exports and files field
- **Remove roadmap skills** — Remove the roadmap-policy skill from the eforge plugin

---

## Marketing Site (eforge.run)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.run
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
