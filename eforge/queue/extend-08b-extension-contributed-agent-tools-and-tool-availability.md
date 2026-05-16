---
title: EXTEND_08B: Extension-Contributed Agent Tools and Tool Availability
created: 2026-05-16
depends_on: ["extend-05-phase-1-extension-docs-and-examples"]
profile: pi-codex-5-5
---

# EXTEND_08B: Extension-Contributed Agent Tools and Tool Availability

## Problem / Motivation

EXTEND_08A made `onAgentRun` runtime-supported for `promptAppend`, but extension tool fields are still treated as unsupported. The SDK already advertises `registerTool`, `defineExtensionTool`, `AgentRunAugmentation.tools`, `allowedTools`, and `disallowedTools`, and the loader already captures tool registrations. The missing capability is runtime application: extensions cannot yet make project-specific tools available to builder/reviewer/planner agents or adjust tool allow/deny lists for a specific agent run.

Why it matters now:
- The TypeScript extensibility roadmap explicitly separates prompt/context hooks (08A) from extension-contributed tools and availability tuning (08B).
- Custom tools are a high-value use case for repo-specific context lookup such as design systems, service ownership, schema lookup, and incident history without turning toolbelts into an imperative config layer.
- The implementation must preserve eforge boundaries: engine-internal submission/evaluation tools, harness built-ins, `.mcp.json` toolbelt-selected project MCP tools, and extension-contributed tools should remain source-distinct and observable.

Evidence sources reviewed:
- Schaake OS epic `b69903b9-a991-4eed-8081-4b9c31aae3b8` supplied by the user: EXTEND_08B is in progress, high priority, depends on completed EXTEND_08A (`f93b3986-a84a-4f59-9b46-ec619d87bb49`), and requires extension-contributed tools plus explicit/observable tool availability decisions.
- `docs/prd/typescript-extensibility.md`: EXTEND_08B is the second slice of Phase 2 after prompt/context hooks; extension tools must stay distinct from engine-internal tools, harness built-ins, and toolbelt-selected project MCP tools; toolbelt filtering applies only to `.mcp.json` project MCP servers.
- `docs/roadmap.md`: native TypeScript extensions remain a future/current roadmap item under Extensibility, including agent context/tool injection.
- `AGENTS.md`: engine emits events, consumers render; provider SDK imports stay in `packages/engine/src/harnesses/`; event schemas live in `packages/client/src/events.schemas.ts`; tests should use real code and `StubHarness` for agent wiring.
- EXTEND_08A dependency (`sos_get_epic f93b3986-a84a-4f59-9b46-ec619d87bb49`) is done and explicitly scoped tool injection out of 08A.
- `packages/extension-sdk/src/api.ts`, `hooks.ts`, `tools.ts`, `context.ts`: SDK already exposes `registerTool`, `defineExtensionTool`, `AgentRunAugmentation.tools`, `allowedTools`, and `disallowedTools`, but docs mark tool application as unsupported/deferred.
- `packages/engine/src/extensions/recorder.ts`, `types.ts`, `projector.ts`: loader already captures `tools` registrations, validates object-root input schemas, de-dupes names, and includes tools in registry projections/list totals.
- `packages/engine/src/extensions/agent-context-runtime.ts`: `onAgentRun` hooks currently execute fail-open and append prompt context only; non-empty `tools`, `allowedTools`, and `disallowedTools` return fields currently produce `extension:agent-context:unsupported` diagnostics.
- `packages/engine/src/harness.ts`: internal `CustomTool` is the harness-level injection shape; `AgentRunOptions` already carries `customTools`, `allowedTools`, and `disallowedTools`; `AgentHarness.effectiveCustomToolName()` abstracts Claude SDK vs Pi names.
- `packages/engine/src/harnesses/claude-sdk.ts` and `packages/engine/src/harnesses/pi.ts`: both harnesses already support `options.customTools`; Claude wraps them under the internal `eforge_engine` MCP server, while Pi registers bare names as `ToolDefinition`s. Both also honor allow/deny lists, with Pi already filtering base, bridged MCP, and custom tools independently.
- `packages/engine/src/agent-runtime-registry.ts` and `packages/engine/src/pipeline/agent-config.ts`: toolbelt selection is registry-owned and only filters project MCP server maps; agent run options receive toolbelt summary metadata for observability.
- `packages/client/src/events.schemas.ts`: EXTEND_08A events exist (`extension:agent-context:applied|failed|timeout|unsupported`), but no extension tool/availability applied events exist yet.
- `test/extension-agent-context-runtime.test.ts`, `test/agent-wiring.test.ts`, `test/extension-loader.test.ts`: current tests cover prompt append, unsupported tool fields, registry wrapping, and tool registration capture.

