---
id: plan-01-runtime-wire-contract
name: Runtime and Wire Contract for Extension Agent Tools
branch: extend-08b-extension-contributed-agent-tools-and-tool-availability/plan-01-runtime-wire-contract
agents:
  builder:
    effort: high
    rationale: This plan changes the extension runtime seam, wire event schemas, SDK
      contract comments, and merge semantics for tool availability. The harness
      implementations already expose customTools, but the merge policy and
      observability require careful coordination.
  reviewer:
    effort: high
    rationale: Review must verify source-boundary preservation, fail-open semantics,
      and wire-schema compatibility for a cross-package runtime feature.
  tester:
    effort: high
    rationale: Tests must cover prompt behavior regressions, tool injection,
      duplicate handling, allow/deny merging, and event schema validation.
---

# Runtime and Wire Contract for Extension Agent Tools

## Architecture Context

EXTEND_08A centralized agent-run extension behavior in `withAgentContextHooks()`. That wrapper already decorates every resolved `AgentHarness.run()` call and receives the extension registry, profile name, working directory, role, plan id, and resolved agent options. Claude SDK and Pi harnesses already accept `AgentRunOptions.customTools`, `allowedTools`, and `disallowedTools`; provider-specific SDK imports must remain inside `packages/engine/src/harnesses/`.

This plan turns the existing wrapper from prompt-only augmentation into the single runtime application point for prompt fragments, extension tools, and availability tuning. Toolbelt filtering remains owned by `AgentRuntimeRegistry` and continues to apply only to `.mcp.json` project MCP server maps.

## Implementation

### Overview

Extend `packages/engine/src/extensions/agent-context-runtime.ts` so successful `onAgentRun` handlers can return `tools`, `allowedTools`, and `disallowedTools` in addition to `promptAppend`. The runtime must adapt returned extension tools to internal `CustomTool` objects, merge them with existing run-level custom tools, merge availability lists using a safe source-aware policy, and emit a new pre-run wire event describing the decision. Existing prompt diagnostics, timeout/failure fail-open behavior, and event ordering before `agent:start` must remain intact.

### Key Decisions

1. **Per-run explicit injection only.** `registerTool(tool)` remains loader-time provenance and validation. A tool is injected into a run only when a successful `onAgentRun` handler returns it in `tools`.
2. **Engine custom tools keep precedence.** Existing `options.customTools` are preserved first. Extension tools are appended only when their bare name does not duplicate an existing custom tool or a previously accepted extension tool.
3. **Deny wins.** Extension `disallowedTools` are additive. If a returned extension tool is disallowed after name normalization, skip injecting it and report it in the tools event.
4. **Allowlist tuning preserves engine internals.** If any extension returns a non-empty `allowedTools`, compute the final allowlist as the union of base allowed tools, normalized extension allowed tools, effective names of existing engine custom tools, and effective names of accepted extension tools. If base allowed tools already exist, accepted extension tools are added to that list.
5. **Harness-effective names are runtime-owned.** Add `ctx.effectiveToolName(name)` to the public `AgentRunContext` and implement it through `innerHarness.effectiveCustomToolName(name)` so extension prompt text can reference backend-visible tool names.
6. **New observability event.** Add `extension:agent-tools:applied` instead of overloading prompt-context events. Retain the legacy `extension:agent-context:unsupported` schema for compatibility, but stop emitting it for `tools`, `allowedTools`, and `disallowedTools`.

### Runtime Mechanics

- Update the local SDK mirror in `agent-context-runtime.ts` to include an `ExtensionTool` shape with `name`, `description`, object-root `inputSchema`, and `handler`.
- Change `AgentContextHookRuntimeOptions.extensionRegistry` from `Pick<NativeExtensionRegistry, 'agentRunHooks'>` to include `tools` as well.
- Add runtime options passed to `executeAgentRunHooks()` for `effectiveCustomToolName(name)` and registered tool metadata.
- Return a richer `AgentRunHooksExecutionResult`:
  - `finalPrompt`
  - `customTools` or a final custom-tool array when contributions change
  - `allowedTools`
  - `disallowedTools`
  - `diagnostics`
- Build `AgentRunContext` with `effectiveToolName(name)`.
- Validate inline returned tools before adapting them. Skip invalid tools rather than throwing from the agent run.
- Adapt each accepted extension tool to `CustomTool` with an async string-returning handler wrapper.
- Track per-extension tool decisions for events:
  - bare accepted tool names
  - harness-effective accepted names
  - registered-vs-inline names by matching the returned tool name against `registry.tools` for the same extension
  - normalized allowed/disallowed additions
  - excluded tool names for duplicates, invalid returned tools, and disallowed returned tools
- Include `toolbelt`, `projectMcpSelection`, and `projectMcpServerNames` in the new event when those metadata fields are present on `AgentRunOptions`.
- Yield all extension diagnostics before delegating to the inner harness.
- Delegate with a fresh `AgentRunOptions` object whenever prompt/tools/availability changed; never mutate the original `options` object or its arrays.

### New Wire Event Shape

Add a TypeBox schema in `packages/client/src/events.schemas.ts` for `extension:agent-tools:applied` with at least these fields:

