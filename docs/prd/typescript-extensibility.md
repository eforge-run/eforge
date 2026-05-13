---
title: "Native TypeScript Extensions for eforge"
scope: expedition
depends_on: []
---

# Native TypeScript Extensions for eforge

## Problem / Motivation

eforge already has several extension-adjacent mechanisms: shell hooks, prompt overrides, MCP servers, Claude Code plugins, Pi extensions, playbooks, session plans, named agent runtime profiles, and an internal stage registry. These are useful, but they are fragmented and not designed around the strongest UX from Pi: a user can tell the coding agent what behavior they want, and the agent can read Pi's docs/types/examples, create an extension, validate it, and reload it.

We want the same experience for eforge:

> Tell Pi or Claude Code what eforge behavior you want; `/eforge:extend` creates, installs, validates, and tests the extension for you.

This requires more than a runtime loader. eforge needs a small, typed, agent-friendly extension API; canonical docs and examples; CLI/daemon tools for scaffolding and validation; and matching Pi + Claude Code integration skills/tools that make extension authoring seamless.

## Goals

1. Add native TypeScript extensions for eforge lifecycle behavior.
2. Make extension authoring agent-native: Pi and Claude Code should be able to scaffold and validate extensions from user intent.
3. Keep eforge's architecture intact: engine emits typed events, consumers render, daemon orchestrates, wrapper apps own broad workflow automation.
4. Prioritize safe, high-value extension points before exposing full custom build stages.
5. Support per-build profile routing so extensions can choose among named agent runtime profiles based on quota, cost, priority, or workload.

## Non-goals / Guardrails

- Do not turn eforge into a general workflow automation platform. Scheduling, rich approvals, notifications, and external workflows should remain wrapper-app territory unless they directly affect eforge build lifecycle behavior.
- Do not initially expose arbitrary custom compile/build stages. Stage registration is powerful but tightly coupled to orchestration, worktrees, commits, recovery, monitor rendering, and event contracts.
- Do not copy Pi's UI/TUI extension APIs wholesale. eforge extensions should focus on builds, queueing, agent context, validation, policy, and events.
- Do not mutate active profile marker files for routing. Profile selection should be per-build whenever possible.

## Proposed User Experience

### `/eforge:extend`

Both `packages/pi-eforge/` and `eforge-plugin/` should expose an assisted extension-authoring command/skill:

```text
/eforge:extend
```

Example user request:

> Create an eforge extension that blocks merges if `.env` changes, and notifies Slack when a build fails.

The skill should:

1. classify the desired extension type(s),
2. read bundled eforge extension docs and examples,
3. choose an extension scope,
4. scaffold the extension,
5. add or update extension config,
6. validate/type-check the extension,
7. optionally test it against fixtures or recent event logs,
8. reload/restart the daemon if needed,
9. summarize what was installed and how to modify/promote it.

### Extension scopes

Mirror eforge's existing scope model:

| Scope | Path | Purpose |
|---|---|---|
| User | `~/.config/eforge/extensions/` | Personal extensions reusable across projects |
| Project/team | `eforge/extensions/` | Shared, committed team extensions |
| Project-local | `.eforge/extensions/` | Local experiments and personal project overrides |

Project-local should be the default for generated experimental extensions. Promotion can move an extension from `.eforge/extensions/` to `eforge/extensions/`, similar to playbooks.

### CLI / daemon management commands

Add a native extension management surface so agents do not have to guess filesystem details:

```bash
eforge extension new <name> [--scope local|project|user] [--template <template>]
eforge extension list
eforge extension show <name>
eforge extension validate [name|path]
eforge extension test [name|path] [--run latest|<sessionId>] [--event <type>] [--fixture <path>]
eforge extension enable <name>
eforge extension disable <name>
eforge extension promote <name>
eforge extension demote <name>
eforge extension reload
```

Expose matching daemon API/client helpers and MCP/Pi tools, for example:

- `eforge_extension_scaffold`
- `eforge_extension_validate`
- `eforge_extension_test`
- `eforge_extension_list`
- `eforge_extension_reload`

## Relationship to Profile Toolbelts

Native TypeScript extensions and profile toolbelts are complementary but intentionally separate concepts:

- **Toolbelts** are declarative MCP capability bundles selected by agent runtime profiles. They answer: "Which project MCP servers should this tier expose?"
- **Extensions** are imperative TypeScript modules that observe or influence eforge lifecycle behavior. They answer: "What should eforge do when something happens?"

