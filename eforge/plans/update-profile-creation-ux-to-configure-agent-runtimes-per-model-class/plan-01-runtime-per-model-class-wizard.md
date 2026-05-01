---
id: plan-01-runtime-per-model-class-wizard
name: Per-model-class agent runtime wizard
branch: update-profile-creation-ux-to-configure-agent-runtimes-per-model-class/runtime-per-model-class
---

# Per-model-class agent runtime wizard

## Architecture Context

The Pi native command `/eforge:profile:new` lives in `packages/pi-eforge/extensions/eforge/profile-commands.ts` and currently asks for one harness (and one Pi provider) up front, then loads models for that single runtime and asks for `max`, `balanced`, and `fast` model IDs from that single list. This forces every model class to share one runtime.

The daemon's `POST /api/profile/create` endpoint already accepts a multi-runtime payload shape (`packages/monitor/src/server.ts` lines 1209-1281): when the body includes `agentRuntimes` (a `Record<string, AgentRuntimeEntry>`) plus `defaultAgentRuntime` (a string), it forwards them to `createAgentRuntimeProfile` in `packages/engine/src/config.ts`, which writes a YAML profile of the form:

```yaml
agentRuntimes:
  <name>:
    harness: claude-sdk | pi
    pi:
      provider: <string>
      # other optional pi config
defaultAgentRuntime: <name>
agents:
  models:
    max: { id: <id> }
    balanced: { id: <id> }
    fast: { id: <id> }
  tiers:
    implementation:
      agentRuntime: <name>   # only when balanced uses a different runtime than max
```

The engine config schema (`packages/engine/src/config.ts`) defines:

- `agentRuntimes: Record<string, AgentRuntimeEntry>` where each entry has `harness` plus optional harness-specific config (`pi`, `claudeSdk`).
- `defaultAgentRuntime: string` (required when `agentRuntimes` is non-empty).
- `agents.tiers` keyed by `planning | implementation | review | evaluation` only — `agents.tiers.max|balanced|fast` keys would fail validation.
- `agents.models.{max,balanced,fast}` accept a `ModelRef` (`{ id, ... }`); the Pi provider lives on the `agentRuntimes.<name>.pi.provider` entry, NOT on the model ref.
- `agents.roles.<role>.agentRuntime` and `agents.tiers.<tier>.agentRuntime` may reference any `agentRuntimes` key.

No engine, daemon, or model-resolution changes are needed: the daemon already accepts the multi-runtime payload and writes the right YAML.

## Implementation

### Overview

Replace `handleProfileNewCommand` in `profile-commands.ts` so that, after the scope step, it walks the user through three model-class steps in order — `max`, `balanced`, `fast` — each step selecting an agent runtime (claude-sdk, or pi + provider) and then a model from that runtime's model list. The wizard accumulates a runtime registry keyed by a stable name (`claude-sdk` for the Claude SDK runtime, `pi-<provider>` for each Pi+provider combination) and uses those names in the daemon payload. Drop the global `agents.effort` and `pi.thinkingLevel` tuning steps entirely. Finally, send the new multi-runtime daemon payload (`agentRuntimes`, `defaultAgentRuntime`, `agents.models`, optional `agents.tiers.implementation.agentRuntime`).

Update the two skill docs (`packages/pi-eforge/skills/eforge-profile-new/SKILL.md` and `eforge-plugin/skills/profile-new/profile-new.md`) so non-native fallback flows describe the same per-model-class agent-runtime UX, drop the global tuning step, and document the multi-runtime YAML output. Bump the Claude plugin version because the plugin skill doc changed.

### Key Decisions

