---
id: plan-01-backend-aware-submission-tool-naming
name: Backend-aware submission tool naming and Pi 0.68 ToolDefinition conformance
depends_on: []
branch: fix-planner-submission-tools-on-the-pi-backend/backend-aware-submission-tool-naming
---

# Backend-aware submission tool naming and Pi 0.68 ToolDefinition conformance

## Architecture Context

The engine's planner agent completes its turn by calling a custom tool (`submit_plan_set` for errand/excursion, `submit_architecture` for expedition). The custom tool is injected into the agent run via `AgentRunOptions.customTools: CustomTool[]` and each backend registers it with its underlying SDK:

- **Claude SDK backend** wraps custom tools in an in-process MCP server via `createSdkMcpServer({ name: 'eforge_engine', ... })`. The Claude Agent SDK exposes those tools to the model with the prefix `mcp__eforge_engine__<toolName>`. This is the SDK's only supported mechanism for registering custom tools and is not going away.
- **Pi backend** previously used the `AgentTool` type and merged custom tools into the MCP-bridged tool array, then cast the whole array `as unknown as ToolDefinition[]`. With Pi 0.68 the public API changed: `AgentTool` was replaced by `ToolDefinition`, `execute` grew from `(toolCallId, params) -> Result` to `(toolCallId, params, signal, onUpdate, ctx) -> Result`, and the session now takes `tools: string[]` (built-ins by name) plus `customTools: ToolDefinition[]`. Pi has no MCP-wrapper convention — a custom tool is just a `ToolDefinition` whose `name` the model calls directly.

Today, both the `CustomTool.name` in the planner (`mcp__eforge_engine__submit_plan_set`) and the five references in `packages/engine/src/prompts/planner.md` hard-code the Claude SDK's `mcp__eforge_engine__` prefix into shared, backend-agnostic code. On the Claude SDK side, the backend then strips it with `.replace(/^mcp__eforge_engine__/, '')` before handing the bare name back to `tool(...)`. On the Pi side, Pi refuses the `mcp__`-prefixed custom tool, so `mcp__eforge_engine__submit_plan_set` is never registered and Pi-backed planning fails with "Tool ... not found".

## Implementation

### Overview

Make the submission tool name **bare** (`submit_plan_set`, `submit_architecture`) in the planner and the planner prompt. Let each backend translate that bare name to the name the model will actually see:

- Add a small method on the `AgentBackend` interface that maps a bare `CustomTool.name` to the effective name.
- Claude SDK returns `mcp__eforge_engine__${name}`; the wrapper stays identical. The `.replace(...)` in `claude-sdk.ts` becomes unnecessary (inputs are already bare).
- Pi returns `name` (identity). The Pi adapter is rewritten to build `ToolDefinition` objects with the correct `execute` arity, pass them via `customTools` only (kept separate from `PiMcpBridge`-sourced tools), and drop the `as unknown as ToolDefinition[]` cast.

The planner renders its prompt per backend, asking the backend for the effective tool name for its current submission tool and interpolating that value into a `{{submitTool}}` placeholder. One `CustomTool` definition per submission type — one Zod schema, one handler. The `mcp__eforge_engine__` literal lives in exactly one place: the Claude SDK adapter.

### Key Decisions

