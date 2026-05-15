---
id: plan-01-agent-context-runtime
name: Agent prompt/context extension runtime
branch: extend-08a-agent-prompt-context-extension-hooks/plan-01-agent-context-runtime
agents:
  builder:
    effort: high
    rationale: Cross-cutting feature touching engine runtime, SDK types, wire
      schemas, monitor UI exhaustive handling, docs, and tests. The
      registry/harness decorator must apply consistently across every agent run
      and emit new typed events without leaking prompt text.
  reviewer:
    effort: high
    rationale: API surface change to public SDK and wire-event contract requires
      careful review for scope-creep (no EXTEND_08B tool wiring), exhaustive
      event handling, fail-open behavior, and provenance correctness.
---

## Architecture Context

EXTEND_08A is the first runtime slice after EXTEND_07 native event hooks that lets native extensions influence agent runs. The codebase already loads native extensions in `EforgeEngine.create()` and captures `onAgentRun` registrations into `NativeExtensionRegistry.agentRunHooks`, but never executes them. Both real harnesses (`packages/engine/src/harnesses/claude-sdk.ts`, `packages/engine/src/harnesses/pi.ts`) consume `AgentRunOptions.prompt` as their final user prompt, so prompt augmentation can be applied centrally before `harness.run()` without touching provider-specific code.

Key constraints derived from `AGENTS.md` and the PRD:

- **Engine emits, consumers render.** New observability must be typed `EforgeEvent` variants; no stdout, no raw prompt text in events.
- **Provider SDK imports stay under `packages/engine/src/harnesses/`.** Augmentation runs at the registry/harness boundary, never inside an SDK module.
- **Event schemas live in `packages/client/src/events.schemas.ts`.** TypeBox is the wire source of truth; `event-registry.ts` and the monitor UI exhaustive handling must be updated in lockstep.
- **State mutation is single-entry-point.** No `mutateState` touch is required — these are diagnostic-only events.
- **No EXTEND_08B creep.** Custom tools and `allowedTools`/`disallowedTools` returned by handlers are not applied; they emit an `unsupported` diagnostic instead.
- **Existing config `promptAppend` precedence must be preserved.** Extension fragments append *after* the resolved `promptAppend` already consumed by `loadPrompt(name, vars, options.promptAppend)`.

## Implementation

### Overview

Introduce a new engine runtime layer that:

1. Reads `agentRunHooks` from the loaded `NativeExtensionRegistry`.
2. Wraps the `AgentRuntimeRegistry` returned by `buildAgentRuntimeRegistry()` (or `singletonRegistry()`) with a decorator that, for every `forRole(role)` / `forRoleResolved(role)` lookup, returns an `AgentHarness` whose `run()` method:
   - Builds an `AgentRunContext` (role, tier, profile, planId, phase/stage, harness, toolbelt) from `AgentRunOptions` plus engine-side context (extension registry, profile name, cwd, logger, exec stub).
   - Invokes each registered `agentRunHook` sequentially with a per-hook timeout (default `extensions.agentContextHookTimeoutMs`, falling back to `extensions.eventHookTimeoutMs`).
   - Composes returned `promptAppend` fragments into a single trailing section wrapped with per-extension provenance and appends it to `options.prompt` before delegating to the inner harness's `run()`.
   - Yields new typed diagnostic events from the wrapper generator stream: `extension:agent-context:applied`, `:failed`, `:timeout`, and `:unsupported` (when a handler returns `tools`/`allowedTools`/`disallowedTools`).
3. Wires the decorator once during `EforgeEngine.create()` after the registry is resolved, so every existing call site that uses `this.agentRuntimes.forRole(...)` benefits without per-call-site edits.
4. Threads a best-effort `phase` / `stage` value into `AgentRunOptions` (compile/build/recovery/standalone) so handlers can scope by lifecycle context.
5. Narrows the public SDK `AgentRunAugmentation` contract to prompt-only behavior in this slice while retaining a typed `unsupported`-diagnostics path for legacy tool fields.

