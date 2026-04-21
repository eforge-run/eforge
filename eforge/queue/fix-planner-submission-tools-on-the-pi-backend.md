---
title: Fix planner submission tools on the Pi backend
created: 2026-04-21
---

# Fix planner submission tools on the Pi backend

## Problem / Motivation

Running an eval with the Pi backend fails because the planner agent tries to call `mcp__eforge_engine__submit_plan_set` and Pi reports `Tool ... not found`. This is the only way the planner can complete a turn, so Pi-backed planning is currently broken end-to-end.

The user is reviewing whether plan submission should be unified across backends and whether the in-process MCP-server wrapper in the Claude SDK backend is still the right design, or whether this is just a bug.

### Diagnosis: it is a bug, with one latent design smell

**The bug (why Pi fails today)**

Two things landed together in the in-flight edits to `packages/engine/src/backends/pi.ts`:

1. Pi bump `0.67.68 -> 0.68.0` changed the public tool API. The type `AgentTool` was replaced by `ToolDefinition` (`packages/engine/node_modules/.../pi-coding-agent/dist/core/extensions/types.d.ts`). The `execute` signature grew from `(toolCallId, params) -> Result` to `(toolCallId, params, signal, onUpdate, ctx) -> Result`, and the session now takes `tools: string[]` plus `customTools: ToolDefinition[]` (see `packages/engine/node_modules/.../pi-coding-agent/dist/core/agent-session.d.ts:54,81`).