Classification: this is a **feature / focused** change. It adds runtime behavior to an already-designed SDK surface and touches engine runtime, wire events, tests, and docs, but it should fit in one cohesive implementation plan rather than delegated expedition planning.

Current behavior confirmed by code inspection:
- `agent-context-runtime.ts` emits `extension:agent-context:unsupported` whenever a hook returns non-empty `tools`, `allowedTools`, or `disallowedTools`.
- `registerTool` registrations are captured in `NativeExtensionRegistry.tools` but not injected into `AgentRunOptions.customTools`.
- Both Claude SDK and Pi harnesses already accept `AgentRunOptions.customTools` and support allow/deny lists.

Early assumptions / unknowns:
- Assumption (medium confidence): the simplest runtime path is to extend `agent-context-runtime.ts` so it returns final prompt, merged extension custom tools, and merged availability lists in one harness wrapper. Evidence: 08A wrapper already intercepts all `AgentHarness.run()` calls and has the extension registry plus run metadata. Validation path: implement focused unit tests around returned options before integration.
- Assumption (medium confidence): extension-registered global tools should only be injected when an `onAgentRun` hook explicitly requests them or when an explicit availability contract selects them, not automatically into every agent. Evidence: PRD examples show `onAgentRun` returning `tools: [designSystemLookupTool]`, and acceptance criteria mention tuning per agent run. Impact if wrong: extensions could unintentionally broaden every agent's tool surface.
- Unknown: whether availability tuning should be additive-only or may override existing allow/deny lists. Existing `allowedTools` semantics are restrictive, so naive replacement could hide engine-internal submission tools. This needs an explicit merge policy in design decisions.

## Goal

Implement runtime support for extension-contributed agent tools and per-run tool availability tuning while preserving clear boundaries between engine-internal tools, harness built-ins, project MCP toolbelt selection, and extension tools.

The desired outcome is that extensions can define, register, and selectively inject tools through `onAgentRun`, adjust `allowedTools` and `disallowedTools` safely, and emit observable wire events describing tool and availability decisions.

## Approach

Recommended eforge profile: **Excursion**.

Rationale: this is a cohesive feature slice centered on one existing runtime seam (`withAgentContextHooks`) plus event schemas, tests, and docs. It is cross-cutting enough to need a full plan and careful review, but it does not require delegated module planning across independent subsystems. The harnesses already expose the required custom-tool abstraction, so an excursion planner should be able to enumerate the implementation sequence without expedition-scale decomposition.

### Recommended implementation design

1. Extend the existing agent-context runtime rather than introducing a separate wrapper.
   - Rationale: `withAgentContextHooks()` already decorates every role-resolved harness and already emits pre-run diagnostics. Keeping prompt, tool, and availability augmentation together avoids wrapper ordering bugs.
   - Runtime result should become something like: `{ finalPrompt, customTools, allowedTools, disallowedTools, diagnostics }`.

2. Preserve fail-open hook execution, but apply valid tool fields instead of emitting `unsupported`.
   - Throwing or timed-out handlers continue to emit `extension:agent-context:failed|timeout` and contribute no prompt/tools/policy.
   - A handler can still contribute `promptAppend` and tools in one response; valid parts apply together if the handler succeeds.
   - Remove or stop emitting `extension:agent-context:unsupported` for `tools`, `allowedTools`, and `disallowedTools`; keep the event schema only if backward compatibility favors retaining it for other future unsupported fields.

3. Tool contribution model: per-run explicit injection via `onAgentRun`.
   - `eforge.registerTool(tool)` remains the loader-time/provenance registration API.
   - `onAgentRun` returns `tools: [tool]` to make tools available for the current run. This matches the SDK type and PRD example.
   - Registered tools should be recognized by name so events can report whether a contributed tool came from a prior `registerTool` declaration or was inline-only.
   - Do not automatically inject every `registry.tools` entry into every agent run; that would broaden tool surface too much and conflict with the per-role/per-phase nature of `onAgentRun`.