### Key Decisions

1. **Apply augmentation at the registry/harness boundary, not inside agent runners or provider harnesses.** Both real harnesses consume `options.prompt`; centralizing in a decorator avoids editing every `runBuilder`/`runReviewer`/etc. call site and keeps SDK imports inside `packages/engine/src/harnesses/`.
2. **Compose extension prompt fragments *after* the resolved `promptAppend`.** Existing tier/role/plan `promptAppend` is already concatenated by `loadPrompt(name, vars, options.promptAppend)` in `packages/engine/src/prompts.ts`. The decorator only sees the final `options.prompt`, so appending after it preserves precedence: bundled prompt -> variable substitution -> config promptAppend -> extension provenance section.
3. **Wrap each extension's contribution in a named, fenced provenance section.** The composed suffix takes the form `\n\n## Native extension context\n\n### <extensionName>\n<fragment>\n` per extension. Extension name (not absolute path) is the visible label; the path is recorded only in the `applied` event metadata. Multiple extensions are appended in deterministic registry order.
4. **Fail open on handler error/timeout.** A failing or timed-out hook must yield a typed diagnostic event but never abort the agent run; the unmodified `options.prompt` continues to the harness. Timeout is enforced with `AbortController` plus a `setTimeout` race, identical to the established pattern in `event-runtime.ts`.
5. **Add new event variants without leaking prompt text.** Diagnostic events carry extension name/path, role, tier, phase/stage, planId, harness, toolbelt summary, fragment character count, and (for failures) message/stack. They never include the prompt fragment itself.
6. **Reuse the event-runtime hook timeout default; allow override via a new config key.** Add `extensions.agentContextHookTimeoutMs` (positive integer, optional). When omitted, fall back to `extensions.eventHookTimeoutMs` (already defaulted to `DEFAULT_NATIVE_EVENT_HOOK_TIMEOUT_MS = 5000`).
7. **Expose `phase` conservatively.** Add `phase?: string` and `stage?: string` to `AgentRunOptions`. Populate `stage` when the agent runs inside a pipeline build stage (e.g. `'implement'`, `'review'`, `'evaluate'`, `'doc-author'`, `'doc-sync'`, `'test-write'`, `'test'`); populate `phase` to `'compile'` or `'build'` based on which pipeline emitted the call. Standalone engine helpers (recovery-analyst, staleness-assessor, formatter, dependency-detector, prd-validator, gap-closer) use `phase: 'standalone'` with no `stage`. Document the values explicitly so authors know what to filter on.
8. **Narrow `AgentRunAugmentation` runtime support to `promptAppend`.** Keep the existing optional fields in the SDK type so existing SDK consumers continue to type-check, but mark `tools`, `allowedTools`, and `disallowedTools` with `@deprecated` JSDoc tags referring to EXTEND_08B, and the runtime emits `extension:agent-context:unsupported` when any of those are returned. Do NOT delete the fields in this slice — the goal is documented runtime behavior, not a SDK-breaking type change.
9. **Surface registry-time toolbelt summary in context but never mutate it.** The decorator already has access to `forRoleResolved()`'s `toolbeltSummary` — pass `toolbelt`, `toolbeltSource`, `projectMcpSelection` into `AgentRunContext` for read-only inspection. The decorator must never write to `allowedTools`, `disallowedTools`, `customTools`, or `projectMcpServerNames`.
10. **Use `StubHarness` for wiring tests; no provider mocks.** Verify final `options.prompt` includes existing config promptAppend AND extension provenance section; verify deterministic order; verify failure/timeout diagnostics; verify unsupported-field diagnostic; verify role/tier/phase filtering inside handlers.

## Scope

### In Scope

