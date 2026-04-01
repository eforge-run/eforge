---
id: plan-01-remove-outputformat
name: Remove outputFormat from backend interface and switch pipeline composer to text-based JSON extraction
depends_on: []
branch: remove-outputformat-from-backend-interface-handle-structured-output-parsing-in-pipeline-composer/remove-outputformat
---

# Remove outputFormat from backend interface and switch pipeline composer to text-based JSON extraction

## Architecture Context

The `outputFormat` field on `SdkPassthroughConfig` and `AgentRunOptions` is a Claude SDK-specific feature that prevents the Pi backend from running pipeline composition. The `structuredOutput` field on `AgentResultData` only exists to carry this SDK-specific data. Both must be removed to make the backend interface backend-agnostic. The pipeline composer must switch to text-based JSON extraction with a retry loop for self-correction on parse failures.

## Implementation

### Overview

Remove `outputFormat` from the backend interface types, remove `structuredOutput` from event types, strip related infrastructure from the Claude SDK backend and schemas, and rewrite the pipeline composer to extract JSON from plain text responses with a retry loop (max 3 attempts).

### Key Decisions

1. **Single-turn text call with `maxTurns: 1`** - The pipeline composer needs only a single text response, not a tool-call cycle. Setting `maxTurns: 1` replaces the previous `maxTurns: 2` that was required for the structured output tool-call + response pattern.
2. **`extractJson()` helper in pipeline-composer.ts** - A local helper that strips markdown code fences and finds JSON objects. Kept local rather than shared since only the pipeline composer needs it currently.
3. **Retry loop with error feedback** - On parse failure, the error message is appended to the prompt and the model is re-invoked so it can self-correct. Max 3 attempts before throwing.
4. **Schema YAML injected via `{{schema}}` template variable** - Follows the existing `getSchemaYaml()` pattern used by reviewers and other agents. A new `getPipelineCompositionSchemaYaml()` convenience getter mirrors the existing convention.
5. **Remove all structured output infrastructure** - `getPipelineCompositionJsonSchema()`, `stripUnsupportedKeys()`, `UNSUPPORTED_JSON_SCHEMA_KEYS`, `hasStructuredOutput()`, and the `structuredOutput` parameter on `extractResultData()` are all deleted since nothing else uses them.

## Scope

### In Scope
- Remove `outputFormat` from `SdkPassthroughConfig` and `AgentRunOptions` in `backend.ts`
- Remove `structuredOutput` from `AgentResultData` in `events.ts`
- Remove `outputFormat` passthrough from Claude SDK backend
- Remove `hasStructuredOutput()` type guard from Claude SDK backend
- Remove `structuredOutput` parameter from `extractResultData()` in Claude SDK backend
- Remove `getPipelineCompositionJsonSchema()`, `stripUnsupportedKeys()`, `UNSUPPORTED_JSON_SCHEMA_KEYS` from `schemas.ts`
- Add `getPipelineCompositionSchemaYaml()` convenience getter to `schemas.ts`
- Rewrite `composePipeline()` in `pipeline-composer.ts` to use text-based JSON extraction with retry
- Add `extractJson()` helper in `pipeline-composer.ts`
- Update `pipeline-composer.md` prompt to include `{{schema}}` and allow markdown-fenced JSON output

### Out of Scope
- Pi backend changes
- Changes to other agents that use `SdkPassthroughConfig` (they never set `outputFormat`)

## Files

### Modify
- `src/engine/backend.ts` - Remove `outputFormat` field from `SdkPassthroughConfig` (line 30) and `AgentRunOptions` (line 64)
- `src/engine/events.ts` - Remove `structuredOutput?: unknown` field from `AgentResultData` (line 95) and its JSDoc comment (line 94)
- `src/engine/schemas.ts` - Remove `UNSUPPORTED_JSON_SCHEMA_KEYS`, `stripUnsupportedKeys()`, `getPipelineCompositionJsonSchema()` (lines 339-372), the comment block above them (lines 304-306). Add `getPipelineCompositionSchemaYaml()` convenience getter using the existing `getSchemaYaml()` + `pipelineCompositionSchema`.
- `src/engine/backends/claude-sdk.ts` - Remove `outputFormat` passthrough (line 77), remove `hasStructuredOutput()` function (lines 289-292), remove `structuredOutput` variable and parameter from `extractResultData()` call site (lines 213-214) and function signature (line 298), remove structuredOutput spread in return (line 343)
- `src/engine/agents/pipeline-composer.ts` - Full rewrite of `composePipeline()`: remove `outputFormat` usage, add `extractJson()` helper, implement retry loop capturing `resultText`, inject schema YAML into prompt via `{{schema}}`, set `maxTurns: 1`
- `src/engine/prompts/pipeline-composer.md` - Add `{{schema}}` section documenting the expected JSON schema. Update output instructions to allow markdown code fences.

## Verification

- [ ] `pnpm type-check` passes with zero errors
- [ ] `pnpm test` passes with zero failures
- [ ] `pnpm build` succeeds
- [ ] `outputFormat` string does not appear in any file under `src/engine/`
- [ ] `structuredOutput` string does not appear in any file under `src/engine/`
- [ ] `stripUnsupportedKeys` string does not appear in any file under `src/engine/`
- [ ] `hasStructuredOutput` string does not appear in any file under `src/engine/`
- [ ] `getPipelineCompositionJsonSchema` string does not appear in any file under `src/engine/`
- [ ] `pipeline-composer.md` contains `{{schema}}` template variable
- [ ] `pipeline-composer.ts` contains `extractJson` function
- [ ] `pipeline-composer.ts` contains retry loop with max 3 attempts
- [ ] `schemas.ts` exports `getPipelineCompositionSchemaYaml` function
