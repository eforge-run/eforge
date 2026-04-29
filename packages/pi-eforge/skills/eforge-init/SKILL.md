---
name: eforge-init
description: Initialize eforge in the current project with an interactive setup flow
disable-model-invocation: true
---

# /eforge:init

<!-- parity-skip-start -->
Initialize eforge in this project. This skill targets the Pi harness exclusively. Presents a two-track setup flow (Quick or Mix-and-match) to assemble a named agent runtime profile (all runtimes use `harness: pi`), then creates it under `eforge/profiles/` and activates it. Also writes `eforge/config.yaml` for team-wide settings (postMergeCommands, etc.) with `agentRuntimes:` and `defaultAgentRuntime:` as top-level keys.
<!-- parity-skip-end -->

## Workflow

### Step 1: Determine postMergeCommands

Inspect the project to figure out the right `postMergeCommands`:

1. Read `package.json` (if it exists) and note which scripts are available (e.g. `install`, `type-check`, `typecheck`, `test`, `build`, `lint`)
2. Detect the package manager from lockfiles: `pnpm-lock.yaml` -> pnpm, `yarn.lock` -> yarn, `package-lock.json` -> npm, `bun.lockb` -> bun
3. Build a suggested command list. Always start with the install command, then add validation scripts in order: type-check, test, build. For example: `["pnpm install", "pnpm type-check", "pnpm test", "pnpm build"]`
4. For non-JS projects: check for `Cargo.toml` (cargo build, cargo test), `go.mod` (go build ./..., go test ./...), `Makefile` (make), etc.
5. If you can't determine commands, use an empty list

If `eforge/config.yaml` already exists, also read its current `build.postMergeCommands` and compare against your analysis. If the existing commands look good, keep them. If your analysis suggests improvements (missing scripts, outdated commands), propose the updated set instead.

Present your suggested commands to the user briefly: "I'd suggest these postMergeCommands based on your project: ..." and ask if they look right. Accept corrections.

<!-- parity-skip-start -->
### Step 1.5: Existing user-scope profiles

Call `eforge_profile { action: "list", scope: "user" }` to check for existing user-scope profiles.

If the response contains no profiles (empty list), skip this step entirely and proceed to Step 2.

If profiles exist, present them to the user:

| Name | Max model |
|------|-----------|
| `<name>` | `<models.max.id>` |

Ask: "Would you like to use one of these existing user-scope profiles, or create a new project profile?"

**On pick (existing profile):**

Call `eforge_init` with:

```json
{
  "existingProfile": { "name": "<chosen>", "scope": "user" },
  "postMergeCommands": [...]
}
```

Include `force: true` if `$ARGUMENTS` contains `--force` or `force`.

Skip Steps 2–6. Proceed directly to the result message:

> eforge initialized with user-scope profile `<name>` activated. The profile lives at `~/.config/eforge/profiles/<name>.yaml`. `eforge/config.yaml` was written with the agreed postMergeCommands.

**On "create new project profile":** Fall through to Step 2.

### Step 2: Setup mode

The harness is always `pi` in this flow. Ask the user: "Quick setup (one provider and model used for every tier) or mix-and-match (pick a different provider/model per tier)?"

Do not suggest a default - both options should be presented equally.

### Step 3a: Quick path

When the user chooses Quick setup:

1. **Provider**: Call `eforge_models` with `{ action: "providers", harness: "pi" }` to get available providers. Present the list and ask the user to pick one.
2. **Max model**: Call `eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }` to get available models (sorted newest-first). Show the top 10 and ask the user to pick.
3. **Balanced model**: Prompt:
   > Pick a separate **balanced**-tier model? (Recommended — most build steps run at the balanced tier, so a cheaper/smaller model here saves a lot. Press enter to reuse `<max-id>`.)
   Show the same top-10 list with the user's max pick highlighted as the default. If the user accepts the default, set `balanced.id = max.id`.
4. **Fast model**: No prompt. Set `fast.id = balanced.id`.

Assemble the single-runtime profile (runtime named `pi-<provider>`, no `tiers` block):

```yaml
profile:
  agentRuntimes:
    pi-anthropic:                # use pi-<chosen provider>
      harness: pi
      pi:
        provider: anthropic      # the chosen provider
  defaultAgentRuntime: pi-anthropic
  models:
    max:
      id: <picked>
    balanced:
      id: <picked-or-max>
    fast:
      id: <balanced>
```

### Step 3b: Mix-and-match path

When the user chooses Mix-and-match, walk tiers `max -> balanced -> fast`:

For each tier:
- **Provider**: Ask which provider to use. Default = previous tier's provider (max tier has no default). Call `eforge_models` with `{ action: "providers", harness: "pi" }` for the list.
- **Model**: Ask which model. Default = previous tier's model when the provider is unchanged. Call `eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }` and show the top 10 newest-first.

After collecting all three tiers, deduplicate runtimes by provider. Name each runtime `pi-<provider>`. Assign each tier to its runtime via `agents.tiers.<tier>.agentRuntime`. Set `defaultAgentRuntime` to the runtime backing the `max` tier.

Assembled profile shape example:

```yaml
profile:
  agentRuntimes:
    pi-anthropic:
      harness: pi
      pi:
        provider: anthropic
    pi-openrouter:
      harness: pi
      pi:
        provider: openrouter
  defaultAgentRuntime: pi-anthropic
  models:
    max:
      id: claude-opus-4-7
    balanced:
      id: claude-opus-4-7
    fast:
      id: mistral-large
  tiers:
    max:
      agentRuntime: pi-anthropic
    balanced:
      agentRuntime: pi-anthropic
    fast:
      agentRuntime: pi-openrouter
```

### Step 4: Profile name

Derive a candidate profile name from the assembled profile using these rules (mirrors the server-side `deriveProfileName` helper):

- **Single runtime, same model id across all three tiers**: use the sanitized model ID. Sanitize by lowercasing, replacing `.` with `-`, stripping a leading `claude-` prefix, and collapsing repeated dashes. Example: `claude-opus-4-7` → `opus-4-7`.
- **Single runtime, model varies across tiers**: use `<harness>-<provider>` (e.g. `pi-anthropic`).
- **Multiple runtimes**: use `mixed-<runtime-backing-max>` where the backing runtime is from `tiers.max.agentRuntime` (e.g. `mixed-pi-anthropic`).

> Note: For the Pi Quick path, expect the candidate name to be the sanitized max model id when all tiers share the same model, or `pi-<provider>` when tiers differ. (For reference, the Claude SDK Quick path in the plugin skill typically lands on `claude-sdk`, since each tier picks a different family by default.)

Show the candidate name to the user: "I'd name this profile `<candidate>`. Does that work, or would you like a different name?" Accept a one-word override (alphanumeric + dashes). If the user accepts, proceed with the candidate. Set `profile.name` to the final name before calling the tool.

### Step 5: Persist

Call `eforge_init` with:

```json
{
  "profile": {
    "name": "<finalName>",
    "agentRuntimes": { ... },
    "defaultAgentRuntime": "...",
    "models": { ... },
    "tiers": { ... }
  },
  "postMergeCommands": [...],
  "force": true
}
```

Include `force: true` if `$ARGUMENTS` contains `--force` or `force`. Include `tiers` only in the mix-and-match path. Omit `tiers` on the Quick path.

### Step 6: Migrate (`--migrate`)

If `$ARGUMENTS` contains `--migrate`, skip Steps 2-5 above. Instead call `eforge_init` with `{ migrate: true }`. This extracts the legacy `backend:`/`pi:`/`agents.*` fields from the existing `config.yaml` into a named profile, activates it, and strips those fields from `config.yaml`.

<!-- parity-skip-end -->

The tool will create the profile under `eforge/profiles/`, activate it via `eforge/.active-profile`, and write `eforge/config.yaml` with `agentRuntimes:` and `defaultAgentRuntime:` as top-level keys alongside other team-wide settings.

### Step 7: Report

Once the tool completes successfully, inform the user:

> eforge initialized with profile `<profileName>`. The profile lives at `eforge/profiles/<profileName>.yaml` and is now active. You can customize further with `/eforge:config --edit`, switch profiles with `/eforge:profile`, or create additional profiles with `/eforge:profile-new`. Use `/eforge:profile-new --scope user` to create a user-scope profile under `~/.config/eforge/profiles/` that applies across all your projects.

## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Build | `eforge_build` | User wants to enqueue work for the daemon to build |
| Config | `eforge_config` | User wants to view, edit, or validate the eforge config |
| Profile | `eforge_profile` | User wants to inspect or switch agent runtime profiles |
| Profile (new) | `/eforge:profile-new` | User wants to create a personal agent runtime profile |
| Plan | `eforge_plan` | User wants to plan changes before building |
| Status | `eforge_status` | User wants to check build progress or queue state |
| Restart | `eforge_restart` | User wants to restart the eforge daemon |
| Update | `eforge_update` | User wants to check for or install eforge updates |