- New engine module `packages/engine/src/extensions/agent-context-runtime.ts` exporting `withAgentContextHooks(registry, options)` that returns an `AgentRuntimeRegistry` decorator and a separate `executeAgentRunHooks(...)` helper for unit testing.
- Wire the decorator once in `EforgeEngine.create()` after the registry is built (covers both the user-provided and config-derived paths).
- Add `phase?: string` and `stage?: string` to `AgentRunOptions` in `packages/engine/src/harness.ts`. Add both to the `NON_SDK_KEYS` set so they are stripped by `pickSdkOptions`.
- Populate `phase`/`stage` in build-stage call sites (`packages/engine/src/pipeline/stages/build-stages.ts`, `compile-stages.ts`) and in the standalone engine helper call sites (`packages/engine/src/eforge.ts`) where the runner is known.
- Add four new typed event variants to `packages/client/src/events.schemas.ts`: `extension:agent-context:applied`, `extension:agent-context:failed`, `extension:agent-context:timeout`, `extension:agent-context:unsupported`. Each carries safe metadata only (no prompt fragment text).
- Register the four new variants in `packages/client/src/event-registry.ts` (scope: session, persist: false, summary functions).
- Update monitor UI to handle the new variants: append to `IGNORED_EVENT_TYPES` in `packages/monitor-ui/src/lib/reducer/index.ts`, add timeline summaries/details and badge classes in `packages/monitor-ui/src/components/timeline/event-card.tsx`.
- Add config field `extensions.agentContextHookTimeoutMs` to the Zod schema and `ExtensionConfig` type in `packages/engine/src/config.ts`, plus `DEFAULT_CONFIG` and `loadConfig` defaulting.
- Narrow runtime behavior of `AgentRunAugmentation` to prompt-only. Update the SDK in `packages/extension-sdk/src/hooks.ts` to JSDoc-deprecate `tools`, `allowedTools`, and `disallowedTools` referencing EXTEND_08B, and adjust the SDK README/exports note. Do not delete those optional properties (keeps existing example/snippet type-checks viable until EXTEND_08B). Update `packages/extension-sdk/src/context.ts`'s `AgentRunContext` to add optional `phase`, `stage`, `harness`, `toolbelt`, `toolbeltSource`, and `projectMcpSelection` read-only fields.
- Add `RegistryGlobalOptions`-style typed dependencies for the runtime (registry, profile name, cwd, timeoutMs) so the decorator can be constructed cleanly.
- Add a new supported example `examples/extensions/agent-context.ts` demonstrating builder-only and reviewer-tier prompt-context augmentation.
- Update docs: `docs/extensions-api.md` (runtime-support table row for `onAgentRun`, signature/context/augmentation notes, supported fields call-out, tool fields deferred), `docs/extensions.md` (runtime-support table and brief narrative), and the corresponding `web/content/docs/extensions.md` and `web/content/docs/extensions-api.md` mirror.
- Add new tests:
  - `test/extension-agent-context-runtime.test.ts` covering: prompt composition with provenance, ordering across multiple extensions, role/tier/phase filtering inside handlers, fail-open on handler throw, fail-open on timeout, unsupported-field diagnostic, coexistence with config `promptAppend`, and absence of raw prompt text in any emitted event.
  - One new wiring test in `test/agent-wiring.test.ts` (or a new sibling) using `StubHarness` to assert that an `EforgeEngine.create()`-built registry actually applies an `onAgentRun` registration to a builder run end-to-end and emits an `extension:agent-context:applied` event.
  - One wire-schema/registry exhaustive test in `packages/client/src/__tests__/events-schemas.test.ts` (or `events-wire-parity.test.ts`) covering the four new variants.
- Bump `eforge-plugin/.claude-plugin/plugin.json` version per AGENTS.md convention because the runtime behavior of `onAgentRun` materially changes from "captured only" to "prompt-context supported." Pi extension package version stays untouched.

### Out of Scope