2. The adapter at `packages/engine/src/backends/pi.ts:353-380` still constructs tools in the old `AgentTool` shape and pushes them into the combined `mcpTools` array (which also carries tools bridged from real MCP servers via `PiMcpBridge`). Line 464 then casts the whole array `as unknown as ToolDefinition[]` to silence the type error. The result at runtime: the submission tool is not exposed under the name the planner prompt asks for. Either Pi rejects the mixed MCP-bridged + custom shape, or it refuses to register a tool whose `name` starts with `mcp__` (that prefix is Pi's own MCP-bridge namespace convention), and so the agent's call to `mcp__eforge_engine__submit_plan_set` hits the "not found" path.

**The design smell (why Pi needs fixing at all)**

The literal string `mcp__eforge_engine__submit_plan_set` is hard-coded in shared, backend-agnostic places:

- `packages/engine/src/agents/planner.ts:65,89` as the `CustomTool.name`.
- `packages/engine/src/prompts/planner.md:112,123,129,175,527` as the tool the agent is told to call.

That prefix is a Claude SDK artifact. `createSdkMcpServer({ name: 'eforge_engine', ... })` in `packages/engine/src/backends/claude-sdk.ts:117-134` auto-exposes its tools as `mcp__eforge_engine__<toolName>` - that is literally how Claude Code surfaces in-process MCP tools (`packages/engine/src/backends/claude-sdk.ts:110-116`). Claude SDK has no other supported mechanism for registering custom tools, so wrapping them in an in-process MCP server is not going away on that side.

Pi has no such wrapping convention. A Pi custom tool is just a `ToolDefinition` with a name the model calls directly. Forcing `mcp__eforge_engine__` into that name is meaningless for Pi and almost certainly the reason Pi refuses it.

## Goal

Restore end-to-end Pi-backed planning by making the custom tool naming backend-aware and by conforming the Pi adapter to the Pi 0.68 `ToolDefinition` API, without redesigning the shared planner loop or the Claude SDK's in-process MCP-server wrapping.

## Approach

Keep the current design, make the naming backend-aware. We do **not** need a full cross-backend "structured output" refactor. The MCP-server wrapper in the Claude SDK backend is the SDK's idiomatic path, and pulling Pi into that mold (or splitting Claude into a structured-output mold) would duplicate or break the shared planner loop. Instead:

1. Make the `CustomTool.name` a bare identifier (`submit_plan_set`, `submit_architecture`). The planner stops embedding a Claude SDK naming convention.
2. Each backend adapts at its edge: Claude SDK keeps using `createSdkMcpServer` (the SDK will expose the tool as `mcp__eforge_engine__submit_plan_set`); Pi registers the tool with its bare name and the new `ToolDefinition` shape.
3. Each backend reports back the **effective tool name the model must call**. The planner interpolates that name into the prompt before handing it to the backend, so the prompt always tells the agent the exact name that is actually registered for its backend.
4. Fix the Pi adapter to conform to the new `ToolDefinition` type: correct `execute` signature, do not mix custom tools into the `PiMcpBridge`-sourced `mcpTools` array, pass them through `customTools` only, drop the `as unknown as ToolDefinition[]` cast.

**Why this stays DRY:**
- One `CustomTool` definition, one handler, one Zod schema per submission type - exactly as today.
- The `mcp__eforge_engine__` prefix lives in exactly one place (the Claude SDK adapter), not in the planner or the prompt.
- The planner prompt is templated once and rendered per backend; the only backend-specific value is the tool name string.

**Why it stays a bug fix, not a redesign:**
- Backend interface gains one small surface (`effectiveCustomToolName(name)` or equivalent) instead of a new `submitStructuredOutput` method and parallel code paths.
- No change to the planner's tool-driven completion flow, `writePlanSet` / `writeArchitecture`, or `customTools` plumbing.
- No change to Claude SDK behavior; existing plans and evals keep working.

## Scope

**In scope - files to change:**

- `packages/engine/src/agents/planner.ts` - rename `CustomTool.name` to `submit_plan_set` / `submit_architecture`; render the planner prompt with the effective tool name provided by the backend.
- `packages/engine/src/prompts/planner.md` - replace the 5 hard-coded `mcp__eforge_engine__...` references with a `{{submitTool}}`-style placeholder (or whatever templating the planner already uses - check, do not introduce a new system).
- `packages/engine/src/backend.ts` - add a small method on `AgentBackend` that maps a bare `CustomTool.name` to the name the model will see (Claude: `mcp__eforge_engine__${name}`; Pi: `${name}`).
- `packages/engine/src/backends/claude-sdk.ts` - keep `createSdkMcpServer`; the `.replace(/^mcp__eforge_engine__/, '')` on line 124 becomes unnecessary once the input names are already bare. Implement the new interface method to prepend `mcp__eforge_engine__`.
- `packages/engine/src/backends/pi.ts`:
  - Build custom tools as proper `ToolDefinition` objects (correct `execute` arity, TypeBox `parameters`, `label`, `description`, `name` bare).
  - Pass them via `customTools` only; keep `PiMcpBridge`-sourced tools separate (do not co-mingle). Review whether `mcpTools` still needs to exist as a merged array given Pi 0.68's split between `tools` (strings) and `customTools` (ToolDefinition).
  - Drop the `as unknown as ToolDefinition[]` cast.
  - Implement the new interface method as the identity function.
- `test/pi-backend.test.ts`, `test/pi-backend-fail-fast.test.ts` - update fixtures to the new `ToolDefinition` shape and bare tool names; add one test that runs the planner submission tool end-to-end on Pi (using `StubBackend` patterns if a real Pi session is too heavy).

**Explicitly out of scope:**

- A full cross-backend "structured output" refactor.
- Removing or replacing the `createSdkMcpServer` in-process MCP-server wrapper in the Claude SDK backend.
- Introducing a new `submitStructuredOutput` method or parallel code paths on the backend interface.
- Changes to the planner's tool-driven completion flow, `writePlanSet` / `writeArchitecture`, or `customTools` plumbing.
- Any change to Claude SDK behavior beyond the naming simplification.
- Introducing a new templating system in the planner prompt if one already exists.

## Acceptance Criteria

- `pnpm type-check` (root) passes, confirming the new `AgentBackend` surface and the `ToolDefinition` conformance in `pi.ts` with no `unknown` casts.
- `pnpm test` passes, specifically targeted at: `test/pi-backend.test.ts`, `test/pi-backend-fail-fast.test.ts`, and any planner agent-wiring tests. All must pass without mocks (per repo testing policy).
- End-to-end: re-running the eval that originally failed (the "fancy whisper" run) with the Pi backend completes a plan submission and the eval proceeds past the planning stage.
- Spot-check of the Claude SDK path: running one existing eval or `pnpm eforge` plan against a small PRD on the Claude SDK backend shows no behavior change.
- The literal `mcp__eforge_engine__` prefix appears in exactly one place in the codebase (the Claude SDK adapter), and no longer appears in `packages/engine/src/agents/planner.ts` or `packages/engine/src/prompts/planner.md`.
- `CustomTool.name` values in the planner are bare identifiers (`submit_plan_set`, `submit_architecture`).
- The planner prompt is rendered per backend with the effective tool name interpolated from the backend's reported name.
- The Pi adapter registers custom tools via `customTools` only, separate from `PiMcpBridge`-sourced tools, with a proper `ToolDefinition` `execute` signature `(toolCallId, params, signal, onUpdate, ctx) -> Result` and no `as unknown as ToolDefinition[]` cast.
- A new test runs the planner submission tool end-to-end on Pi (using `StubBackend` patterns if a real Pi session is too heavy).