1. **Tool naming is the backend's responsibility, not shared code.** The `AgentBackend` interface grows one narrow method — `effectiveCustomToolName(name: string): string` — rather than a new `submitStructuredOutput` method or parallel code paths. This is the minimum surface that unblocks Pi without redesigning the planner loop.
2. **Bare tool names in the planner.** The `CustomTool.name` fields become `submit_plan_set` and `submit_architecture`. The Claude SDK-specific prefix `mcp__eforge_engine__` is an artifact of the Claude Agent SDK's in-process MCP-server wrapping convention, not a planner concept, and only appears in `claude-sdk.ts`.
3. **Single prompt template, per-backend rendering.** The planner prompt uses `{{submitTool}}` placeholders (the engine's existing `loadPrompt()` already does `{{variable}}` substitution via `content.replace(/\{\{(\w+)\}\}/g, ...)` — no new templating system needed). The planner calls `backend.effectiveCustomToolName(customTools[0].name)` before each render so the agent is told the exact name registered for its backend. When scope is unknown and both submission tools are injected, the placeholder resolves to a single string listing both names (e.g. `submit_plan_set` or `submit_architecture`) so the prompt stays readable.
4. **Pi keeps built-in tools and custom tools strictly separate.** Pi 0.68 splits session configuration into `tools: string[]` (built-in tool names) and `customTools: ToolDefinition[]`. MCP-bridged tools from `PiMcpBridge` and planner `customTools` both go through `customTools`, but they are filtered independently and never commingled into a single `mcpTools` array that is then type-cast to silence a type error. No `as unknown as ToolDefinition[]` cast survives.
5. **Pi `ToolDefinition.execute` signature is updated to the Pi 0.68 arity.** The new signature is `(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (update: unknown) => void, ctx?: unknown) => Promise<Result>`. The planner handler only uses `params`, so the extra arguments are typed and ignored. The return shape `{ content, details }` is preserved.
6. **No behavior change on the Claude SDK path.** `createSdkMcpServer({ name: 'eforge_engine' })` stays. The only change in `claude-sdk.ts` is removing the dead `.replace(/^mcp__eforge_engine__/, '')` (inputs are bare) and implementing `effectiveCustomToolName`.

## Scope

### In Scope
- Add `effectiveCustomToolName(name: string): string` to the `AgentBackend` interface.
- Implement it in `ClaudeSDKBackend` (prepend `mcp__eforge_engine__`) and `PiBackend` (identity).
- Rename the two `CustomTool.name` values in `packages/engine/src/agents/planner.ts` to bare identifiers (`submit_plan_set`, `submit_architecture`).
- Render the planner prompt with a new `{{submitTool}}` variable resolved per-backend via `backend.effectiveCustomToolName(...)`.
- Replace the 5 hard-coded `mcp__eforge_engine__...` references in `packages/engine/src/prompts/planner.md` with `{{submitTool}}`.
- Remove the dead `.replace(/^mcp__eforge_engine__/, '')` in `packages/engine/src/backends/claude-sdk.ts`.
- Rewrite the custom-tool construction block in `packages/engine/src/backends/pi.ts` to use proper `ToolDefinition` objects with the Pi 0.68 `execute` arity, pass them via `customTools` only, keep them separate from `PiMcpBridge`-sourced tools, and drop the `as unknown as ToolDefinition[]` cast. Review `mcpTools` naming — rename to reflect that it holds bridged tools only once custom tools are separated.
- Update `test/pi-backend.test.ts` fixtures to the new `ToolDefinition` shape where needed; update `test/pi-backend-fail-fast.test.ts` similarly if it constructs custom tools.
- Add a new test in `test/pi-backend.test.ts` that wires a `CustomTool` with a bare name (e.g. `submit_plan_set`) through `PiBackend.run` and asserts the tool appears in `customTools` with that exact bare name, a `ToolDefinition` `execute` of arity 5, and a handler that returns the expected success string when invoked.
- Add or update a planner agent-wiring test (using `test/stub-backend.ts` patterns) asserting that the planner (a) asks the backend for the effective tool name and (b) injects that exact name into the rendered prompt so the agent is told the correct tool to call per backend.

### Out of Scope
- A full cross-backend "structured output" refactor.
- Removing or replacing the `createSdkMcpServer` in-process MCP-server wrapper in the Claude SDK backend.
- Introducing a `submitStructuredOutput` method or parallel code paths on the backend interface.
- Changes to the planner's tool-driven completion flow, `writePlanSet` / `writeArchitecture`, or `customTools` plumbing.
- Any change to Claude SDK behavior beyond removing the now-dead regex and implementing `effectiveCustomToolName`.
- Introducing a new templating system in the planner prompt (the existing `{{var}}` substitution in `loadPrompt()` is sufficient).
- Changes to `PiMcpBridge` tool construction — bridged tools already satisfy the `ToolDefinition` contract and flow through a separate path.
- Changes to schemas or the `CustomTool` interface shape beyond the naming convention on `.name`.

## Files

### Create
- _(none)_

### Modify
- `packages/engine/src/backend.ts` — add `effectiveCustomToolName(name: string): string` to the `AgentBackend` interface with a short doc comment explaining that backends translate a bare `CustomTool.name` into the name the model will see.
- `packages/engine/src/backends/claude-sdk.ts` — implement `effectiveCustomToolName(name)` on `ClaudeSDKBackend` returning `` `mcp__eforge_engine__${name}` ``. Remove the `.replace(/^mcp__eforge_engine__/, '')` on the `tool(...)` call (line ~124) since inputs are already bare. No other behavior change.
- `packages/engine/src/backends/pi.ts` —
  - Implement `effectiveCustomToolName(name)` on `PiBackend` returning `name` unchanged.
  - In `run(...)`, keep `PiMcpBridge`-sourced tools in a dedicated local (rename `mcpTools` -> `bridgedMcpTools` for clarity) and build planner-supplied custom tools into a separate `eforgeCustomTools: ToolDefinition[]` array.
  - Construct each entry as a proper `ToolDefinition` with: `name: ct.name` (bare), `label: ct.name`, `description: ct.description`, `parameters` from `jsonSchemaToTypeBox(z.toJSONSchema(ct.inputSchema))`, and `execute: async (toolCallId, params, signal, onUpdate, ctx) => { ... }` matching the Pi 0.68 arity. Body is unchanged: await `ct.handler(params)`, return `{ content: [{ type: 'text', text: result }], details: {} }`, translate thrown errors into the same error-text shape.
  - Filter bridged tools and custom tools independently with `filterTools(...)` so each respects `allowedTools`/`disallowedTools` without interference.
  - Pass `customTools: [...filteredBridgedTools, ...filteredEforgeCustomTools]` to `createAgentSession({...})` as a real `ToolDefinition[]` — drop the `as unknown as ToolDefinition[]` cast.
  - Update the debug payload `extra` to reflect the split (`bridgedMcpToolCount`, `customToolCount`).
- `packages/engine/src/agents/planner.ts` — change `createPlanSetSubmissionTool` to use `name: 'submit_plan_set'` and `createArchitectureSubmissionTool` to use `name: 'submit_architecture'`. Before calling `loadPrompt('planner', ...)`, compute the effective tool name(s) via `backend.effectiveCustomToolName(...)`. When exactly one custom tool is injected, pass that value as the `submitTool` template variable. When both are injected (unknown scope), pass a string like `` `${planSetName} or ${architectureName}` `` so the rendered prompt still names the exact per-backend identifiers. Update the final error in the "neither submission tool was called" branch so it reports the backend-visible names (by calling `backend.effectiveCustomToolName(t.name)` over `customTools`) instead of the bare `.name` list.
- `packages/engine/src/prompts/planner.md` — replace all 5 `mcp__eforge_engine__submit_plan_set` and `mcp__eforge_engine__submit_architecture` references (lines ~112, 123, 129, 175, 527) with `{{submitTool}}`. Preserve surrounding wording. The planner-renderer supplies the correct per-backend string.
- `test/pi-backend.test.ts` — update any fixtures that construct a `customTools` entry to the new `ToolDefinition` shape (bare `name`, `label`, `description`, `parameters`, `execute` of arity 5). Add a new `describe` block "PiBackend custom tool wiring" with a test that:
  1. Passes a `CustomTool` (bare name `submit_plan_set`) to `backend.run(...)`.
  2. Asserts `createAgentSession` is called with `customTools` containing an entry where `name === 'submit_plan_set'` and `typeof entry.execute === 'function'` and `entry.execute.length === 5`.
  3. Invokes `entry.execute('call-1', { plans: [...], orchestration: {...} }, undefined, undefined, undefined)` and asserts the handler resolves with `content[0].text` equal to `'Plan set submitted successfully.'` (or the validation error string when input is invalid).
  Add a second test asserting that when both `mcpServers` bridged tools and planner `customTools` are present, they appear as separate entries in `customTools` (no commingling into a shared `mcpTools` array) and `filterTools` applies to each independently.
- `test/pi-backend-fail-fast.test.ts` — if this file constructs any `customTools` fixture, update it to the new `ToolDefinition` shape. Otherwise leave behavior-only assertions unchanged.
- `test/stub-backend.ts` — implement `effectiveCustomToolName(name: string): string` on `StubBackend` so the test helper continues to satisfy the `AgentBackend` interface after it gains the new method. Default behavior can be identity (`return name`); the planner-submission-tool-naming test below constructs a `StubBackend` subclass or overrides this method to return a distinguishable prefix (e.g. `` `stub__${name}` ``).
- `test/agent-wiring.test.ts` (or a new sibling `test/planner-submission-tool-naming.test.ts` — prefer existing if there is an agent-wiring group for planners; otherwise add sibling) — add a test using `test/stub-backend.ts` patterns where `StubBackend.effectiveCustomToolName` returns a distinguishable prefix (e.g. `` `stub__${name}` ``). Drive `runPlanner` and assert the rendered prompt seen by the stub contains the literal `stub__submit_plan_set` (for errand/excursion scope) and does **not** contain the bare `submit_plan_set` standalone reference or any `mcp__eforge_engine__` literal.

## Verification

- [ ] `pnpm -r type-check` exits 0 from the repo root.
- [ ] `rg "mcp__eforge_engine__" packages/engine/src` returns exactly one file: `packages/engine/src/backends/claude-sdk.ts`.
- [ ] `rg "mcp__eforge_engine__" packages/engine/src/agents/planner.ts packages/engine/src/prompts/planner.md` returns zero matches.
- [ ] `rg "as unknown as ToolDefinition" packages/engine/src/backends/pi.ts` returns zero matches.
- [ ] `packages/engine/src/agents/planner.ts` contains `name: 'submit_plan_set'` and `name: 'submit_architecture'` as the two `CustomTool.name` values (and no other `name: ...` values inside the two submission-tool factory functions).
- [ ] The `AgentBackend` interface in `packages/engine/src/backend.ts` declares a method whose signature is `effectiveCustomToolName(name: string): string`.
- [ ] `ClaudeSDKBackend.effectiveCustomToolName('submit_plan_set')` returns the string `'mcp__eforge_engine__submit_plan_set'` (verify via a unit test assertion).
- [ ] `PiBackend.effectiveCustomToolName('submit_plan_set')` returns the string `'submit_plan_set'` (verify via a unit test assertion).
- [ ] In `packages/engine/src/backends/pi.ts`, each `ToolDefinition` constructed from a `CustomTool` has an `execute` function whose `.length` is 5 (verify via the new test).
- [ ] `pnpm test --run test/pi-backend.test.ts test/pi-backend-fail-fast.test.ts test/agent-wiring.test.ts` exits 0 with no skipped tests.
- [ ] `pnpm test` exits 0 from the repo root.
- [ ] The new Pi custom-tool-wiring test asserts that invoking the registered `ToolDefinition.execute('call-1', <valid-payload>, undefined, undefined, undefined)` resolves and its `content[0].text` string starts with `'Plan set submitted'` (exact match: `'Plan set submitted successfully.'`).
- [ ] `grep -n "{{submitTool}}" packages/engine/src/prompts/planner.md | wc -l` outputs `5`.
- [ ] The planner-submission-tool-naming test asserts `stubBackend.lastPrompt` (or equivalent field captured by the stub) contains the literal `stub__submit_plan_set` and contains zero occurrences of the substring `mcp__eforge_engine__`.
