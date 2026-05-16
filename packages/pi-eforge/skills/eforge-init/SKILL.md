---
name: eforge-init
description: Initialize eforge in the current project with an interactive setup flow
disable-model-invocation: true
---

# /eforge:init

<!-- parity-skip-start -->
Initialize eforge in this project. This setup configures an agent runtime profile and post-merge validation commands. You can use an existing local- or user-scope profile from any supported harness, or create a new project profile. When creating a new profile from this flow, the generated profile uses the Pi harness for all tiers, then creates it under `eforge/profiles/` and activates it. Also writes `eforge/config.yaml` for team-wide settings (postMergeCommands, etc.).
<!-- parity-skip-end -->

## Welcome

Before starting Step 1, print this welcome message to the user verbatim:

> Welcome to eforge — an agentic build system that turns plans into code. You stay close to the code (planning, decisions) while eforge implements, blind-reviews, and validates in the background.
>
> This setup configures your agent runtime profile and post-merge validation commands.

Then proceed to Step 1.

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
### Step 1.5: Existing local- and user-scope profiles

Call `eforge_profile { action: "list", scope: "local" }` and `eforge_profile { action: "list", scope: "user" }` to check for existing profiles outside the project tier.

If both responses contain no profiles (both lists empty), skip this step entirely and proceed to Step 2.

If any profiles exist, present them in a combined table:

| Name | Scope | Harness | Planning model |
|------|-------|---------|----------------|
| `<name>` | `local` | `<agents.tiers.planning.harness>` | `<agents.tiers.planning.model>` |
| `<name>` | `user`  | `<agents.tiers.planning.harness>` | `<agents.tiers.planning.model>` |

Ask: "Would you like to use one of these existing profiles, or create a new project profile?" If the chosen profile uses `claude-sdk`, mention that it is supported but optional and Anthropic-specific. Starting June 15, 2026, Anthropic says Claude Agent SDK and `claude -p` usage no longer count toward Claude plan limits; eligible plans may receive a separate monthly Agent SDK credit, usage beyond that credit is billed at standard API rates when extra usage is enabled, otherwise requests stop, and API-key users remain pay-as-you-go.

**On pick (existing profile):**

Call `eforge_init` with:

```json
{
  "existingProfile": { "name": "<chosen>", "scope": "<local|user>" },
  "postMergeCommands": [...]
}
```

Include `force: true` if `$ARGUMENTS` contains `--force` or `force`.

Skip Steps 2–6. Proceed directly to the result message.

- For a **local**-scope pick:
  > eforge initialized with local-scope profile `<name>` activated. The profile lives at `.eforge/profiles/<name>.yaml`. `eforge/config.yaml` was written with the agreed postMergeCommands.
- For a **user**-scope pick:
  > eforge initialized with user-scope profile `<name>` activated. The profile lives at `~/.config/eforge/profiles/<name>.yaml`. `eforge/config.yaml` was written with the agreed postMergeCommands.

**On "create new project profile":** Fall through to Step 2.

### Step 2: Setup mode

When creating a new project profile in this flow, the harness is always `pi`. Ask the user: "Quick setup (one provider and suggested tier models, including an optional separate implementation model) or mix-and-match (pick a different provider/model/effort per tier)?"

Pi is the recommended execution harness for new eforge setup. Existing local- or user-scope `claude-sdk` profiles remain supported; if the user selects one, mention that it is Anthropic-specific and follows the Agent SDK credit/API-pricing caveat above.

### Step 3a: Quick path

When the user chooses Quick setup:

1. **Provider**: Call `eforge_models` with `{ action: "providers", harness: "pi" }` to get available providers. Present the list and ask the user to pick one.
2. **Planning/review/evaluation model**: Call `eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }` to get available models (sorted newest-first). Show the top 10 and ask the user to pick.
3. **Implementation model**: Prompt:
   > Pick a separate **implementation**-tier model? (Recommended — most build steps run at the implementation tier, so a cheaper/smaller model here saves a lot. Press enter to reuse `<planning-id>`.)
   Show the same top-10 list with the user's planning pick highlighted as the default. If the user accepts the default, set `implementation.model = planning.model`.
