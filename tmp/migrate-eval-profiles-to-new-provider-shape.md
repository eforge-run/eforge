# Migrate eval profiles to new provider shape

## Context

The schema change in <main PRD link/id> moved Pi `provider` from per-model
fields to `agentRuntimes.<name>.pi.provider`. Eval profiles in
`eval/eforge/profiles/` still use the old shape and now fail Zod validation
at config load. This PRD migrates them in lockstep with the main change so
evals are runnable again.

## Scope

Migrate four profile files and refresh README examples. Mechanical edits
only — no behavior change, no resolver/test work.

### Files

- `eval/eforge/profiles/pi-gpt.yaml` — move `provider: openai-codex` from
  both `agents.models.{max,balanced}` entries to
  `agentRuntimes.default.pi.provider`.
- `eval/eforge/profiles/pi-opus.yaml` — same pattern, provider `anthropic`.
- `eval/eforge/profiles/pi-kimi-k-2-6.yaml` — same pattern, provider
  `openrouter`.
- `eval/eforge/profiles/mixed-opus-planner-pi-builder.yaml` — add
  `pi.provider: mlx-lm` to the existing `pi-local` runtime entry; drop the
  `provider:` field from the `roles.builder.model` block (becomes
  `model: { id: unsloth/Qwen3.6-... }`). The `opus` runtime stays
  claude-sdk and gets no `pi:` block.
- `eval/eforge/profiles/README.md` — update the "Profile matrix" notes and
  any inline YAML examples to reflect the new shape.

## Verification

1. Load each migrated profile via `eforge` CLI / MCP — Zod accepts.
2. Run a smoke eval against `pi-gpt` and confirm dispatch to
   `openai-codex/gpt-5.5`.
3. Run a `mixed-opus-planner-pi-builder` build and confirm the builder
   role still routes to `mlx-lm` Qwen via the renamed runtime.