4. Adapt extension tools to internal `CustomTool` immediately before delegating to the inner harness.
   - Internal engine custom tools from `options.customTools` are preserved first.
   - Extension tools are appended after engine-internal tools, with duplicate bare names rejected/diagnosed before delegation. A duplicate extension tool should not override an engine-internal tool.
   - Handler wrapper returns string output and lets harnesses keep their existing execution/error behavior. If a future requirement needs source-tagged tool call events, add that as a follow-up rather than changing harness event semantics now.

5. Availability merge policy must be source-aware and safe for engine-internal tools.
   - Existing tier/role/plan `allowedTools` and `disallowedTools` remain the base policy.
   - Extension `disallowedTools` are additive; normalize bare extension tool names to effective names when they match contributed extension tools, otherwise pass names through unchanged for built-ins/MCP tools.
   - Extension `allowedTools` should be explicit allowlist tuning. If any extension returns a non-empty allow list, compute the final allow list as the union of base allowed tools, extension allowed tools, and effective names of engine-internal custom tools already present in `options.customTools` so required submission/evaluation tools are not accidentally hidden. This preserves pipeline safety while still allowing extensions to restrict normal built-ins/project MCP tools.
   - Extension tools returned for a run should be included in the final allow list unless explicitly disallowed, so an extension does not need to list its own tools twice.
   - Deny wins over allow for extension-contributed tools and normal tools, matching common safety expectations. If a tool is both contributed and disallowed, do not inject it and report the exclusion in the applied/availability event.

6. Effective tool-name normalization should be part of the context or diagnostics.
   - At minimum, events should include both bare and effective names for contributed tools.
   - Strong recommendation: add `effectiveToolName(name: string): string` or `resolveToolName` to `AgentRunContext` so an extension that appends prompt instructions can refer to the harness-visible tool name. The runtime can implement it with `innerHarness.effectiveCustomToolName(name)`. This is a small SDK addition and avoids Claude SDK prefix confusion.

7. Add a new observable event family instead of overloading prompt-context events.
   - Suggested event: `extension:agent-tools:applied` emitted once per extension per run when it contributes tools and/or availability changes.
   - Fields should include correlation (`extensionName`, `extensionPath`, `role`, `tier`, `phase`, `stage`, `profile`, `planId`, `harness`, `toolbelt`, `projectMcpSelection`) plus `toolNames`, `effectiveToolNames`, `allowedToolsAdded`, `disallowedToolsAdded`, `excludedToolNames`, and counts.
   - Prompt text and tool handler outputs should not be embedded in diagnostics.

8. Keep toolbelt filtering strictly in `AgentRuntimeRegistry`.
   - Do not route extension tools through `tools.toolbelts` or `.mcp.json` filtering.
   - Existing registry-resolved `projectMcpServerNames` remains the only input to project MCP filtering. Extension availability events can include `projectMcpSelection` for visibility, but must not mutate it.

9. Documentation should present the supported authoring pattern:
   - Define a tool with `defineExtensionTool` and TypeBox schema.
   - Register it with `eforge.registerTool(tool)` for loader/list provenance.
   - Use `eforge.onAgentRun(ctx => ctx.role === 'builder' ? { tools: [tool], promptAppend: \`Use ${ctx.effectiveToolName(tool.name)} when ...\` } : undefined)` for runtime availability.

Trade-off accepted: this plan does not create a separate extension-tool harness API or a fully source-tagged tool-call event stream. It uses existing `customTools` execution paths for cross-harness support and adds pre-run decision observability, which satisfies the epic without over-expanding scope.

### Code impact

Primary code impact, with evidence:

#### Engine extension runtime

- `packages/engine/src/extensions/agent-context-runtime.ts`
  - Current home of `executeAgentRunHooks()` and `withAgentContextHooks()`; already wraps every harness run. This is the natural place to collect extension `tools`, merge availability lists, adapt tools, and emit pre-run diagnostics.
  - Needs local mirror type updates for `AgentRunAugmentation`, likely a richer execution result (`finalPrompt`, `customTools`, `allowedTools`, `disallowedTools`, `diagnostics`).
  - Needs access to `innerHarness.effectiveCustomToolName()` inside the wrapper when normalizing extension tool names.