1. **Runtime naming convention:** the wizard derives stable runtime names from the chosen harness + provider — `claude-sdk` for Claude SDK, `pi-<provider>` for Pi (e.g., `pi-anthropic`, `pi-zai`). This makes the resulting `agentRuntimes` map readable, matches the existing repo's `agentRuntimes.claude-sdk` convention in `eforge/config.yaml`, and avoids needing to ask the user for runtime names.
2. **De-duplicate runtimes by name:** if two model classes pick the same harness+provider, they share a single `agentRuntimes` entry. The map only contains entries for runtimes the user actually selected.
3. **`defaultAgentRuntime` = max runtime:** the runtime chosen for `max` becomes the profile's default. Planning, review, and evaluation tiers fall through to this default.
4. **Tier override only for balanced:** if `balanced`'s runtime differs from `max`'s runtime, emit `agents.tiers.implementation.agentRuntime: <balancedRuntimeName>` to route implementation work through the balanced runtime. If they match, do not emit any `agents.tiers` overrides.
5. **`fast` is declared but not routed:** `fast` adds an entry to `agentRuntimes` (when its runtime is new) and sets `agents.models.fast.id`, but does NOT get a tier override — eforge has no built-in workload tier that defaults to `fast`. The preview overlay and skill docs explicitly call this out so users are not surprised.
6. **No global tuning step:** the wizard no longer asks for `agents.effort` or top-level `pi.thinkingLevel`. Users who want those must edit the YAML directly. This matches the source PRD's explicit out-of-scope list.
7. **Smart defaults for the cascading runtime picker:**
   - `max`: explicit runtime (claude-sdk or pi+provider) and explicit model. Default harness from the name hint (`claude-` -> `claude-sdk`, otherwise `pi`).
   - `balanced`: first overlay offers "same runtime and model as max" as the top option, plus "different runtime" branch. If the user picks the same runtime, also default the model to the max model with an option to pick a different model from that runtime's list. If the user picks a different runtime, run the runtime+provider+model sub-flow for balanced.
   - `fast`: top options are "same as balanced", and (when max != balanced) "same as max". A "different runtime" branch runs the runtime+provider+model sub-flow.
8. **Extract payload-building logic into a pure helper** (e.g., `buildProfileCreatePayload`) in `profile-commands.ts` (or a sibling file) so the runtime-deduplication and tier-override logic is unit-testable without TUI.

## Scope

### In Scope

- Replace the wizard in `packages/pi-eforge/extensions/eforge/profile-commands.ts:handleProfileNewCommand` with a per-model-class agent runtime/model flow.
- Add a pure helper that converts the wizard's collected selections (one runtime+model per class) into the daemon `profileCreate` payload (`{name, scope, agentRuntimes, defaultAgentRuntime, agents: {models, tiers?}}`). The helper must:
  - de-duplicate runtimes by name,
  - set `defaultAgentRuntime` to the max runtime's name,
  - emit `agents.tiers.implementation.agentRuntime` ONLY when balanced's runtime differs from max's,
  - never emit `agents.tiers.max|balanced|fast` keys,
  - never emit `agents.effort` or top-level `pi.thinkingLevel`,
  - place the Pi provider on `agentRuntimes.<name>.pi.provider`, never inside `agents.models.*`.
- Update the confirmation overlay to show a YAML preview of the new multi-runtime profile shape, including a one-line note that `fast` is declared for future/manual use and is not currently routed by default.
- Update `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` to describe the same per-model-class agent-runtime workflow, the new payload shape (`agentRuntimes` + `defaultAgentRuntime` + `agents.models` + optional `agents.tiers.implementation.agentRuntime`), and remove the optional tuning step.
- Update `eforge-plugin/skills/profile-new/profile-new.md` with the same workflow and payload shape, and remove the optional tuning step.
- Bump `eforge-plugin/.claude-plugin/plugin.json` version (patch bump from `0.20.0` to `0.20.1`) because the plugin skill doc changed.
- Add unit tests under `test/` for the payload-building helper covering: same-runtime-for-all-classes, different runtime for balanced, different runtime for fast, all three classes on different runtimes, claude-sdk + pi mix, and confirmation that no global tuning fields and no invalid tier keys are emitted.

### Out of Scope

