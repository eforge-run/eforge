---
description: Initialize eforge in the current project with an interactive setup form
argument-hint: "[--force] [--migrate]"
---

# /eforge:init

<!-- parity-skip-start -->
Initialize eforge in this project. Presents a two-track setup flow (Quick or Mix-and-match) to assemble a named agent runtime profile, then creates it under `eforge/profiles/` and activates it. Also writes `eforge/config.yaml` for team-wide settings (postMergeCommands, etc.) with `agentRuntimes:` and `defaultAgentRuntime:` as top-level keys.
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

Call `mcp__eforge__eforge_profile { action: "list", scope: "user" }` to check for existing user-scope profiles.

If the response contains no profiles (empty list), skip this step entirely and proceed to Step 2.

If profiles exist, present them to the user:

| Name | Harness | Max model |
|------|---------|-----------|
| `<name>` | `<agentRuntimes[defaultAgentRuntime].harness>` | `<models.max.id>` |

Ask: "Would you like to use one of these existing user-scope profiles, or create a new project profile?"

**On pick (existing profile):**

Call `mcp__eforge__eforge_init` with:

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

Ask the user: "Quick setup (one harness, one model used for every tier) or mix-and-match (pick a different harness/provider/model per tier)?"

Do not suggest a default - both options should be presented equally.

### Step 3a: Quick path

When the user chooses Quick setup:

1. **Harness**: Ask the user to choose between `claude-sdk` (Claude Code's built-in SDK) or `pi` (multi-provider via Pi SDK). No default - user must pick.

**If harness = `claude-sdk`:**

2. Call `mcp__eforge__eforge_models` with `{ action: "list", harness: "claude-sdk" }` to get available models (sorted newest-first, already harness-filtered).
3. From the returned list, derive tier defaults by scanning for the first non-deprecated entry whose `id` contains, case-insensitively:
   - `opus` → default for `max` tier
   - `sonnet` → default for `balanced` tier
   - `haiku` → default for `fast` tier
4. Present the three picks as a recommendation, e.g.:
   > Claude Code ships three model families. Latest of each:
   > - **max**: `claude-opus-4-7` (Opus — deepest reasoning)
   > - **balanced**: `claude-sonnet-4-6` (Sonnet — strong default)
   > - **fast**: `claude-haiku-4-5` (Haiku — cheapest, quickest)
   >
   > Use these, or customize a tier?
5. Accept one of: `confirm`, `customize <tier>`, `customize all`. For each tier the user wants to customize, show the top 10 from the already-fetched list (no extra `mcp__eforge__eforge_models` call) and let them pick a different id. The default at each per-tier prompt is the family-derived suggestion.
6. Assemble the single-runtime profile (no `tiers` block):

```yaml
profile:
  agentRuntimes:
    main:
      harness: claude-sdk
  defaultAgentRuntime: main
  models:
    max:
      id: <picked>
    balanced:
      id: <picked>
    fast:
      id: <picked>
```

**If harness = `pi`:**

2. **Provider**: Call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }` to get available providers. Present the list and ask the user to pick one.
3. **Max model**: Call `mcp__eforge__eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }` to get available models (sorted newest-first). Show the top 10 and ask the user to pick.
4. **Balanced model**: Prompt:
   > Pick a separate **balanced**-tier model? (Recommended — most build steps run at the balanced tier, so a cheaper/smaller model here saves a lot. Press enter to reuse `<max-id>`.)
   Show the same top-10 list with the user's max pick highlighted as the default. If the user accepts the default, set `balanced.id = max.id`.
5. **Fast model**: No prompt. Set `fast.id = balanced.id`.
6. Assemble the single-runtime profile (runtime named `main`, no `tiers` block):

```yaml
profile:
  agentRuntimes:
    main:
      harness: pi
      pi:
        provider: <chosen>
  defaultAgentRuntime: main
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
- **Harness**: Ask which harness to use. Default = previous tier's harness (max tier has no default).
- **Provider** (pi harness only): Ask which provider. Default = previous tier's provider when the same harness is used. Call `mcp__eforge__eforge_models` with `{ action: "providers", harness: "pi" }` for the list.
- **Model**: Ask which model. Default = previous tier's model when harness+provider are unchanged. Call `mcp__eforge__eforge_models` with `{ action: "list", harness: "<chosen>", provider: "<chosen if pi>" }` and show the top 10 newest-first.

