# Config Migration Guide

This guide explains how to migrate from the old eforge config schema to the new tier-based schema introduced when tiers became the single configuration axis.

## What Changed and Why

The old schema had two separate systems for routing agents to models and backends:

- **`agentRuntimes`** - a named registry of harness + provider bindings
- **`defaultAgentRuntime`** / per-role `agentRuntime:` - pointers into that registry
- **`agents.models`** - a map of model-class names to model refs
- **`modelClass`** per-role - an indirection through the class map

This two-layer indirection (runtime registry + model class table) made it hard to see what a given agent would actually use. You had to resolve: role → class → model, and separately role → runtime → provider.

The new schema collapses both layers into a single concept: **tier recipes**. A tier (`planning`, `implementation`, `review`, `evaluation`) is a self-contained recipe: `harness + model + effort`, with optional harness-specific sub-blocks (`pi:`, `claudeSdk:`). A role maps to exactly one tier; the tier carries everything else. No runtime registry, no class table.

**Old keys that are no longer valid in `eforge/config.yaml`:**

| Old key | Replacement |
|---------|-------------|
| `backend:` | `agents.tiers.<tier>.harness:` |
| `agentRuntimes:` | `agents.tiers.<tier>` recipe block |
| `defaultAgentRuntime:` | Built-in tier assignment + `agents.roles[role].tier:` overrides |
| `pi:` (top-level) | `agents.tiers.<tier>.pi:` sub-block |
| `claudeSdk:` (top-level) | `agents.tiers.<tier>.claudeSdk:` sub-block |
| `agents.models:` | `agents.tiers.<tier>.model:` |
| `agents.tiers[t].modelClass:` | `agents.tiers.<tier>.model:` directly |
| `agents.roles[r].modelClass:` | `agents.roles[r].tier:` or `agents.roles[r].model:` |
| `agents.roles[r].agentRuntime:` | `agents.roles[r].tier:` |

---

## Pattern 1: Single `agentRuntimes` Entry (Most Common)

The most common old pattern: one runtime entry that sets the harness and provider for all agents, with a global model override.

**Before:**

```yaml
backend: pi
agentRuntimes:
  default:
    harness: pi
    pi:
      provider: openrouter
defaultAgentRuntime: default
agents:
  models:
    max:
      id: anthropic/claude-opus-4-6
    balanced:
      id: anthropic/claude-sonnet-4-6
```

**After:**

Move the harness and provider onto each tier recipe. The `model:` field on each tier takes a plain string (not an object). Map old model classes to the tiers that use them:

```yaml
agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: anthropic/claude-sonnet-4-6
      effort: medium
      pi:
        provider: openrouter
    review:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    evaluation:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
```

Unset tiers fall back to the engine defaults (all `claude-sdk` harness; `claude-opus-4-7` for `planning`/`review`/`evaluation`, `claude-sonnet-4-6` for `implementation`). If your old config used `pi` everywhere, you must list all four tiers - omitting any tier means it reverts to the `claude-sdk` default.

---

## Pattern 2: Multi-Runtime (Named Runtimes with Per-Role Assignment)

The old pattern for routing specific roles to different providers or harnesses.

**Before:**

```yaml
backend: pi
agentRuntimes:
  openrouter:
    harness: pi
    pi:
      provider: openrouter
  google:
    harness: pi
    pi:
      provider: google
defaultAgentRuntime: openrouter
agents:
  models:
    max:
      id: anthropic/claude-opus-4-6
    balanced:
      id: anthropic/claude-sonnet-4-6
  roles:
    staleness-assessor:
      agentRuntime: google
      model:
        id: gemini-flash
```

**After:**

Each named runtime becomes a tier recipe. Per-role `agentRuntime:` overrides become `agents.roles[role].tier:` reassignments (pointing the role to the tier that uses the desired provider). If a role needs a unique model on a different provider, assign it to a tier configured for that provider and optionally add a per-role `model:` override:

```yaml
agents:
  tiers:
    planning:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    implementation:
      harness: pi
      model: anthropic/claude-sonnet-4-6
      effort: medium
      pi:
        provider: openrouter
    review:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: openrouter
    evaluation:
      harness: pi
      model: anthropic/claude-opus-4-6
      effort: high
      pi:
        provider: google    # route evaluation tier to google
  roles:
    staleness-assessor:
      tier: evaluation      # reassign this role to the evaluation tier (google provider)
      model: gemini-flash   # override the model for this role only
```

If you need a completely independent combination not representable by any of the four built-in tiers, use per-role `model:` and keep the tier for the harness/provider, or pick the closest tier and override what you need per-role.

---

## Pattern 3: `agents.models` / `modelClass` Overrides

The old pattern for overriding which model a class maps to, or for moving a role to a cheaper class.

**Before:**

```yaml
backend: claude-sdk
agents:
  models:
    balanced:
      id: claude-sonnet-4-6
    fast:
      id: claude-haiku-4-5
  roles:
    reviewer:
      modelClass: balanced     # moved from 'max' to 'balanced'
    formatter:
      modelClass: fast         # moved from 'max' to 'fast'
    staleness-assessor:
      model:
        id: claude-haiku-4-5  # explicit model ref (old object form)
```

**After:**

Each model class maps directly to a tier's `model:` field. Old per-role `modelClass` overrides become either `agents.roles[role].tier:` reassignments (when the lighter model already lives on a different tier) or per-role `model:` overrides (for any model not represented by a tier). Note that model refs are now plain strings, not objects:

```yaml
agents:
  tiers:
    implementation:
      harness: claude-sdk
      model: claude-sonnet-4-6   # plain string, not { id: ... }
      effort: medium
  roles:
    reviewer:
      tier: implementation       # was modelClass: balanced (sonnet); implementation tier already uses sonnet
    formatter:
      model: claude-haiku-4-5    # was modelClass: fast (haiku); no tier uses haiku, so override per-role
    staleness-assessor:
      model: claude-haiku-4-5    # per-role model override, still in its default tier
```

**Choosing between `tier:` reassignment and per-role `model:` override:**

- Use `tier:` reassignment when the role should inherit all settings from the target tier (harness, effort, provider, etc.), not just the model.
- Use per-role `model:` when you only want a different model but keep the role in its natural tier (e.g. same harness, same effort, same provider).

---

## `defaultAgentRuntime` Is Gone

The `defaultAgentRuntime:` config field (which pointed to the active runtime profile) is no longer a config field. Tier assignment now works like this:

1. **Built-in defaults** - each role has a built-in tier via `AGENT_ROLE_TIERS` (see table in [config.md](config.md))
2. **Per-role override** - `agents.roles[role].tier:` reassigns a single role to any tier
3. **Profile files** - backend profiles at `eforge/profiles/<name>.yaml` (or `~/.config/eforge/profiles/<name>.yaml`) contain `agents.tiers` content that is merged in when the profile is active

The active profile is selected via the `.eforge/.active-profile` marker file (project-local, gitignored), `eforge/.active-profile` (project-scoped), or `~/.config/eforge/.active-profile` (user-scoped). There is no `defaultAgentRuntime:` config field.
