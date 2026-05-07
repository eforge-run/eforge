# Eforge Roadmap

## Daemon & MCP Server

**Goal**: Extend the daemon as the single orchestration authority with richer controls and safety checks.

- **Queue reordering & priority** — MCP tool and web UI controls for changing priority on queued PRDs at runtime (priority field exists in frontmatter and affects execution order, but there's no way to modify it after enqueue)
- **Re-guidance** — Build interruption with amended context, daemon-to-worker IPC for mid-build guidance changes
- **Daemon version in health endpoint** — Add `version` (from `package.json`) and `apiVersion` (from `DAEMON_API_VERSION` in `@eforge-build/client`) to `/api/health` so the MCP proxy, Pi extension, and external scripts can self-diagnose version skew. No enforcement layer yet — pure observability. Unblocked by `@eforge-build/client` extraction.

---

## Orchestrator Intelligence

**Goal**: Make the orchestrator's review-cycle decisions adaptive and observable.

- **Adaptive reviewer respawn** — First review pass spawns the full set of reviewer perspectives the planner specified. Subsequent passes (after a fixer round) should respawn only the subset whose perspective is still relevant given the prior review results and the nature of the fixes made, rather than always defaulting to the full set. Should also account for overlap between reviewer perspectives so concerns aren't double-counted.
- **Remove severity filter from review cycle** — Drop `autoAcceptBelow` from the review profile and delete `filterIssuesBySeverity` from the cycle. Nobody uses the opt-in, and "what counts as worth fixing" belongs in reviewer prompts, not engine config. Termination becomes "reviewers reported zero issues." Severity stays on `ReviewIssue` for fixer ordering and UI display.
- **Per-reviewer hover scoping in monitor UI** — Hovering a reviewer or fixer node in the pipeline view currently shows issue counts aggregated across the whole build phase, which is misleading when multiple reviewer perspectives ran in parallel. Scope the hover to the specific agent instance: for a reviewer, show its perspective and only the issues it reported; for the fixer, show what it actually addressed. Correlate by agent ID / perspective from the existing event stream — no schema changes needed.
- **Orchestrator decision events** — Emit typed events with rich context whenever the orchestrator makes a decision across any phase (plan and build): planner choices (which reviewer perspectives, parallelism, depth), build-stage choices (which reviewers to spawn, when to stop the review cycle, when to escalate), etc. Surface these in the monitor UI so users can see why the pipeline took a given path. Event name is TBD — needs to fit the existing `phase:stage:action` event taxonomy in `@eforge-build/client`.

---

## Multimodal Input

**Goal**: Let users attach images and PDFs alongside text to give agents richer context - wireframes, bug screenshots, design specs.

- **CLI `--attach` support** - Accept image/PDF file paths on `eforge run` and `eforge enqueue`, save to temp dir, inject prompt hints so planner and builder agents read them
- **Queue attachment storage** - Companion directory alongside PRD files so attachments persist through enqueue-then-run workflows
- **Plugin skill forwarding** - Update `/eforge:build` skill to accept and forward `--attach` arguments

---

## Integration & Maturity

**Goal**: Full lifecycle coverage, CI support, provider flexibility.

- **Low-fidelity input handling** — When the user provides a high-level prompt with minimal detail, eforge should perform thorough codebase exploration before compiling plans. May require a new exploration agent (or parallel exploratory agents) that activates for low-fidelity input and is bypassed for detailed PRDs.
- **Specialty agents** — Identify and implement domain-specific agents for common use cases beyond the current plan-build-review pipeline
- **Plugin skill coverage** — Add skills for common scenarios, e.g. `/eforge:update-docs` with flags like `--architecture`, `--readme`, `--claude-md` for targeted documentation updates
- **Schema library unification on TypeBox** — Standardize on TypeBox across the codebase. TypeBox schemas are JSON Schema natively (no `z.toJSONSchema()` conversion), already in the dep tree for Pi, and align with Pi's tool API. Prerequisite for shared tool registry.
- **Shared tool registry** — Factor tool definitions into `@eforge-build/client` so MCP proxy and Pi extension become thin adapters. Eliminates remaining ~400 lines of cross-package tool-definition duplication. Depends on schema library unification.
- **Pi extension SSE event streaming** — Add SSE subscriber to Pi extension for live build progress via Pi `ExtensionAPI` channel.
- **TypeScript project references** — Adopt `tsconfig.json` `references` across workspace members for automatic topological ordering.

### Boundary guardrail

Scheduling, triggers, approvals, notifications, and richer workflow orchestration belong in wrapper apps built on stable eforge APIs, not in the engine. The build engine consumes normalized PRD/build source and emits typed events; reusable input-artifact protocols (playbooks, session plans) live in `@eforge-build/input`; scope and path lookup lives in `@eforge-build/scopes`. Wrapper apps may compose these packages directly or call the daemon HTTP client (`@eforge-build/client`). New scheduling or workflow features proposed for the engine or daemon should be challenged against this guardrail - if it belongs in a wrapper app, keep it there.

---

## Marketing Site (eforge.build)

**Goal**: Public-facing site for docs, demos, and project visibility.

- **Next.js app** — `web/` directory, deployed to Vercel at eforge.build
- **Landing page** — Value prop, feature overview, getting-started guide
- **Documentation** — Usage docs, configuration reference, examples