- provenance/correlation: `extensionName`, `extensionPath`, `role`, optional `tier`, `phase`, `stage`, `profile`, optional `planId`, optional `harness`, optional `toolbelt`, optional `projectMcpSelection`, optional `projectMcpServerNames`
- tool decision arrays: `toolNames`, `effectiveToolNames`, `registeredToolNames`, `inlineToolNames`, `allowedToolsAdded`, `disallowedToolsAdded`, `excludedToolNames`
- count fields: `toolCount`, `allowedToolCount`, `disallowedToolCount`, `excludedToolCount`

Add the new event to `isAlwaysYieldedAgentEvent()` and `packages/client/src/event-registry.ts` as session-scoped and non-persistent with a summary that includes the extension name, role, accepted tool count, and excluded count.

## Scope

### In Scope

- Runtime application of `AgentRunAugmentation.tools`, `allowedTools`, and `disallowedTools`.
- `ctx.effectiveToolName(name)` in SDK and runtime mirror types.
- Safe merge policy for existing engine custom tools, extension custom tools, allowlists, and denylists.
- New `extension:agent-tools:applied` TypeBox wire event and client registry metadata.
- Unit and integration tests covering the runtime wrapper with `StubHarness` and schema validation.

### Out of Scope

- Automatically injecting every `registerTool` entry into every agent run.
- Changing toolbelt resolution or routing extension tools through `tools.toolbelts`.
- Adding source tags to `agent:tool_use` or `agent:tool_result` events.
- Changing Claude SDK or Pi provider adapter behavior except for tests that assert existing effective-name conventions.
- New daemon, CLI, Pi extension, or Claude Code plugin commands.

## Files

### Create

None.

### Modify

- `packages/engine/src/extensions/agent-context-runtime.ts` — apply tool and availability augmentation, adapt extension tools to `CustomTool`, add `effectiveToolName`, merge policies, and emit `extension:agent-tools:applied`.
- `packages/extension-sdk/src/context.ts` — add `AgentRunContext.effectiveToolName(name: string): string` with docs describing harness-visible names.
- `packages/extension-sdk/src/hooks.ts` — remove deprecated/unsupported comments for `tools`, `allowedTools`, and `disallowedTools`; document runtime behavior.
- `packages/extension-sdk/src/api.ts` — update `onAgentRun` and `registerTool` remarks for runtime tool injection.
- `packages/extension-sdk/src/tools.ts` — update comments that currently describe engine adaptation as future work.
- `packages/client/src/events.schemas.ts` — add `extension:agent-tools:applied` schema and include it in `isAlwaysYieldedAgentEvent()`.
- `packages/client/src/event-registry.ts` — register the new event with session scope, non-persistence, and summary text.
- `packages/client/src/__tests__/events-schemas.test.ts` — add safe-parse and event-registry tests for `extension:agent-tools:applied`; keep compatibility tests for `extension:agent-context:unsupported`.
- `test/extension-agent-context-runtime.test.ts` — replace unsupported-field tests with runtime tests for tool injection, allow/deny merge semantics, duplicate exclusion, deny-wins exclusion, event payloads, failure/timeout behavior, and non-mutation.
- `test/agent-wiring.test.ts` — add a `StubHarness` integration test proving extension custom tools reach `AgentRunOptions.customTools`, existing custom tools remain first, diagnostics precede `agent:start`, and a stub tool call invokes the extension handler.

## Database Migration

None.

## Verification

- [ ] `executeAgentRunHooks` returns extension custom tools, merged allowed/disallowed arrays, and `extension:agent-tools:applied` events when handlers return `tools`, `allowedTools`, or `disallowedTools`.
- [ ] Runtime tests assert no `extension:agent-context:unsupported` event is emitted for supported tool fields.
- [ ] `StubHarness` receives existing custom tools first and extension tools after them; a returned extension tool handler output appears in `agent:tool_result`.
- [ ] Duplicate extension tool names and names matching existing run custom tools are skipped; `extension:agent-tools:applied.excludedToolNames` contains the skipped names.
- [ ] With an effective-name mapper `name => mcp__eforge_engine__${name}`, final allowlists contain effective names for existing engine custom tools and accepted extension tools when an extension returns `allowedTools`.
- [ ] A disallowed contributed tool is absent from `AgentRunOptions.customTools` and present in `excludedToolNames`.
- [ ] Existing prompt append behavior still emits `extension:agent-context:applied`, preserves fragment ordering, and never embeds prompt text in events.
- [ ] Failed and timed-out hooks emit `extension:agent-context:failed` or `extension:agent-context:timeout` and contribute no tools or availability entries.
- [ ] `safeParseEforgeEvent` accepts a representative `extension:agent-tools:applied` payload and rejects one missing `toolNames`.
- [ ] An `extension:agent-tools:applied` payload emitted from a run with toolbelt/project MCP metadata contains `toolbelt`, `projectMcpSelection`, and `projectMcpServerNames` values copied from the resolved agent options.
- [ ] `eventRegistry['extension:agent-tools:applied']` exists with `{ scope: 'session', persist: false }`.