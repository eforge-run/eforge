---
title: EXTEND_08A: Agent prompt/context extension hooks
created: 2026-05-15
profile: claude-sdk-4-7
---

# EXTEND_08A: Agent prompt/context extension hooks

## Problem / Motivation

Native extension loading and typed event hooks are already in place, but `onAgentRun` is only captured at load time and not executed at runtime. Extension authors cannot currently add project/domain-specific prompt context to eforge agents without using global prompt overrides (`agents.promptDir`) or static tier/role/plan `promptAppend` config.

This creates a gap for high-value extension use cases from the TypeScript extensibility PRD: extensions should be able to influence agent behavior safely and observably, especially by appending role-, tier-, or phase-specific context. The immediate user impact is that an extension can be listed/validated as registering `onAgentRun`, but it cannot actually affect planner/builder/reviewer prompts.

The change matters now because EXTEND_08A is the first runtime slice after event hooks that lets extensions influence agent runs. It must establish the provenance, failure policy, and separation from profile/toolbelt configuration before EXTEND_08B adds custom tools and tool availability tuning.

### Context

Evidence sources read during planning:

- `docs/prd/typescript-extensibility.md` defines EXTEND_08A as the prompt/context hook slice and explicitly excludes extension-contributed custom tools and tool availability tuning, which are EXTEND_08B.
- Schaake OS epic context states: hook agent runs by role/tier/phase where appropriate; append prompt/context additions with provenance; pass additions through Claude SDK and Pi harnesses where supported; make additions observable; keep them distinct from profile/toolbelt config.
- `docs/roadmap.md` keeps native TypeScript extensions as an active roadmap item under Extensibility.
- `AGENTS.md` requires engine events as the communication boundary, SDK imports only under `packages/engine/src/harnesses/`, event schemas centralized in `packages/client/src/events.schemas.ts`, and Pi/Claude integration parity for consumer-facing behavior.
- Existing extension foundation: `packages/engine/src/extensions/types.ts`, `recorder.ts`, `loader.ts`, `event-runtime.ts`, and `packages/extension-sdk/src/*` already load extensions, capture `onAgentRun` registrations, and expose typed-but-deferred agent-run contracts.
- Existing prompt path: agent runners call `loadPrompt(..., options.promptAppend)` and then `harness.run({ prompt, ...pickSdkOptions(options) })`; `promptAppend` is deliberately stripped from backend SDK options in `packages/engine/src/harness.ts`.
- Existing agent config path: `resolveAgentConfig()` merges tier/role/plan `promptAppend` in `packages/engine/src/pipeline/agent-config.ts`; agent runtime registry independently resolves harness/toolbelt summaries by role/tier.
- Existing observability path: `agent:start` events in `packages/client/src/events.schemas.ts` already include role, harness, tier, model, perspective, and toolbelt provenance; extension event-hook failures/timeouts have dedicated event variants.
- Real harnesses (`packages/engine/src/harnesses/claude-sdk.ts` and `packages/engine/src/harnesses/pi.ts`) consume a final `AgentRunOptions.prompt`; therefore prompt-context augmentation can be harness-agnostic if it is applied before calling `harness.run()`.
- Existing tests use `StubHarness` (`test/stub-harness.ts`) to capture final prompts and agent run options, making prompt augmentation testable without provider mocks.

Classification: this is a **feature / deep** change. It adds a new runtime extension capability, crosses SDK, engine pipeline, event schemas, docs, and tests, but should remain a cohesive single-plan change because custom tools/tool availability, profile routing, and policy gates are out of scope.

Assumptions identified so far:

- The first implementation can append context to the final prompt string before harness dispatch, rather than adding a backend-specific system-prompt channel. Confidence: high; both harnesses use `options.prompt` as the user prompt and existing `promptAppend` follows this path.
- "Phase" can initially be represented using the pipeline stage context / runner call site (for example compile/build stage or a named phase string) rather than a new global phase model. Confidence: medium; needs design clarity because current agent runners receive role and sometimes perspective/planId, but not a uniform phase field.
- Runtime should emit new diagnostic/provenance events for applied/failed/timed-out agent-context hooks rather than overloading `agent:start` with full prompt text. Confidence: medium; event schema changes are cheap, but exact event shape should avoid leaking prompt contents.