Extensions may inspect profile metadata, tags, and toolbelt assignments when making decisions such as per-build profile routing. For example, a profile router may prefer profiles tagged `ui` for frontend-heavy PRDs or prefer profiles whose implementation tier uses a browser toolbelt. However, extensions should not redefine toolbelts or become a hidden profile/config layer.

Toolbelt-selected MCP tools and extension-contributed custom tools should remain distinct categories in the effective tool surface:

```text
engine-internal tools
+ profile/toolbelt-selected project MCP tools
+ extension-contributed custom tools
- explicit allowed/disallowed filters
```

Toolbelt filtering applies only to project MCP servers from `.mcp.json`. It must not filter engine-internal submission tools, harness built-ins, or extension-contributed custom tools.

## Proposed Extension API Shape

Use a small factory-style API, similar in feel to Pi but scoped to eforge concepts:

```ts
import type { EforgeExtensionAPI } from "@eforge-build/extension-sdk";
import { Type } from "typebox";

export default function extension(eforge: EforgeExtensionAPI) {
  eforge.onEvent("plan:build:failed", async (event, ctx) => {
    ctx.logger.warn(`Plan failed: ${event.planId}`);
  });

  eforge.beforePlanMerge(async ({ diff }, ctx) => {
    if (diff.files.some((f) => f.path === ".env")) {
      return { decision: "block", reason: "Do not modify .env" };
    }
    return { decision: "allow" };
  });
}
```

The SDK should export:

- `EforgeExtensionAPI`, `EforgeExtensionContext`, and hook result types,
- typed `EforgeEvent` and event pattern helpers,
- tool definition helpers,
- extension config helpers,
- test harness / event replay helpers,
- examples and templates.

Prefer TypeBox for public schemas to align with Pi and the roadmap item to standardize schemas on TypeBox.

## Extension Point Roadmap

### Phase 1: Typed event extensions

Safest first layer: TypeScript equivalents of shell hooks.

```ts
eforge.onEvent("session:end", async (event, ctx) => {
  if (event.result.status === "failed") {
    await ctx.exec("notify-send", ["eforge build failed"]);
  }
});
```

Properties:

- receives typed `EforgeEvent`,
- supports glob-style patterns,
- timeout-bounded,
- errors are emitted/logged but do not mutate the build,
- suitable for notifications, metrics, audit, and dashboards.

### Phase 2: Agent context and tool extensions

Let extensions adjust agent runs in controlled ways:

- append prompt context,
- add custom tools,
- tune allowed/disallowed tools,
- inspect role, tier, profile, plan, and changed files,
- emit observable decisions.

```ts
eforge.onAgentRun("builder", async (run, ctx) => ({
  promptAppend: "Use the design-system lookup tool before changing UI components.",
  tools: [designSystemLookupTool],
}));
```

This maps naturally to the existing `AgentHarness` abstraction and custom tool support.

### Phase 3: Policy gates

Blocking hooks with explicit return values:

- before enqueue,
- before queue dispatch,
- before plan merge,
- before final merge,
- before validation.

```ts
eforge.beforePlanMerge(async ({ planId, diff }, ctx) => {
  if (diff.files.some((f) => f.path.endsWith(".sql"))) {
    return {
      decision: "require-approval",
      reason: "Database changes require human approval",
    };
  }
  return { decision: "allow" };
});
```

Policy hooks require strict behavior:

- explicit allow/block/modify contracts,
- timeout and failure policy,
- all decisions emitted as events,
- no hidden mutation.

### Phase 4: Input transformers and enrichers

Custom source adapters and PRD enrichment should live near `@eforge-build/input`:

- Linear/Jira/GitHub issue expansion,
- label-based acceptance criteria,
- linked design/spec retrieval,
- repo-specific Definition of Done injection.

```ts
eforge.registerInputSource("linear", {
  async normalize(source, ctx) {
    const issue = await ctx.fetchLinearIssue(source.id);
    return {
      title: issue.title,
      body: issue.description,
      acceptanceCriteria: issue.labels.includes("bug")
        ? "Regression test required"
        : undefined,
    };
  },
});
```

### Phase 5: Limited stage-like APIs

Avoid full `registerBuildStage` initially. Start with safer high-level extension points:

- custom reviewer perspectives,
- custom validation providers,
- custom recovery classifiers,
- documentation sync providers.

Example:

```ts
eforge.registerReviewerPerspective("accessibility", {
  description: "Review UI changes for accessibility issues",
  appliesTo: ({ changedFiles }) => changedFiles.some((f) => f.path.endsWith(".tsx")),
});
```

Full compile/build stage registration can be reconsidered once lower-risk extension APIs are proven.

## Profile Routing / Usage-Aware Model Fallback

A particularly valuable use case is selecting an agent runtime profile per build based on usage, quota, cost, or provider health.

eforge already supports per-build profile overrides (`--profile`, enqueue profile field, and PRD frontmatter profile). A native extension should be able to choose among profiles such as:

- `claude-sdk-4-7`,
- `codex-5-5`,
- `deepseek-qwen-local`.

Example extension API:

```ts
export default function extension(eforge: EforgeExtensionAPI) {
  eforge.registerProfileRouter({
    name: "quota-aware-router",
    async selectBuildProfile(ctx) {
      const claude = await ctx.usage.profile("claude-sdk-4-7");
      const codex = await ctx.usage.profile("codex-5-5");

      if (!claude.nearLimit) {
        return {
          profile: "claude-sdk-4-7",
          reason: "Claude usage is healthy",
        };
      }

      if (!codex.nearLimit) {
        return {
          profile: "codex-5-5",
          reason: "Claude is near limit; using Codex",
        };
      }

      return {
        profile: "deepseek-qwen-local",
        reason: "Cloud profiles are near limit; using local fallback",
      };
    },
  });
}
```

### Preferred first implementation

Support **pre-build profile routing** first:

1. extension evaluates at enqueue or dispatch time,
2. eforge validates the selected profile exists,
3. eforge stamps the queue item/frontmatter with `profile`,
4. worker starts with `--profile <name>`,
5. emit a decision event such as `queue:profile:selected`.

This is much simpler and safer than switching profiles mid-build.

### Later fallback behavior

A later phase could add quota-failure handling:

```ts
eforge.onQuotaFailure(async (ctx) => ({
  action: "retry-with-profile",
  profile: "codex-5-5",
}));
```

This should retry/requeue a build with the next profile rather than mutating harness/profile state mid-run.

### Usage signal caveat

Exact quota data may not be available for subscription/OAuth providers. The usage API may need to combine:

- eforge token/cost events,
- local rolling counters,
- provider response/rate-limit errors,
- configurable thresholds,
- cooldown windows after quota failures,
- manual override state.

## High-value Use Cases

### 1. Project policy gates

- Block edits to `.env`, secrets, generated files, production config, or CI deploy files.
- Require approval before database migrations.
- Reject public API changes without docs/changelog updates.
- Prevent dependency additions without justification.

### 2. Custom reviewer perspectives

- accessibility,
- privacy/user-data handling,
- security for auth/payment paths,
- API compatibility,
- performance for hot paths,
- design-system compliance,
- migration safety,
- i18n/localization.

### 3. Internal context and tools for agents

- internal documentation search,
- design-system component lookup,
- database schema lookup,
- service ownership lookup,
- feature flag registry lookup,
- API contract registry lookup,
- incident history lookup,
- repo architecture maps.

### 4. PRD enrichment and input adapters

- fetch Linear/Jira/GitHub issue details,
- pull linked designs/specs,
- inject acceptance criteria from labels,
- require Definition of Done sections,
- expand terse bug references into rich PRDs.

### 5. Smarter validation

- affected-package tests via Nx/Turborepo/Bazel/SBT,
- contract tests when API schemas change,
- screenshot tests when UI routes change,
- migration dry-runs for DB changes,
- flaky-test retry classification.

### 6. Ownership and approval workflows

- map changed files to CODEOWNERS,
- notify owning Slack channels,
- block sensitive merges until approval sidecar exists,
- tag relevant GitHub/Linear reviewers.

### 7. Notifications and status integrations

- Slack/Discord notifications,
- GitHub PR/commit comments,
- Linear/Jira status updates,
- Datadog events,
- desktop/email build summaries.

### 8. Cost, quota, and model routing

- prefer Claude until usage limits approach,
- fall back to Codex,
- fall back to local profiles,
- route docs-only builds to cheaper models,
- prevent expensive profiles for low-priority queue items.

### 9. Compliance and audit trails