After collecting all three tiers, deduplicate runtimes by `(harness, provider)` tuple:
- A `claude-sdk` entry → runtime named `claude-sdk`.
- A `pi` entry with provider `anthropic` → runtime named `pi-anthropic`. Multiple Pi providers get `pi-<provider>` names.

Assign each tier to its runtime via `agents.tiers.<tier>.agentRuntime`. Set `defaultAgentRuntime` to the runtime backing the `max` tier.

Assembled profile shape:

```yaml
profile:
  agentRuntimes:
    claude-sdk:
      harness: claude-sdk
    pi-anthropic:
      harness: pi
      pi:
        provider: anthropic
  defaultAgentRuntime: claude-sdk     # runtime for max tier
  models:
    max:
      id: claude-opus-4-7
    balanced:
      id: claude-opus-4-7
    fast:
      id: claude-haiku-4-5
  tiers:
    max:
      agentRuntime: claude-sdk
    balanced:
      agentRuntime: claude-sdk
    fast:
      agentRuntime: pi-anthropic
```

### Step 4: Profile name

Derive a candidate profile name from the assembled profile using these rules (mirrors the server-side `deriveProfileName` helper):

- **Single runtime, same model id across all three tiers**: use the sanitized model ID. Sanitize by lowercasing, replacing `.` with `-`, stripping a leading `claude-` prefix, and collapsing repeated dashes. Example: `claude-opus-4-7` → `opus-4-7`.
- **Single runtime, model varies across tiers**: use `<harness>` or `<harness>-<provider>` (e.g. `pi-anthropic`).
- **Multiple runtimes**: use `mixed-<runtime-backing-max>` where the backing runtime is from `tiers.max.agentRuntime` (e.g. `mixed-claude-sdk`).

Show the candidate name to the user: "I'd name this profile `<candidate>`. Does that work, or would you like a different name?" Accept a one-word override (alphanumeric + dashes). If the user accepts, proceed with the candidate. Set `profile.name` to the final name before calling the tool.

Note: the Claude SDK Quick path will typically land on the candidate name `claude-sdk` because each tier picks a different model family by default (single runtime, model varies across tiers).

### Step 5: Persist

Call `mcp__eforge__eforge_init` with:

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

If `$ARGUMENTS` contains `--migrate`, skip Steps 2-5 above. Instead call `mcp__eforge__eforge_init` with `{ migrate: true }`. This extracts the legacy `backend:`/`pi:`/`agents.*` fields from the existing `config.yaml` into a named profile, activates it, and strips those fields from `config.yaml`.

<!-- parity-skip-end -->

The tool will create the profile under `eforge/profiles/`, activate it via `eforge/.active-profile`, and write `eforge/config.yaml` with `agentRuntimes:` and `defaultAgentRuntime:` as top-level keys alongside other team-wide settings.

### Step 7: Report

Once the tool completes successfully, inform the user:

> eforge initialized with profile `<profileName>`. The profile lives at `eforge/profiles/<profileName>.yaml` and is now active. You can customize further with `/eforge:config --edit`, switch profiles with `/eforge:profile`, or create additional profiles with `/eforge:profile-new`. Use `/eforge:profile-new --scope user` to create a user-scope profile under `~/.config/eforge/profiles/` that applies across all your projects.

<!-- parity-skip-start -->
To mix multiple harnesses across agent roles (e.g. `claude-sdk` planners + `pi` builders), use `/eforge:profile-new` or edit `eforge/profiles/<profileName>.yaml` directly - `agentRuntimes` accepts multiple named entries.
<!-- parity-skip-end -->
## Related Skills

| Skill | Command | When to suggest |
|-------|---------|----------------|
| Build | `/eforge:build` | User wants to enqueue work for the daemon to build |
| Config | `/eforge:config` | User wants to view, edit, or validate the eforge config |
| Profile | `/eforge:profile` | User wants to inspect or switch agent runtime profiles |
| Profile (new) | `/eforge:profile-new` | User wants to create a personal agent runtime profile |
| Plan | `/eforge:plan` | User wants to plan changes before building |
| Status | `/eforge:status` | User wants to check build progress or queue state |
| Restart | `/eforge:restart` | User wants to restart the eforge daemon |
| Update | `/eforge:update` | User wants to check for or install eforge updates |