- Engine schema changes, including any new `agents.modelRuntimes` concept.
- Changes to model resolution semantics or to how agent tiers/roles map to model classes at runtime.
- Changes to the MCP proxy in `packages/eforge/src/cli/mcp-proxy.ts` or to the `eforge_profile` MCP tool surface (the existing tool already accepts the daemon's create payload).
- Adding advanced workload-tier or per-role tuning UI to the wizard.
- Touching `handleProfileCommand` (the inspect/switch flow).

## Files

### Create

- `packages/pi-eforge/extensions/eforge/profile-payload.ts` — pure helper module exporting `buildProfileCreatePayload(input)` and the supporting types (`ModelClassSelection`, `ProfileCreateInput`, `ProfileCreatePayload`). Houses the de-duplication, default-runtime, and tier-override logic so it can be unit-tested without the TUI overlay stack.
- `test/profile-payload.test.ts` — vitest cases for `buildProfileCreatePayload` covering the matrix in the In Scope section.

### Modify

- `packages/pi-eforge/extensions/eforge/profile-commands.ts` — rewrite `handleProfileNewCommand` to use the per-model-class wizard, drop the global tuning steps, and call `buildProfileCreatePayload` before posting to `API_ROUTES.profileCreate`. Keep `handleProfileCommand` untouched.
- `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` — replace Steps 2–5 with a per-model-class agent runtime workflow; update Step 6's payload preview to the multi-runtime shape; update Step 7's `eforge_profile` create payload to include `agentRuntimes` + `defaultAgentRuntime` + optional `agents.tiers.implementation.agentRuntime`; remove the global tuning step; add the note that `fast` is declared but not currently routed by default.
- `eforge-plugin/skills/profile-new/profile-new.md` — same content updates as the SKILL.md above, adapted for the Claude plugin tool names (`mcp__eforge__eforge_profile`, `mcp__eforge__eforge_models`).
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` from `0.20.0` to `0.20.1`.

## Verification

- [ ] `handleProfileNewCommand` in `packages/pi-eforge/extensions/eforge/profile-commands.ts` does not call `showSelectOverlay` for a single global harness picker before model selection; instead, it asks for runtime+model per model class in order `max`, `balanced`, `fast`.
- [ ] When the user picks the same runtime for `max` and `balanced`, the wizard offers `"Same as max (<model>)"` as the top option in the balanced model overlay; when they pick the same runtime for `balanced` and `fast`, the wizard offers `"Same as balanced (<model>)"` as the top option in the fast model overlay.
- [ ] When max and balanced share a runtime, the fast step preselects that shared runtime; when they differ, the fast step offers the user both previously selected runtimes plus an option to choose a different runtime.
- [ ] `buildProfileCreatePayload` returns a payload whose `agentRuntimes` map has exactly one entry per unique selected runtime, keyed `claude-sdk` for the Claude SDK and `pi-<provider>` for each distinct Pi provider.
- [ ] `buildProfileCreatePayload` sets `defaultAgentRuntime` to the runtime name selected for `max`.
- [ ] `buildProfileCreatePayload` emits `agents.tiers.implementation.agentRuntime: <balanced-runtime-name>` if and only if the balanced runtime name differs from the max runtime name; otherwise the returned `agents.tiers` is undefined.
- [ ] `buildProfileCreatePayload` never includes any of `agents.tiers.max`, `agents.tiers.balanced`, `agents.tiers.fast`, `agents.effort`, or top-level `pi.thinkingLevel` in its output (asserted by unit test).
- [ ] `buildProfileCreatePayload` places each Pi provider only on `agentRuntimes.<name>.pi.provider`; `agents.models.{max,balanced,fast}` contain `{ id }` only (no `provider` field) (asserted by unit test).
- [ ] Tests under `test/profile-payload.test.ts` pass and cover: all three classes share one runtime; balanced differs from max; fast differs from balanced and from max; claude-sdk + pi mix; verification that `agents.effort` and `pi.thinkingLevel` are absent from output.
- [ ] Confirmation overlay output (the YAML preview rendered via `showInfoOverlay` or the existing confirm select) includes the literal substring `agentRuntimes:` and the literal substring `not currently used by default` (or equivalent fixed phrase) describing the `fast` model class status.
- [ ] `packages/pi-eforge/skills/eforge-profile-new/SKILL.md` no longer contains the prior `Step 5: Optional tuning` section asking for `agents.effort` or `pi.thinkingLevel`, and its create-payload example shows `agentRuntimes` + `defaultAgentRuntime` instead of top-level `harness` + `pi`.
- [ ] `eforge-plugin/skills/profile-new/profile-new.md` no longer contains the prior `Step 5: Optional tuning` section, and its `mcp__eforge__eforge_profile` create example shows `agentRuntimes` + `defaultAgentRuntime` instead of top-level `harness` + `pi`.
- [ ] `eforge-plugin/.claude-plugin/plugin.json` `version` field equals `0.20.1`.
- [ ] `pnpm type-check` exits with code 0.
- [ ] `pnpm test` exits with code 0.
- [ ] `pnpm build` exits with code 0.
- [ ] No file under `packages/engine/src/` or `packages/monitor/src/server.ts` is modified by this plan (engine schema and daemon endpoint unchanged).