- `packages/engine/src/extensions/types.ts`
  - Already has `ToolRegistration`; may need metadata helpers/types for source-aware tool contributions if runtime bookkeeping should distinguish registered vs inline returned tools.
- `packages/engine/src/extensions/recorder.ts`
  - Already validates `registerTool` shape and object-root schema. May need stricter duplicate/invalid-name diagnostics if runtime reveals harness naming constraints. Current evidence does not prove colon names are invalid, and docs already recommend namespaced names like `my-ext:greet`.
- `packages/engine/src/extensions/index.ts`
  - Export any new runtime helper types if tests or consumers need them.

#### Harness and agent option path

- `packages/engine/src/harness.ts`
  - `CustomTool`, `AgentRunOptions.customTools`, `allowedTools`, and `disallowedTools` already exist. May need comments or small typed helper additions to distinguish source categories without changing harness implementations.
- `packages/engine/src/harnesses/claude-sdk.ts`
  - Already converts internal `CustomTool` to Claude SDK tools via `createSdkMcpServer` and `typeboxObjectToZodRawShape`; debug payload already includes custom tool count and internal MCP server names. Likely no large change unless separate internal MCP server naming for extension tools is chosen.
- `packages/engine/src/harnesses/pi.ts`
  - Already converts `customTools` to Pi `ToolDefinition`s and filters base, bridged MCP, and custom tools independently. Likely no large change unless source-specific debug counts are added.
- `packages/engine/src/agents/*` and `packages/engine/src/pipeline/stages/*`
  - Most call sites should not need direct changes because the registry wrapper intercepts all runs. Existing agent-specific internal `customTools` must continue to be passed through and preserved.

#### Wire events and client types

- `packages/client/src/events.schemas.ts`
  - Add event schema(s) for applied extension agent tools / availability decisions. Per project convention, this file is the wire source of truth; derive types from it.
- `packages/client/src/events.ts` / exports if generated or manually re-exported
  - Verify current event exports before editing.

#### SDK/docs/examples

- `packages/extension-sdk/src/hooks.ts`, `api.ts`, `context.ts`, `tools.ts`, `README.md`
  - Remove deprecated/unsupported language for `tools`, `allowedTools`, and `disallowedTools` once runtime lands.
  - Consider adding `ctx.effectiveToolName(name)` to `AgentRunContext` if extension prompt fragments need the harness-visible name; this is a design choice, not yet proven required by code.
- `docs/extensions.md`, `docs/extensions-api.md`
  - Update runtime status table and toolbelt-vs-extension boundary language.
- `examples/extensions/`
  - Add a supported custom tool example, probably a small deterministic lookup/audit tool that uses `defineExtensionTool` and `onAgentRun` to make it available to `builder` only.

#### Tests likely affected / needed

- `test/extension-agent-context-runtime.test.ts`
  - Replace unsupported-field expectations with applied tool/availability expectations; retain tests that failures/timeouts fail open.
- `test/agent-wiring.test.ts`
  - Add StubHarness integration asserting extension custom tools reach `AgentRunOptions.customTools`, prompt context still works, and diagnostics precede `agent:start`.
- `test/extension-loader.test.ts`
  - Existing registration capture tests likely stay; add stricter validation only if name/schema rules change.
- Harness-focused tests
  - Existing groups around Claude SDK/Pi debug/pure behavior, if present, can assert effective-name and filtering behavior without invoking external SDKs.

Evidence-backed conclusion: the existing extension registry wrapper provides enough central leverage that this should be a cohesive runtime feature rather than edits to every agent call site. Assumption: source-specific handler invocation events are not necessary for acceptance because `agent:tool_use/result` already show calls and the new extension applied event can expose availability decisions.