## Goal

Execute captured native extension `onAgentRun` registrations at runtime so extensions can append role-, tier-, or phase-scoped prompt/context to eforge agents with clear provenance, observable diagnostics, and fail-open behavior, while keeping custom tools and tool availability tuning deferred to EXTEND_08B.

## Approach

### Design Decisions

1. **Keep the registration API as `eforge.onAgentRun(handler)` for EXTEND_08A.**
   - Rationale: this API already exists in SDK docs/types and loader capture; extensions can filter inside the handler using `ctx.role`, `ctx.tier`, and `ctx.phase`/`ctx.stage` rather than requiring a new selector DSL.
   - Trade-off: selector objects could be added later for ergonomics, but they are not necessary for the first runtime slice.

2. **Only `promptAppend` is a supported runtime augmentation in this slice.**
   - Rationale: the epic explicitly excludes custom tools and allowed/disallowed tool tuning. Prompt text is already an established engine-level concept and does not require provider-specific tool registration changes.
   - Implementation guidance: update SDK/docs so `AgentRunAugmentation` is prompt-only for supported behavior. If compatibility fields remain temporarily, runtime should ignore them with a warning/provenance diagnostic rather than applying them.

3. **Apply extension context before harness dispatch, not inside provider-specific harnesses.**
   - Rationale: both Claude SDK and Pi harnesses receive `AgentRunOptions.prompt`. Applying extension prompt fragments before `harness.run()` avoids SDK imports outside `packages/engine/src/harnesses/` and keeps behavior consistent across harnesses.
   - Likely shape: wrap `AgentRuntimeRegistry` or `AgentHarness` with a decorator that runs agent-context hooks, emits diagnostics, augments `options.prompt`, then delegates to the original harness.

4. **Preserve existing config prompt precedence and append extension context after resolved config prompt append.**
   - Rationale: current tier/role/plan `promptAppend` is deterministic config. Extension context should be visibly additional and not silently override it.
   - Proposed composition: existing `loadPrompt(..., options.promptAppend)` remains unchanged, then the wrapper appends a section like:
     ```md
     ## Native extension context

     ### <extension name>
     <promptAppend returned by that extension>
     ```
     Include path/provenance in comments or labels where useful, but avoid noisy absolute paths in prompts unless needed.

5. **Emit observability events without dumping full prompt text.**
   - Rationale: acceptance requires observable context additions, but full prompt fragments may contain sensitive repo or policy details. Counts/provenance are enough for diagnostics.
   - Proposed events:
     - `extension:agent-context:applied` with extension name/path, agent role, tier, phase/stage if available, planId if available, and prompt character count.
     - `extension:agent-context:failed` with extension name/path, agent role, tier, phase/stage, and message/stack.
     - `extension:agent-context:timeout` with timeoutMs and the same correlation fields.
     - Optional `extension:agent-context:unsupported` if a handler returns tools/tool filters in this slice.

6. **Fail open for agent-context hook errors/timeouts.**
   - Rationale: EXTEND_08A is a prompt augmentation capability, not a blocking policy gate. A bad extension should be visible but should not crash successful builds.
   - Timeout should be bounded by a new `extensions.agentContextHookTimeoutMs` or a documented reuse of the native extension timeout default. Prefer a new config key for clarity if implementation cost is small.

7. **Expose phase conservatively.**
   - Rationale: "phase" is not currently a single uniform field across all agent run call sites. `PipelineContext` distinguishes compile/build stages; some direct engine helpers are standalone/recovery/preflight.
   - Proposed shape: `AgentRunContext` includes `phase?: string` and `stage?: string`; runtime fills them from explicit metadata where available and otherwise uses a documented role-to-phase fallback. Do not overclaim exactness when unavailable.