4. Assemble the single-provider profile (same provider for all tiers):

```yaml
profile:
  agents:
    tiers:
      planning:
        harness: pi
        model: <picked>
        effort: high
        pi:
          provider: <chosen>
      implementation:
        harness: pi
        model: <picked-or-planning>
        effort: medium
        pi:
          provider: <chosen>
      review:
        harness: pi
        model: <picked>
        effort: high
        pi:
          provider: <chosen>
      evaluation:
        harness: pi
        model: <picked>
        effort: high
        pi:
          provider: <chosen>
```

### Step 3b: Mix-and-match path

When the user chooses Mix-and-match, walk tiers `planning -> implementation -> review -> evaluation`:

For each tier:
- **Provider**: Ask which provider to use. Default = previous tier's provider. Call `eforge_models` with `{ action: "providers", harness: "pi" }` for the list.
- **Model**: Ask which model. Default = previous tier's model when provider is unchanged. Call `eforge_models` with `{ action: "list", harness: "pi", provider: "<chosen>" }` and show the top 10 newest-first.
- **Effort**: Ask from `low | medium | high | xhigh | max`. Default: `high` for planning/review/evaluation, `medium` for implementation.

Assembled profile shape:

```yaml
profile:
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
        model: qwen3-coder
        effort: medium
        pi:
          provider: local
      review:
        harness: pi
        model: anthropic/claude-opus-4-6
        effort: high
        pi:
          provider: openrouter
      evaluation:
        harness: pi
        model: gemini-flash
        effort: high
        pi:
          provider: google
```

### Step 4: Profile name

Derive a candidate profile name from the assembled profile using these rules (mirrors the server-side `deriveProfileName` helper):

- **Same provider+model across all four tiers**: use the sanitized model ID. Sanitize by lowercasing, replacing `.` with `-`, stripping a leading `claude-` prefix, and collapsing repeated dashes. Example: `claude-opus-4-7` → `opus-4-7`.
- **Same provider, model varies across tiers**: use `pi-<provider>` (e.g. `pi-openrouter`).
- **Multiple providers**: use `mixed-<planning-tier-provider>` (e.g. `mixed-openrouter`).

Show the candidate name to the user: "I'd name this profile `<candidate>`. Does that work, or would you like a different name?" Accept a one-word override (alphanumeric + dashes). If the user accepts, proceed with the candidate. Set `profile.name` to the final name before calling the tool.

### Step 5: Persist

Call `eforge_init` with:

```json
{
  "profile": {
    "name": "<finalName>",
    "agents": {
      "tiers": {
        "planning":       { "harness": "...", "model": "...", "effort": "...", "pi": { "provider": "..." } },
        "implementation": { "harness": "...", "model": "...", "effort": "...", "pi": { "provider": "..." } },
        "review":         { "harness": "...", "model": "...", "effort": "...", "pi": { "provider": "..." } },
        "evaluation":     { "harness": "...", "model": "...", "effort": "...", "pi": { "provider": "..." } }
      }
    }
  },
  "postMergeCommands": [...],
  "force": true
}
```

Include `force: true` if `$ARGUMENTS` contains `--force` or `force`. Include `pi: { "provider": "..." }` on every tier entry.

### Step 6: Migrate (`--migrate`)

If `$ARGUMENTS` contains `--migrate`, skip Steps 2-5 above. Instead call `eforge_init` with `{ migrate: true }`. This extracts the legacy `backend:`/`pi:`/`agents.*` fields from the existing `config.yaml` into a named profile, activates it, and strips those fields from `config.yaml`.

<!-- parity-skip-end -->

For a newly created project profile, the tool will create the profile under `eforge/profiles/`, activate it via `eforge/.active-profile`, and write `eforge/config.yaml` alongside other team-wide settings.

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