- persist run summaries/events to S3/BigQuery,
- record model IDs and prompts for audit,
- detect PII-related changes,
- require privacy/security review for user-data paths.

### 10. Monorepo intelligence

- identify impacted packages,
- enforce package boundaries,
- inject owning package docs,
- select validation commands from workspace graph.

### 11. Recovery and failure triage

- classify failures as infra/flaky/code,
- retry transient provider failures,
- attach CI logs to recovery analysis,
- create follow-up PRDs for unresolved gaps.

### 12. Documentation automation

- require README updates when public commands change,
- sync architecture docs after module boundary changes,
- update changelogs,
- enforce docs for new config keys,
- validate examples compile.

## Documentation and Examples Required

Ship canonical docs and examples with eforge, and make both integrations point agents to them:

```text
docs/extensions.md
docs/extensions-api.md
examples/extensions/
packages/extension-sdk/
```

Example templates should include:

- `event-logger.ts`,
- `slack-notifier.ts`,
- `protected-paths.ts`,
- `prd-policy-gate.ts`,
- `reviewer-perspective.ts`,
- `custom-agent-tool.ts`,
- `input-transformer.ts`,
- `profile-router.ts`,
- `validation-provider.ts`.

## Security / Trust Model

Extensions execute arbitrary TypeScript with user permissions. Documentation and UX must make this explicit.

Consider:

- user and project-local extensions enabled by default,
- committed project/team extensions requiring explicit trust,
- `eforge extension trust` or repo-level trust metadata,
- hash-based trust prompts for changed committed extensions,
- extension provenance in list/show output,
- timeout and failure policies for all hooks.

## Testing Strategy

Extension validation should be more than type-checking.

### Static validation

- load extension module,
- validate exported factory,
- validate registered hooks/tools/schemas,
- type-check generated scaffold where possible,
- reject unsupported hook names or ambiguous mutation contracts.

### Event replay testing

Replay events from monitor history or fixtures:

```bash
eforge extension test ./eforge/extensions/profile-router.ts --run latest
eforge extension test ./eforge/extensions/protect-env.ts --event plan:merge:start --fixture test/fixtures/env-change.json
```

This lets `/eforge:extend` report concrete behavior:

> Tested against the latest run. The extension would have selected `codex-5-5` after Claude entered cooldown.

## Open Questions

1. Loader choice: use `jiti` for TypeScript source like Pi, require built JS, or support both?
2. Where should extension runtime live: engine, monitor daemon, queue parent, worker, or split by hook type?
3. Which hooks are parent-process hooks vs worker-process hooks?
4. How should extension state be persisted: `.eforge/extensions-state/`, SQLite, or extension-owned files?
5. What should the trust model be for committed project extensions?
6. Should extension package support mirror Pi packages immediately or come later?
7. How should profile usage/quota state be normalized across Claude SDK, Pi providers, OAuth providers, and local models?
8. What failure policy should blocking hooks use by default: fail closed or fail open?

## Preferred Roadmap Summary

1. **TypeBox schema unification / shared tool registry prerequisites** where needed for public tool schemas.
2. **Extension SDK + loader** with scoped discovery and config.
3. **Typed event extensions** as the first supported capability.
4. **CLI/daemon extension manager** for list/new/validate/test/reload.
5. **`/eforge:extend` skill/tooling** in both Pi and Claude Code integrations.
6. **Agent context/tool extensions** for prompt/tool augmentation.
7. **Pre-build profile router** for quota/cost/provider-aware profile selection.
8. **Policy gates** with explicit decisions and event emission.
9. **Input transformers** for issue trackers and PRD enrichment.
10. **Limited stage-like APIs** such as reviewer perspectives and validation providers.
11. **Package/install support** after local/project workflows are proven.

## Acceptance Criteria for Initial Delivery

1. A user can run `/eforge:extend` and create a project-local TypeScript extension from a natural-language request.
2. The generated extension is validated and listed by `eforge extension list`.
3. Event extensions can subscribe to typed eforge event patterns and run timeout-bounded handlers.
4. Extension failures are visible but do not crash successful builds unless the hook is explicitly blocking.
5. At least five example extensions ship, including a profile router example.
6. Pi and Claude Code integrations expose matching extension scaffold/validate/test/reload capabilities.
7. Documentation clearly explains scopes, trust/security, APIs, examples, and limitations.