### Assumptions and validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|------------|----------------------------------|------------|--------------------------|-----------------|-----------------|
| The existing `withAgentContextHooks()` wrapper is the right runtime insertion point for tool injection and availability tuning. | Read `agent-context-runtime.ts`; it already intercepts all `AgentHarness.run()` calls and has registry/profile/cwd/timeout context. Read `eforge.ts`; engine wraps the full `AgentRuntimeRegistry` after loading extensions. | High | Low | Add unit tests around `executeAgentRunHooks()` output and StubHarness integration through `withAgentContextHooks()`. | If wrong, implementation may need a second wrapper or call-site changes, increasing scope and risk. |
| Extension tools should be injected per-run via `onAgentRun`, not automatically from all `registerTool` entries. | PRD example returns tools from `onAgentRun`; SDK has `AgentRunAugmentation.tools`; current docs say `registerTool` is loader-time provenance before runtime support. | Medium | Low | Build a small example extension and verify authoring ergonomics; optionally ask product/user if global auto-injection was intended. | If wrong, registered tools might not appear when authors expect; docs/examples must be very explicit or runtime must auto-inject. |
| Existing harness custom tool paths are sufficient for cross-harness support. | Read `ClaudeSDKHarness.run()` and `PiHarness.run()`; both already adapt `AgentRunOptions.customTools`; `StubHarness` can execute custom tool handlers in tests. | High | Medium | Add tests around options passed to both harness conventions; run type-check. Avoid external provider calls. | If wrong, provider-specific work may be needed in harness files. |
| Claude SDK allow/deny list entries for custom tools need harness-effective names, not bare names. | Existing planner prompts call `harness.effectiveCustomToolName()` because Claude exposes custom tools with MCP prefix; SDK options likely use the same visible names. | Medium | Medium | Write focused tests for effective-name normalization; if possible inspect Claude SDK docs or existing behavior without live provider calls. | If wrong, extension allow/deny rules may not affect Claude custom tools correctly. |
| Adding `ctx.effectiveToolName(name)` is acceptable SDK/API surface for EXTEND_08B. | Current `AgentRunContext` lacks a way for extension prompt text to mention Claude-prefixed custom tool names; engine can implement the helper from `innerHarness.effectiveCustomToolName()`. | Medium | Low | Type-check SDK and runtime mirror updates; add docs/example using it. | If not added, extension authors may write `promptAppend` using bare names that are confusing under Claude SDK. |
| New pre-run decision events are enough observability for this epic; source-tagged `agent:tool_use` events are not required. | Epic says registrations and availability decisions visible in events or diagnostics; existing harnesses already emit `agent:tool_use/result` for calls. | Medium | Medium | Review monitor/CLI display needs after event schema addition; add tests that applied events precede `agent:start`. | If wrong, a follow-up may need source fields on tool-use events or wrapper-level handler instrumentation. |
| Tool names containing `:` are acceptable for all supported harness custom tool adapters. | SDK docs currently recommend namespaced examples like `my-ext:greet`; recorder only validates non-empty strings and object-root schemas. This was not validated against live providers. | Medium | Medium | Add pure adapter tests where possible; if provider constraints are discovered, tighten recorder validation and docs. | If wrong, examples may generate tools that fail in one harness; runtime should diagnose invalid names early. |

No low-confidence/high-impact assumptions remain unresolved. The highest-impact assumption is the per-run injection model for `registerTool`; it is medium confidence and low-cost to adjust during implementation because the SDK already supports `tools` on `onAgentRun`.

## Scope

### In scope

1. Runtime application of extension-contributed agent tools:
   - Allow `onAgentRun` handlers to return `tools: ExtensionTool[]` and have those tools adapted to internal `CustomTool[]` for the specific run.
   - Preserve existing `registerTool(tool)` capture and use it as loader-time provenance; optionally allow returned tools to be matched against the registry for source metadata.
   - Keep extension tools separate in runtime bookkeeping from engine-internal `customTools` already supplied by agents such as planner, plan-reviewer, builder evaluator, etc.

2. Runtime application of extension tool availability tuning:
   - Stop treating `tools`, `allowedTools`, and `disallowedTools` as unsupported when returned from `onAgentRun`.
   - Merge extension availability requests with existing tier/role/plan `allowedTools` and `disallowedTools` through an explicit policy that does not accidentally remove engine-internal custom tools required for eforge orchestration.
   - Translate bare extension tool names to harness-effective names where needed (`mcp__eforge_engine__...` for Claude SDK today, bare names for Pi) before passing allow/deny lists to the harness.

3. Observability:
   - Add TypeBox wire events in `packages/client/src/events.schemas.ts` for extension agent-tool application/availability decisions, for example `extension:agent-tools:applied` or similarly named events.
   - Include extension name/path, role, tier, phase, stage, profile, harness, toolbelt/project MCP selection, contributed tool names, effective tool names, and allow/deny decision summaries.
   - Ensure diagnostics/extension list output continues to show registration counts.

