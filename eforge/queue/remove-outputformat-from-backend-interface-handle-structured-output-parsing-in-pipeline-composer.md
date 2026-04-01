---
title: Remove `outputFormat` from backend interface - handle structured output parsing in pipeline composer
created: 2026-04-01
---



# Remove `outputFormat` from backend interface - handle structured output parsing in pipeline composer

## Problem / Motivation

`outputFormat` is a Claude SDK-specific feature. The Pi backend can't support it, making every build fail at the pipeline composition step. Even on Claude SDK, it requires workarounds (`maxTurns` bumps, JSON Schema constraint stripping) due to how Claude Code implements structured output internally.

## Goal

Make the pipeline composer backend-agnostic so it works with any backend without requiring structured output support.

## Approach

- Drop `outputFormat` from `backend.run()` in the pipeline composer. Set `maxTurns: 1` (single-turn text call).
- Capture `resultText` from `agent:result` instead of `structuredOutput`.
- Add `extractJson(text)` to strip markdown fences and extract JSON from the text response.
- Validate with existing `pipelineCompositionSchema.parse()` (Zod) and `validatePipeline()`.
- Wrap in a retry loop (max 3 attempts). On failure, append the parse error to the prompt and retry so the model can self-correct.
- Inject the schema YAML into the prompt via a new `{{schema}}` template variable (follows existing `getSchemaYaml()` pattern).
- Remove `outputFormat` from `SdkPassthroughConfig`, `AgentRunOptions`, and the Claude SDK backend passthrough.
- Remove `structuredOutput` from `AgentResultData` and related helpers (`hasStructuredOutput`, `extractResultData` structured output param).
- Remove `getPipelineCompositionJsonSchema()` and `stripUnsupportedKeys()` from `schemas.ts`.

## Scope

**In scope:** `pipeline-composer.ts`, `schemas.ts`, `backend.ts`, `claude-sdk.ts`, `events.ts`, `pipeline-composer.md` prompt.

**Out of scope:** No changes to the Pi backend itself.

## Acceptance Criteria

- Pipeline composer produces valid `plan:pipeline` events using text-based JSON extraction.
- `pnpm test` passes with no regressions.
- `outputFormat` and `structuredOutput` are removed from the backend interface and event types.