- Applying `tools`, `allowedTools`, `disallowedTools`, or `customTools` returned by `onAgentRun` handlers (EXTEND_08B).
- Implementing `registerTool` runtime injection.
- Profile routers, input sources, reviewer perspectives, validation providers, policy gates, custom stages.
- Adding a backend-specific system-prompt API (Claude `system` parameter, Pi `system_instruction`). Augmentation appends to the user prompt string for both harnesses in this slice.
- Persisting agent-context diagnostics to the daemon DB (the new events are session-scoped, transient — same shape as `extension:event-handler:*`).
- Mutating profile, toolbelt selection, `projectMcpServerNames`, or `.mcp.json`.
- Changes to `eforge extension new` scaffolding templates beyond doc updates referencing the new example.

## Files

### Create

- `packages/engine/src/extensions/agent-context-runtime.ts` — Executes captured `agentRunHooks` with timeout/fail-open, composes prompt fragments with provenance, emits typed diagnostic events. Exports `withAgentContextHooks(registry, deps)` decorator and a unit-testable `executeAgentRunHooks(...)`.
- `examples/extensions/agent-context.ts` — Supported prompt-context example targeting builder role with role/tier filtering and brief promptAppend text.
- `test/extension-agent-context-runtime.test.ts` — Unit + integration tests for composition, ordering, filtering, fail-open, timeout, unsupported-field diagnostic, and `StubHarness`-driven wiring.

### Modify