8. **Keep profile/toolbelt distinct in both prompt and events.**
   - Rationale: toolbelts are declarative MCP selection; extensions are imperative lifecycle hooks. EXTEND_08A must not mutate `toolbelt`, `projectMcpSelection`, `allowedTools`, or `disallowedTools`.
   - Events may include the current toolbelt/profile metadata for context, but not as extension-owned configuration.

9. **Use TypeBox/wire-schema discipline for events.**
   - Rationale: project convention requires event variants to live in `packages/client/src/events.schemas.ts` and use `safeParseEforgeEvent` for runtime validation.
   - Update `event-registry.ts` and monitor UI exhaustive handling alongside schema changes.

### Architecture Impact

This operates within existing module boundaries but adds one new runtime layer:

- **Extension loader/capture remains unchanged as the source of registered hooks.** `loadNativeExtensions()` still returns a `NativeExtensionRegistry` with captured `agentRunHooks`.
- **Agent runtime registry/harness boundary becomes the hook application point.** A wrapper/decorator around `AgentRuntimeRegistry` or `AgentHarness` can apply prompt context before delegating to Claude SDK or Pi harnesses. This keeps the engine/provider boundary intact: provider SDK imports remain only in `packages/engine/src/harnesses/`.
- **Wire events expand.** New agent-context extension diagnostic/provenance events must be added to `@eforge-build/client` schemas and registry so the daemon, CLI, monitor, and UI share one contract.
- **Prompt assembly remains engine-level.** Existing agent runners continue using `loadPrompt()` and `promptAppend`; extension context is appended after that resolved prompt, before provider dispatch.
- **Profile/toolbelt selection stays in the agent runtime registry.** EXTEND_08A may read resolved tier/toolbelt/profile metadata for context but must not change tool surfaces or profile routing.

No deployment or daemon API route changes are required unless docs/management output is updated to describe the new runtime capability. The daemon will naturally record/display new events once the client schema and monitor UI exhaustive handlers are updated.

### Code Impact

Likely files/modules to change, based on searches for `onAgentRun`, `promptAppend`, `resolveAgentConfig`, and `harness.run`:

- `packages/engine/src/extensions/types.ts`
  - Refine/extend `AgentRunRegistration` value typing for runtime use.
  - Add agent prompt/context hook runtime types if they belong in engine rather than only SDK.

- `packages/engine/src/extensions/recorder.ts`
  - Existing capture of `onAgentRun(handler)` is already present and validated as function-only; likely minimal change unless registration metadata or overload support is added.

- New or existing engine runtime module under `packages/engine/src/extensions/`, likely `agent-context-runtime.ts` / `agent-run-runtime.ts`
  - Execute captured `agentRunHooks` with timeout/fail-open behavior.
  - Build hook context (role, tier, phase/stage, planId, profile, cwd, harness/toolbelt metadata where safe).
  - Compose returned prompt fragments with provenance wrappers.
  - Produce typed diagnostic/provenance events.
  - Reuse/extract common logger/exec helpers from `event-runtime.ts` if needed.

- `packages/engine/src/extensions/index.ts`
  - Export new runtime wrapper/helper and related types.

- `packages/engine/src/harness.ts`
  - Add non-SDK metadata fields to `AgentRunOptions` if needed, e.g. `phase`/`stage`/extension provenance fields.
  - Ensure new non-SDK fields are not forwarded by `pickSdkOptions`.

- `packages/engine/src/agent-runtime-registry.ts` and/or `packages/engine/src/eforge.ts`
  - Wrap the resolved `AgentRuntimeRegistry` once during `EforgeEngine.create()` so every `forRole`/`forRoleResolved` harness gets agent-context hooks applied centrally.
  - Preserve toolbelt summary behavior and avoid changing project MCP/toolbelt selection.

- `packages/engine/src/pipeline/stages/compile-stages.ts`, `packages/engine/src/pipeline/stages/build-stages.ts`, and direct eforge agent invocations in `packages/engine/src/eforge.ts`
  - Only needed if phase/stage metadata must be passed explicitly. Prefer central role-to-phase fallback to avoid broad call-site churn; add explicit metadata only where the pipeline context already knows a reliable phase/stage.

