# Eforge Roadmap

## Planning Intelligence

**Goal**: Go from rough idea to refined, reviewed plans entirely within Claude Code.

- **Plan iteration** — Review and refine generated plans in-conversation, re-run review cycle
- **Plan templates** — Common patterns (API endpoint, migration, refactor, feature flag)

---

## Configurable Workflow Profiles

**Goal**: Make the agent pipeline a tunable, config-driven system where profiles define how work gets planned, built, and reviewed - and eval data drives refinement over time.

- **Profile engine** — Declarative workflow configs that define the agent pipeline: which agents run, in what order, with what prompts and constraints. Expedition/excursion/errand become built-in profiles alongside user-defined ones (migration, security-audit, refactor-only, etc.)
- **Pluggable review strategies** — Review cycle parameters as config: number of rounds, severity thresholds for auto-accept, evaluator strictness, specialized reviewer prompts (correctness vs style vs security)
- **Dynamic profile generation** — Agent reads the PRD, picks a base profile, and generates per-run overrides (or a full profile from scratch when no base fits). Same ResolvedProfileConfig output, but tailored to the specific work rather than selected from a menu.
- **Eval-driven tuning** — Extend the eval framework to compare profiles head-to-head on the same PRDs. Track pass rate, code quality, token cost, and time. Use outcome data to refine profiles from intuition toward evidence.

---

## Parallel Execution Reliability

**Goal**: Eliminate merge conflicts and verify requirement fulfillment in multi-plan builds.

- **Edit region markers** — During expedition planning, detect shared files across modules and insert marker regions so each builder knows its edit boundaries. Prevents conflicts at the source rather than resolving them after the fact.
- **Merge conflict resolver agent** — When conflicts do occur, an agent that reads both sides of the conflict, understands the intent from each plan, and makes an intelligent resolution (infrastructure already wired via `MergeResolver` callback).
- **Acceptance validation agent** — Post-build agent that checks whether the implementation satisfies the original PRD requirements, not just mechanical correctness (type-check, tests). Closes the loop between what was asked for and what was built.

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Headless/CI** — `--json` CLI output flag, webhook notifications
- **Provider abstraction** — Second `AgentBackend` implementation for non-SDK environments
- **npm distribution** — Publish CLI + library to npm, configure exports and files field
- **Plugin consolidation** — Deprecate orchestrate + EEE plugins, migration guide

---

## Marketing Site (eforge.run)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.run
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