- `packages/engine/src/extensions/index.ts` — Export `withAgentContextHooks`, `executeAgentRunHooks`, and new typed runtime types (`AgentContextHookContext`, `AgentContextHookRuntimeOptions`).
- `packages/engine/src/extensions/types.ts` — Refine `AgentRunRegistration` to carry the typed agent-run handler signature internally (the value is still an `ExtensionHandler` opaque to the recorder, but the runtime narrows it on read).
- `packages/engine/src/eforge.ts` — After `agentRuntimes` is resolved in `create()`, wrap it via `withAgentContextHooks(registry, { extensionRegistry, profile, cwd, timeoutMs })`. Pass through the relevant `extensionLoadResult.registry`. No call-site changes elsewhere.
- `packages/engine/src/harness.ts` — Add `phase?: string` and `stage?: string` to `AgentRunOptions`. Add both keys to `NON_SDK_KEYS` so `pickSdkOptions()` strips them. Add optional `extensionContextApplied?: number` debug field (count of applied extensions, used by harness debug payload for diagnostics) but DO NOT forward to backend SDK.
- `packages/engine/src/pipeline/stages/build-stages.ts` — When constructing builder/reviewer/test-cycle/etc. agent options, set `phase: 'build'` and `stage` to the current stage name. Confine edits to the agent run option-building helpers; avoid touching unrelated stage logic.
- `packages/engine/src/pipeline/stages/compile-stages.ts` — Set `phase: 'compile'` and `stage` for planner/module-planner/plan-reviewer/architecture-reviewer/cohesion-reviewer/etc. call sites.
- `packages/engine/src/eforge.ts` (standalone helpers) — When constructing options for `runStalenessAssessor`, `runRecoveryAnalyst`, `runFormatter`, `runDependencyDetector`, `runPrdValidator`, `runGapCloser`, `runValidationFixer`, `runMergeConflictResolver`, set `phase: 'standalone'`. Stage stays `undefined` for these.
- `packages/engine/src/config.ts` — Add `agentContextHookTimeoutMs` field to `extensionConfigSchema` and `ExtensionConfig`; thread through `DEFAULT_CONFIG.extensions` and `loadConfig()` so the resolved value is always defined.
- `packages/client/src/events.schemas.ts` — Add four `Type.Object` variants to the `EforgeEventSchema` union: `extension:agent-context:applied` (carries extensionName, extensionPath, role, tier, phase, stage, profile, planId, harness, toolbelt, projectMcpSelection, promptCharCount, fragmentCount), `:failed` (same correlation fields plus message, optional stack), `:timeout` (same correlation fields plus timeoutMs), `:unsupported` (same correlation fields plus a `fields: Array<'tools'|'allowedTools'|'disallowedTools'>` array). Use `Type.Optional` for fields that may be unknown at emission time (e.g. `planId`, `stage`, `toolbelt`).
- `packages/client/src/event-registry.ts` — Add entries for the four new event types: `scope: 'session'`, `persist: false`, with summary functions (e.g. `(e) => \`Extension ${e.extensionName} appended ${e.promptCharCount} chars to ${e.role} (${e.tier})\``).
- `packages/monitor-ui/src/lib/reducer/index.ts` — Append the four new types to `IGNORED_EVENT_TYPES` so they don't dirty derived state (mirrors `extension:event-handler:*` handling).
- `packages/monitor-ui/src/components/timeline/event-card.tsx` — Add badge-class branches (info/success for `:applied`, failed for `:failed`/`:timeout`, warning for `:unsupported`), summary lines, and detail blocks. Keep the existing event-handler diagnostic format as the template.
- `packages/extension-sdk/src/hooks.ts` — Update `AgentRunAugmentation` JSDoc: mark `tools`, `allowedTools`, `disallowedTools` as `@deprecated` referring to EXTEND_08B, clarify that returning them in EXTEND_08A emits an `extension:agent-context:unsupported` diagnostic and is otherwise ignored. Keep field types intact.
- `packages/extension-sdk/src/context.ts` — Extend `AgentRunContext` with optional `phase?: string`, `stage?: string`, `harness?: 'claude-sdk' | 'pi'`, `toolbelt?: string | null`, `toolbeltSource?: 'tier' | 'role' | 'plan' | 'default'`, `projectMcpSelection?: 'all' | 'none' | 'toolbelt'`. Document these as read-only metadata.
- `packages/extension-sdk/src/api.ts` — Update `onAgentRun` JSDoc `@remarks` to say "Runtime-supported for `promptAppend`; tool fields deferred to EXTEND_08B." Update the JSDoc example to use only `promptAppend`.
- `packages/extension-sdk/README.md` — Add or update the `onAgentRun` section: minimal supported example, fail-open note, deprecation note for tool fields.
- `docs/extensions-api.md` — Update the `onAgentRun` section runtime-status line and add notes on fail-open + provenance + tool deferral. Update the runtime-support table at the bottom: change `onAgentRun` row to "Yes (promptAppend only)" and add a footnote about EXTEND_08B for tool fields.
- `docs/extensions.md` — Update the runtime-support summary mirror and add a short narrative on how extensions can append role-/tier-/phase-scoped context with provenance.
- `web/content/docs/extensions-api.md` — Sync the updates from `docs/extensions-api.md`.
- `web/content/docs/extensions.md` — Sync the updates from `docs/extensions.md`.
- `examples/extensions/README.md` — Add a short paragraph and link to the new `agent-context.ts` example.
- `eforge-plugin/.claude-plugin/plugin.json` — Bump version per AGENTS.md convention because user-facing extension behavior changed.
- `test/agent-wiring.test.ts` — Add at least one case that creates an `EforgeEngine` with a `StubHarness`-backed singleton registry and a stub `NativeExtensionRegistry` containing one `agentRunHook`, runs a builder, and asserts both the final prompt seen by the stub and that an `extension:agent-context:applied` event was emitted via the engine's event stream.
- `packages/client/src/__tests__/events-schemas.test.ts` — Add cases for the four new event variants validating via `safeParseEforgeEvent` (or whatever the existing helper is in this file).

## Verification