- `packages/client/src/events.schemas.ts`
  - Add TypeBox schemas for new extension agent-context diagnostics/provenance events. Event schemas are the wire source of truth.

- `packages/client/src/event-registry.ts`, `packages/client/src/__tests__/events*.test.ts`
  - Register new event variants and update wire/schema tests.

- `packages/monitor-ui/src/lib/reducer/index.ts` and `packages/monitor-ui/src/components/timeline/event-card.tsx`
  - Either intentionally ignore the new variants in derived state and/or render concise timeline summaries for applied/failed/timeout diagnostics.

- `packages/extension-sdk/src/api.ts`, `context.ts`, `hooks.ts`, `index.ts`, and `packages/extension-sdk/README.md`
  - Update `AgentRunContext` and `AgentRunAugmentation` to reflect the supported EXTEND_08A prompt-only surface.
  - Document custom tools and allowed/disallowed tool tuning as deferred to EXTEND_08B.

- `docs/extensions.md`, `docs/extensions-api.md`, `web/content/docs/extensions.md`, `web/content/docs/extensions-api.md`, and docs generation/reference tests if affected
  - Update runtime-support table from "deferred" to "prompt append supported" for `onAgentRun`.
  - Explain provenance, fail-open behavior, timeout, and unsupported tool fields.

- `examples/extensions/`
  - Add a supported prompt-context example, e.g. `agent-context.ts` that appends builder-only or review-tier context.

- Tests likely to add/update:
  - New `test/extension-agent-context-runtime.test.ts` for composition, ordering, filtering by ctx fields, timeout/failure diagnostics, and prompt provenance.
  - `test/extension-loader.test.ts` remains useful for registration capture; may need updates for changed SDK/runtime types.
  - `test/agent-wiring.test.ts` or a focused new wiring test using `StubHarness` to assert final prompts include extension context and existing config `promptAppend`.
  - Event schema/registry tests in `packages/client/src/__tests__/`.

Evidence for impact:

- `onAgentRun` capture exists today in `recorder.ts` but no runtime execution was found.
- Existing prompt append path is centralized through `loadPrompt(..., options.promptAppend)` in agent runners.
- Both real harnesses consume the final `options.prompt`, so prompt augmentation before harness dispatch should be backend-neutral.
- `StubHarness` records prompts and options, so tests can validate without mocking provider SDKs.

### Documentation Impact

Specific docs likely to go stale and should be updated with the implementation:

- `docs/extensions.md`
  - Runtime support table: change `onAgentRun` from fully deferred to prompt/context append supported.
  - Explain fail-open behavior, timeout, provenance events, and that tools/tool filters are still deferred.

- `docs/extensions-api.md`
  - Update `onAgentRun` signature/context/augmentation to the EXTEND_08A supported surface.
  - Add role/tier/phase filtering examples.
  - Remove or clearly mark `tools`, `allowedTools`, and `disallowedTools` from `onAgentRun` runtime behavior.

- `web/content/docs/extensions.md` and `web/content/docs/extensions-api.md`
  - Keep public docs site content in sync with `docs/` source/reference docs.

- `packages/extension-sdk/README.md`
  - Add a minimal prompt-context hook example and supported/runtime status.

- `examples/extensions/README.md` and/or a new `examples/extensions/agent-context.ts`
  - Demonstrate a supported builder-only or review-tier context append.

- Generated/reference docs if `pnpm docs:generate` updates artifacts.

No README-wide feature announcement is necessary unless existing extension docs are linked from the root README's feature list.

### Risks