4. Harness compatibility:
   - Use the existing `AgentRunOptions.customTools` path so Claude SDK and Pi harnesses both execute extension tools where each supports custom tools.
   - Keep provider SDK-specific conversion in `packages/engine/src/harnesses/` only.

5. Tests and docs:
   - Add/replace unit tests for `executeAgentRunHooks` / registry wrapper covering tool injection, availability merge semantics, failure/timeout behavior, and source distinction.
   - Add wiring tests with `StubHarness`, plus focused harness-adapter tests only around pure options/debug behavior where existing patterns allow it.
   - Update `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, and example coverage to remove EXTEND_08B unsupported/deferred language for this capability.

### Out of scope

- New Pi extension APIs or Claude Code plugin APIs; this is native eforge extension runtime behavior.
- New CLI/daemon commands beyond existing extension list/show/validate/test/reload surfaces unless needed for diagnostics display.
- Toolbelt feature changes: toolbelts remain declarative MCP server selection only.
- Blocking policy gates, input transformers, reviewer perspectives, validation providers, package install/trust hardening.
- Mid-run profile or toolbelt mutation.
- Changing provider SDK imports outside `packages/engine/src/harnesses/`.

## Acceptance Criteria

1. Extension tool runtime application
   - An extension can define an `ExtensionTool` with TypeBox, register it via `eforge.registerTool(tool)`, and return it from `onAgentRun({ tools: [tool] })` for a matching role/stage.
   - The matching agent run receives the tool in `AgentRunOptions.customTools` without dropping pre-existing engine-internal custom tools.
   - A non-matching agent run does not receive the tool.
   - Duplicate tool names cannot override engine-internal custom tools or another extension's tool; duplicates produce diagnostics/events and the unsafe duplicate is skipped.

2. Cross-harness behavior
   - Claude SDK harness receives extension tools through the existing custom tool MCP path and exposes effective names consistently with `effectiveCustomToolName()`.
   - Pi harness receives extension tools through the existing `ToolDefinition` custom tools path and can execute them with bare names.
   - Unit/integration tests verify both harness naming conventions without calling external providers.

3. Availability tuning
   - `onAgentRun` return fields `allowedTools` and `disallowedTools` are applied at runtime and no longer emit `extension:agent-context:unsupported` for this capability.
   - Extension availability changes merge with existing tier/role/plan allow/deny lists using documented semantics.
   - Engine-internal custom tools already present on the run remain available unless the engine itself would remove them; extension allowlists do not accidentally hide required submission/evaluation tools.
   - Deny wins over allow, and skipped/excluded extension tools are visible in diagnostics/events.

4. Source distinction / toolbelt boundary
   - Engine-internal custom tools, harness built-ins, project MCP tools selected by toolbelts, and extension-contributed tools are represented distinctly in runtime bookkeeping and diagnostics/events.
   - Toolbelt filtering remains confined to `.mcp.json` project MCP server selection in `AgentRuntimeRegistry`; it does not filter engine-internal custom tools, harness built-ins, or extension-contributed tools.
   - Extension availability tuning may use harness-level allow/deny lists, but docs clearly distinguish that from toolbelt selection.

5. Observability
   - New TypeBox wire event(s) in `packages/client/src/events.schemas.ts` describe extension agent-tool/availability application decisions.
   - Events include extension provenance, role/tier/phase/stage/profile/harness correlation, toolbelt/project MCP selection metadata, contributed tool names, effective tool names, and availability additions/exclusions.
   - `eforge extension list/show/validate/test` registration summaries continue to report tool registration counts.

6. SDK/docs/examples
   - `packages/extension-sdk` types and README no longer mark `tools`, `allowedTools`, and `disallowedTools` as unsupported/deprecated for this capability.
   - Docs update the runtime support table and include a supported extension-tool example.
   - Existing docs continue to state that extensions execute trusted arbitrary TypeScript and that toolbelts and extension tools are separate mechanisms.

7. Regression gates
   - `pnpm type-check` passes.
   - Relevant vitest coverage passes, at minimum extension runtime, extension loader, agent wiring, and event schema tests touched by this change.
   - Existing prompt/context hook behavior from EXTEND_08A still works, including ordering, fail-open error/timeout handling, and no raw prompt text in events.