- [ ] `packages/engine/src/extensions/agent-context-runtime.ts` exports `withAgentContextHooks` and `executeAgentRunHooks`, and `EforgeEngine.create()` wraps both user-provided and config-derived registries with it before storing on `this.agentRuntimes`.
- [ ] An `onAgentRun` handler returning `{ promptAppend: 'X' }` produces a final `AgentRunOptions.prompt` (passed to `harness.run()`) whose last lines contain a `## Native extension context` section, an `### <extensionName>` subsection, and the literal text `X`.
- [ ] When two extensions both return `promptAppend` for the same role, the resulting prompt contains both `### <name1>` and `### <name2>` subsections in registry-iteration order, each followed by the corresponding fragment.
- [ ] Existing tier/role/plan `promptAppend` (resolved via `resolveAgentConfig().promptAppend` and applied through `loadPrompt(..., options.promptAppend)`) appears before the extension provenance section in the final prompt.
- [ ] An `onAgentRun` handler that filters by `ctx.role !== 'builder'` returns nothing produces no prompt change and no `extension:agent-context:applied` event for non-builder roles, and one applied event for a builder run.
- [ ] `ctx.tier`, `ctx.phase`, and `ctx.stage` are populated in the handler context for compile-stage and build-stage call sites, and `phase` is `'standalone'` for the recovery-analyst path.
- [ ] An `onAgentRun` handler that throws emits an `extension:agent-context:failed` event with `message` set to the thrown error's message and does not change `options.prompt`; the agent run completes normally afterwards.
- [ ] An `onAgentRun` handler that hangs longer than the configured `extensions.agentContextHookTimeoutMs` emits an `extension:agent-context:timeout` event with the configured `timeoutMs`, and the harness still receives the unmodified prompt.
- [ ] An `onAgentRun` handler that returns `{ tools: [...] }` or `{ allowedTools: [...] }` or `{ disallowedTools: [...] }` emits an `extension:agent-context:unsupported` event listing the rejected fields and does not mutate `allowedTools`, `disallowedTools`, or `customTools` on the resolved `AgentRunOptions`.
- [ ] Neither `extension:agent-context:applied` nor `:failed` nor `:timeout` nor `:unsupported` events contain the prompt fragment text or the resolved prompt; only metadata, sizes, and counts.
- [ ] `pickSdkOptions(options)` strips `phase` and `stage` so they are never forwarded to a provider SDK.
- [ ] `AgentRunOptions.allowedTools`, `disallowedTools`, `customTools`, `toolbelt`, `projectMcpSelection`, and `projectMcpServerNames` are byte-identical before and after extension-context augmentation (verified via shallow comparison in the wiring test).
- [ ] `packages/client/src/events.schemas.ts` exports schemas for all four new variants and they appear in `EforgeEventSchema`; `safeParseEforgeEvent` accepts each.
- [ ] `packages/client/src/event-registry.ts` has entries for all four new variants and the exhaustive `_Exhaustive` type check compiles.
- [ ] `packages/monitor-ui/src/lib/reducer/index.ts` lists all four new variants in `IGNORED_EVENT_TYPES`, and `packages/monitor-ui/src/components/timeline/event-card.tsx` returns non-default badge-class and summary results for each.
- [ ] `extensions.agentContextHookTimeoutMs` validates as a positive integer in the Zod schema, is present on `ExtensionConfig` with a numeric default, and the default falls back to `extensions.eventHookTimeoutMs` when unset in user config.
- [ ] `docs/extensions-api.md` runtime-support table row for `onAgentRun` reads "Yes (promptAppend only — tools/allowedTools/disallowedTools deferred to EXTEND_08B)" or equivalent wording, and the `onAgentRun` section narrative mentions provenance, fail-open, and timeout.
- [ ] `docs/extensions.md` and `web/content/docs/extensions{,-api}.md` reflect the same changes.
- [ ] `examples/extensions/agent-context.ts` compiles with `pnpm type-check`, demonstrates role/tier filtering using `ctx.role` and `ctx.tier`, returns only `promptAppend`, and `examples/extensions/README.md` references it.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` version is bumped above the current main-branch value.
- [ ] `pnpm type-check`, `pnpm test`, and `pnpm build` all pass.