- **Prompt bloat / degraded agent performance:** extensions can append arbitrary text. Mitigation: document brevity, emit prompt character counts, and preserve timeout/fail-open behavior.
- **Provenance too weak:** if prompt fragments are simply concatenated, users cannot tell where context came from. Mitigation: wrap each fragment in a named extension section and emit applied events.
- **Sensitive prompt leakage through events:** observability must not dump full prompt fragments by default. Mitigation: events carry metadata and sizes, not raw context text.
- **Phase ambiguity:** current code has pipeline compile/build phases plus standalone engine helper agents. Mitigation: expose `phase`/`stage` as best-effort/optional and document exactly when it is populated.
- **Partial hook coverage:** if runtime is wired only in some call sites, extensions behave inconsistently. Mitigation: prefer registry/harness decorator so all agent runs pass through one path; add tests for compile and build agents at minimum.
- **Accidental EXTEND_08B creep:** existing SDK docs mention tools and tool filters in `onAgentRun`. Mitigation: narrow supported types/docs or emit unsupported diagnostics without applying tool changes.
- **Extension failure impacts build latency:** hooks run before agent dispatch. Mitigation: short timeout, parallel/sequential behavior chosen deliberately, and fail-open diagnostics.
- **Ordering conflicts between multiple extensions:** appending order can affect agent behavior. Mitigation: use deterministic registry order and document it; include extension names in prompt sections.
- **Event schema drift:** new events require client schemas, registry, monitor UI, and tests to be updated together. Mitigation: rely on existing exhaustive type gates.
- **Security/trust:** extensions are arbitrary code and may compute context by reading files/env. Mitigation: reuse existing trust model docs; do not introduce new sandbox claims.

### Assumptions And Validation

| Assumption | Evidence / validation performed | Confidence | Cost to validate further | Validation path | Impact if wrong |
|---|---|---:|---:|---|---|
| Prompt augmentation can be harness-agnostic by changing the final `AgentRunOptions.prompt` before `harness.run()`. | Read `packages/engine/src/harnesses/claude-sdk.ts` and `packages/engine/src/harnesses/pi.ts`; both use `options.prompt` for dispatch/debug payload. Existing `loadPrompt(..., options.promptAppend)` path is in agent runners. | high | low | Add wiring tests with `StubHarness`; optionally use harness debug payload tests for Claude/Pi shapes. | Would require provider-specific prompt channels and larger harness changes. |
| `onAgentRun` registrations are already captured and only runtime execution is missing. | Read `packages/engine/src/extensions/recorder.ts`, `types.ts`, `loader.ts`, and `test/extension-loader.test.ts`; `agentRunHooks` are recorded and projected, but no runtime use found by search. | high | low | Add a test proving current hook is executed after implementing new runtime. | If capture semantics need redesign, scope grows into loader/API changes. |
| A registry/harness decorator is the best central application point. | Search found many direct `harness.run()` call sites across agent runners; `AgentRuntimeRegistry` centralizes harness resolution by role/tier/toolbelt. | medium-high | medium | Prototype wrapper around `forRoleResolved()` and run compile/build wiring tests; inspect direct uses of provided bare harnesses. | If some runs bypass the wrapper, prompt hooks apply inconsistently and require broader call-site edits. |
| Phase can be exposed as a conservative optional/best-effort field. | `PipelineContext` has compile/build stage boundaries, but standalone agents in `eforge.ts` do not all share a single phase model. | medium | medium | During implementation, map roles/call sites and document exact populated values; add tests for at least compile/build phase signals. | If users depend on precise phase semantics, ambiguous values could cause wrong context injection. |
| New observability should use dedicated events without raw prompt text. | Existing extension event-hook diagnostics use dedicated event variants; event schema discipline is centralized in `packages/client/src/events.schemas.ts`. | high | low | Add schema/registry tests and monitor UI timeline summaries/ignored-state handling. | Without events, acceptance criteria fail; with raw text, sensitive context could leak. |
| Existing SDK `AgentRunAugmentation` tool fields must not be implemented in this slice. | PRD and Schaake OS acceptance criteria explicitly exclude custom tools and allowed/disallowed tool tuning; current SDK docs mention them as deferred. | high | low | Update SDK/docs; add a test that returned unsupported fields are ignored or no longer type-supported. | Implementing them would merge EXTEND_08A and EXTEND_08B, increasing risk and violating scope. |
| Existing trust model is sufficient for this slice. | `docs/extensions.md` documents arbitrary TypeScript execution and scope trust behavior; no new extension loading source is introduced. | high | low | Ensure docs mention agent-context hooks run in the same trusted extension process. | If trust semantics change, this becomes a broader security epic. |

