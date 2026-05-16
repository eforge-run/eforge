---
id: plan-02-docs-examples
name: Documentation and Examples for Extension Agent Tools
branch: extend-08b-extension-contributed-agent-tools-and-tool-availability/plan-02-docs-examples
agents:
  builder:
    effort: medium
    rationale: This plan is documentation- and example-heavy after the runtime
      contract is available; it requires consistency across public docs but no
      novel engine design.
  reviewer:
    effort: medium
    rationale: Review should focus on public API accuracy, absence of stale
      EXTEND_08B deferred language, and example/test parity.
---

# Documentation and Examples for Extension Agent Tools

## Architecture Context

After plan-01, extension authors can register tools for provenance and return tools or availability lists from `onAgentRun` for a single agent run. Public docs and examples must reflect that runtime-supported behavior while keeping the boundary clear: toolbelts select project MCP servers from `.mcp.json`; extensions contribute custom tools through TypeScript and tune harness allow/deny lists per run.

## Implementation

### Overview

Update public docs, SDK README content, and examples so authors see the supported EXTEND_08B pattern:

1. Define a tool with `defineExtensionTool` and TypeBox.
2. Register it with `eforge.registerTool(tool)` for loader/list provenance.
3. Return it from `eforge.onAgentRun(ctx => ({ tools: [tool], promptAppend: `Use ${ctx.effectiveToolName(tool.name)} ...` }))` for selected roles/stages.
4. Use `allowedTools` and `disallowedTools` only as per-run harness availability tuning, not as toolbelt configuration.

### Key Decisions

1. **Examples avoid global broadening.** The new example injects its tool only for builder runs and does not imply that registered tools appear in every run.
2. **Docs keep categories source-distinct.** Engine-internal custom tools, harness built-ins, toolbelt-selected project MCP tools, and extension-contributed tools are described as separate sources.
3. **Availability examples are conservative.** The main example may demonstrate a denylist entry or document allowlist semantics in prose, but it must not present allowlisting as required for ordinary tool injection.
4. **Generated docs drift is handled in this plan.** If `pnpm docs:check` reports generated reference drift after source-doc edits, run `pnpm docs:generate` and include the generated artifacts.
5. **Trusted-code warning stays visible.** Public docs retain the warning that native TypeScript extensions execute trusted arbitrary code.

## Scope

### In Scope

- Public docs updates for `onAgentRun` tool injection and availability tuning.
- SDK README updates removing unsupported/deferred wording for EXTEND_08B fields.
- Example coverage for a runtime-supported extension tool.
- Example import/list tests so every `examples/extensions/*.ts` file remains type-checked.
- Stale reference cleanup where docs still say tool injection/execution is deferred.
- Preservation of the trusted arbitrary TypeScript warning in public extension docs.

### Out of Scope

- New CLI commands, daemon endpoints, MCP tools, or Pi/Claude plugin features.
- Policy gates, input sources, reviewer perspectives, validation providers, or stage-like APIs.
- Runtime code changes beyond example/test wiring required by this documentation plan.

## Files

### Create

- `examples/extensions/agent-tools.ts` — runtime-supported extension tool example using `defineExtensionTool`, `registerTool`, `onAgentRun`, and `ctx.effectiveToolName(...)`.

### Modify

- `packages/extension-sdk/README.md` — update runtime support table and tool example to show per-run tool injection and availability tuning as supported.
- `docs/extensions.md` — update runtime support narrative/table, add a supported extension-tool authoring pattern, and remove EXTEND_08B deferred language for tool fields.
- `docs/extensions-api.md` — update `onAgentRun`, `AgentRunAugmentation`, `registerTool`, runtime status, and toolbelt-vs-extension sections for supported tool injection.
- `docs/config.md` — update extension runtime status and toolbelt boundary wording so it no longer says custom tool injection/execution is deferred.
- `examples/extensions/README.md` — add `agent-tools.ts` to the example table and describe supported runtime behavior.
- `examples/extensions/agent-context.ts` — remove comments that call `tools`, `allowedTools`, or `disallowedTools` unsupported in the current slice.
- `test/extension-sdk-example.test.ts` — import `agent-tools.ts`, add it to `importedExampleFiles`, and type-check it as `EforgeExtensionFactory`.
- Generated docs artifacts under `web/` or package reference output — update only if `pnpm docs:check` reports drift after source changes.

## Database Migration

None.

## Verification

- [ ] `packages/extension-sdk/README.md`, `docs/extensions.md`, `docs/extensions-api.md`, and `docs/config.md` contain no statement that `tools`, `allowedTools`, or `disallowedTools` returned from `onAgentRun` are unsupported or deferred to EXTEND_08B.
- [ ] Public docs state that `registerTool` records loader-time provenance and `onAgentRun({ tools: [...] })` is the per-run injection path.
- [ ] Public docs state that toolbelts filter only `.mcp.json` project MCP servers and do not filter extension tools, engine custom tools, or harness built-ins.
- [ ] Public docs retain the warning that native TypeScript extensions execute trusted arbitrary code.
- [ ] `examples/extensions/agent-tools.ts` type-checks as `EforgeExtensionFactory` and uses `ctx.effectiveToolName(...)` in prompt text.
- [ ] `test/extension-sdk-example.test.ts` imports every `examples/extensions/*.ts` file, including `agent-tools.ts`.
- [ ] `pnpm docs:check` completes with no generated-reference drift.