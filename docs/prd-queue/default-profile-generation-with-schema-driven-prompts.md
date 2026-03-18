---
title: Default Profile Generation with Schema-Driven Prompts
created: 2026-03-18
status: pending
---

# Default Profile Generation with Schema-Driven Prompts

## Problem / Motivation

Profile generation (`--generate-profile`) lets the planner synthesize custom workflow profiles tailored to each PRD instead of just picking from built-ins. It's currently opt-in via a CLI flag, but it produces better-tuned profiles and should be the default. The hardcoded field list in the planner prompt is a maintenance liability - it can drift out of sync with the Zod schema that actually validates profiles. Generated profiles also get generic names (`generated` or the extended profile name) instead of descriptive ones.

## Goal

Make profile generation the default behavior and keep the prompt's profile schema documentation automatically in sync with validation by generating it from Zod schemas. Give generated profiles descriptive custom names.

## Approach

1. **Schema-driven prompts**: Annotate Zod schema fields with `.describe()` and export a `getProfileSchemaYaml()` function that converts the schema to JSON Schema, cleans it, and returns YAML. Cache the result at module level since the schema is static. Replace the hardcoded field list in `formatProfileGenerationSection()` with this generated output.

2. **Named profiles**: Add an optional `name` field to `GeneratedProfileBlock`, update the XML parser to capture it, and prefer it as the profile name in event emission (`generatedBlock.name ?? generatedBlock.extends ?? 'generated'`).

3. **Flip the CLI default**: Replace `--generate-profile` (opt-in) with `--no-generate-profile` (opt-out) using Commander's `--no-` prefix convention. Ensure queue mode also defaults to profile generation by passing `generateProfile: options.generateProfile ?? true` in the `compile()` call.

## Scope

**In scope:**
- Adding `.describe()` annotations to fields on `reviewProfileConfigSchema`, `agentProfileConfigSchema`, `resolvedProfileConfigSchema`, and `buildStageSpecSchema` in `src/engine/config.ts`
- Exported `getProfileSchemaYaml()` function using `z.toJSONSchema()`, stripping `$schema` and `~standard` keys, returning YAML via the existing `yaml` package dependency, with module-level caching
- Adding `name?: string` to `GeneratedProfileBlock` interface in `src/engine/agents/common.ts`
- Updating `parseGeneratedProfileBlock()` to capture `parsed.name` in both extends and full-config branches
- Rewriting `formatProfileGenerationSection()` in `src/engine/agents/planner.ts` to use `getProfileSchemaYaml()` output, updating example XML to include `"name"`, adding a rule for descriptive kebab-case names
- Updating profile event emission (line 245 in planner.ts) to prefer `generatedBlock.name`
- Flipping CLI default in `src/cli/index.ts`: `--generate-profile` → `--no-generate-profile`
- Passing `generateProfile: options.generateProfile ?? true` at line 623 in `src/engine/eforge.ts` for queue mode
- New tests in `test/dynamic-profile-generation.test.ts`: name capture in both parse modes, planner using custom name as `profileName`, `getProfileSchemaYaml()` returning valid YAML with key fields and descriptions
- Updating CLAUDE.md CLI flags section to reflect the new default

**Out of scope:**
- Changing profile validation logic
- Modifying built-in profile definitions
- Breaking existing tests (engine layer still treats `generateProfile: undefined` as falsy)

## Acceptance Criteria

- `getProfileSchemaYaml()` returns valid YAML containing key profile fields and their descriptions, derived from Zod schemas
- `getProfileSchemaYaml()` result is cached (subsequent calls return the same reference)
- `parseGeneratedProfileBlock()` captures `name` from the XML in extends mode, full-config mode, and returns `undefined` when absent
- Planner emits a `plan:profile` event using the generated profile's custom `name` as `profileName`
- `formatProfileGenerationSection()` uses schema-generated YAML instead of a hardcoded field list
- Running `eforge run` on a PRD without any flags produces a `plan:profile` event with a custom name and inline config (profile generation is on by default)
- `--no-generate-profile` disables profile generation
- Queue mode defaults to profile generation (`generateProfile: options.generateProfile ?? true`)
- `pnpm test -- test/dynamic-profile-generation.test.ts` passes (new and existing tests)
- `pnpm type-check` passes with no new type errors
- `pnpm build` succeeds
- CLAUDE.md CLI flags section updated: `--generate-profile` → `--no-generate-profile` with note that profile generation is on by default