No low-confidence/high-impact assumption remains unresolved. The medium-confidence phase/decorator assumptions have clear validation paths and manageable fallback: document optional phase semantics and add explicit metadata at call sites if the central wrapper cannot infer enough context.

### Profile Signal

Recommended eforge profile: **Excursion**.

Rationale: this is a cross-cutting feature touching SDK types, engine runtime, event schemas, monitor UI handling, docs, examples, and tests. However, it is cohesive: a single planner can describe the runtime wrapper, prompt composition, event diagnostics, and documentation updates without delegating separate module plans. It should not require Expedition unless implementation discovers the registry/harness wrapper cannot cover agent runs and broad call-site-specific redesign is needed.

## Scope

### In Scope

- Execute native extension `onAgentRun` registrations before agent dispatch.
- Support prompt/context append only for this slice (`promptAppend` / equivalent naming in SDK docs).
- Provide hook context that lets handlers decide based on at least agent role and resolved tier, and a conservative lifecycle phase/stage signal where available.
- Compose extension-added context into the final prompt with clear per-extension provenance, without replacing existing tier/role/plan prompt append behavior.
- Emit observable diagnostics/events for applied context, hook failures, timeouts, and unsupported returned fields if any are kept for compatibility.
- Keep extension-added context distinct from profile/toolbelt configuration and from project MCP selection.
- Apply the final augmented prompt consistently before both Claude SDK and Pi harness dispatch.
- Add focused tests, SDK/docs updates, and at least one supported example/template or example file for prompt-context hooks.

### Out of Scope

- Extension-contributed custom tools (`registerTool` runtime execution or `tools` returned from `onAgentRun`).
- Extension changes to `allowedTools` / `disallowedTools` or toolbelt/project MCP selection.
- Profile routing, quota handling, policy gates, input transformers, reviewer perspectives, validation providers, or custom stages.
- Backend-specific system-prompt APIs. The first implementation should append to eforge's existing prompt string before harness invocation.
- User-facing `/eforge:extend` authoring UX changes beyond docs/examples needed for the supported capability.

Roadmap alignment: this implements the "agent context/tool injection" roadmap area but intentionally only the prompt/context half (EXTEND_08A), leaving tool injection for EXTEND_08B.

## Acceptance Criteria

- `onAgentRun` registrations captured by native extensions are executed before agent dispatch.
- A handler can return prompt/context text that is appended to the final prompt sent to the harness.
- Handlers can scope behavior by inspecting at least `ctx.role` and `ctx.tier`; `ctx.phase`/`ctx.stage` is provided where the engine can do so reliably and documented as best-effort/optional otherwise.
- Extension-added context is wrapped in the final prompt with clear per-extension provenance.
- Existing tier/role/plan `promptAppend` behavior continues to work and remains distinct from extension-added context.
- The augmented prompt path works for both Claude SDK and Pi harnesses because augmentation happens before `harness.run()`.
- New events or diagnostics make applied context, hook failures, and hook timeouts observable without emitting full prompt text.
- Agent-context hook failures/timeouts are fail-open: they do not crash or block the build in this slice.
- Extension-added context does not mutate profile, toolbelt, project MCP selection, `allowedTools`, `disallowedTools`, or custom tools.
- SDK types/docs clearly state that EXTEND_08A supports prompt/context append only; extension-contributed tools and tool availability tuning remain deferred to EXTEND_08B.
- Tests cover prompt composition/provenance, role/tier/phase filtering, failure/timeout diagnostics, existing config `promptAppend` coexistence, and at least one engine wiring path using `StubHarness`.
- `pnpm type-check` and relevant tests pass, including event schema/registry/exhaustive handling tests.
- Extension docs and examples are updated for the supported prompt-context capability.
