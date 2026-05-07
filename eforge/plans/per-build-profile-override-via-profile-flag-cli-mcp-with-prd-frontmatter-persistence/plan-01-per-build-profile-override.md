---
id: plan-01-per-build-profile-override
name: Per-build profile override via --profile flag (CLI + MCP) with
  PRD-frontmatter persistence
branch: per-build-profile-override-via-profile-flag-cli-mcp-with-prd-frontmatter-persistence/plan-01-per-build-profile-override
---

# Per-build profile override via --profile flag (CLI + MCP) with PRD-frontmatter persistence

## Architecture Context

Today the daemon binds one active profile per lifetime by reading `.active-profile` markers (precedence: `.eforge/.active-profile` -> `eforge/.active-profile` -> `~/.config/eforge/.active-profile`). Every subprocess (daemon, enqueue worker, build worker) calls `loadConfig(cwd)` independently; there is no shared in-memory profile state. The override only needs to flow through one durable hop (PRD frontmatter) and two transient ones (HTTP body -> enqueue argv; PRD file -> queue-exec argv). PRD files in `.eforge/queue/*.md` are the only durable queue artifact, so the override has to live in their frontmatter to survive daemon restarts.

Key verified anchors:
- `loadConfig` / `resolveActiveProfileName` / `loadProfile`: `packages/engine/src/config.ts:820`, `:1161`, `:1233`. The marker-resolution block at lines 877-893 is self-contained; `profileConfig` is consumed at the merge on `:897`.
- `ActiveProfileSource` union: `packages/engine/src/config.ts:917`.
- `EforgeEngine.create` / `spawnPrdChild`: `packages/engine/src/eforge.ts:177`, `:1038`.
- `session:profile` event: `packages/client/src/events.schemas.ts:481-487` (current `source` enum: `'local' | 'project' | 'user-local' | 'missing' | 'none'`).
- `EnqueueRequest`: `packages/client/src/routes.ts:7-10`.
- `DAEMON_API_VERSION`: `packages/client/src/api-version.ts:17`.
- Daemon `/api/enqueue`: `packages/monitor/src/server.ts:1208` (POST handler, spawns `enqueue` worker via `workerTracker.spawnWorker`).
- CLI `enqueue` / `queue exec`: `packages/eforge/src/cli/index.ts:135` and `:387`.
- PRD frontmatter schema/parser/writer: `packages/engine/src/prd-queue.ts:27`, `:60`, `:590`.
- CC plugin MCP `eforge_build`: `packages/eforge/src/cli/mcp-proxy.ts` (the `name: 'eforge_build'` block — schema is currently `{ source: z.string() }`).
- Pi `eforge_build` tool + `/eforge:build` command: `packages/pi-eforge/extensions/eforge/index.ts:355` (tool) and `:2069-2073` (currently a thin alias delegating to the `eforge-build` skill).
- `showSearchableSelectOverlay` and `showSelectOverlay`: `packages/pi-eforge/extensions/eforge/ui-helpers.ts:35,77`. Reference profile-picker pattern: `profile-commands.ts:72-111`.
- Plugin version: `eforge-plugin/.claude-plugin/plugin.json`.

Profiles already on disk (verified during planner exploration via `eforge/profiles/`): `claude-sdk-4-7`, `pi-codex-5-5`, `pi-local`. Tests can rely on at least `pi-local` existing.

## Implementation

### Overview

Thread an optional profile name from CLI/MCP -> daemon HTTP body -> enqueue worker argv -> PRD frontmatter (durable) -> scheduler -> queue-exec argv -> `EforgeEngine.create({ profileOverride })` -> `loadConfig(cwd, { profileOverride })`. When the override is set, `loadConfig` short-circuits the marker chain and calls `loadProfile` directly; on miss it throws. The daemon HTTP route validates the profile via `loadProfile` before spawning the enqueue worker (returns HTTP 400 on miss); the scheduler pre-flights the PRD's `frontmatter.profile` via `loadProfile` in `spawnPrdChild` before spawning the queue-exec worker (PRD moves to `failed/` on miss with a structured `plan:error:set`). Worker startup wraps engine construction in try/catch as defense-in-depth for the rare delete-between-enqueue-and-build race.

### Key Decisions

1. **Override is a profile name, not an inline tier blob.** Profiles are already file-backed and validated; inlining would create a parallel config surface.
2. **Persist in PRD frontmatter, not a sidecar or DB column.** PRD is the only durable queue artifact and the scheduler needs the override before any run row exists.
3. **Override resolution bypasses the marker chain entirely.** No fallback when override is set — fallback would mask user intent and quietly burn frontier tokens on a build the user wanted local.
4. **Add `'override'` to `ActiveProfileSource` (a new enum value, not a separate boolean).** Triggers compile errors at every exhaustive switch (a feature).
5. **Both enqueue and build subprocesses honor the override.** Otherwise the formatter + dep-detector still burn frontier tokens at enqueue.
6. **Validate at enqueue (HTTP 400), not only at build start.** Catches typos before any PRD lands in the queue.
7. **Pi `/eforge:build` becomes a picker; `eforge_build` tool stays a string parameter.** Matches the existing convention (interactive command vs. programmatic tool) seen in `profile-commands.ts`.
8. **No merging of override and marker-resolved profile.** Hybrids must be expressed as a new explicit profile file.
9. **No backward-compat shim.** Field is optional; old PRDs without it work unchanged. Bump `DAEMON_API_VERSION` because the `session:profile` event's `source` enum widens (existing-field type change per the api-version.ts policy).
10. **Build-time profile-load failure: hard-fail with a structured error.** Two layers — pre-flight in `spawnPrdChild` (primary), worker startup catch in `queue exec` (defense-in-depth). No auto-fallback. No auto-mutation of the user's PRD. Recovery is manual.

## Scope

### In Scope
- `EnqueueRequest.profile?: string` on the wire (`packages/client/src/routes.ts`).
- `'override'` added to `session:profile` event `source` enum in `packages/client/src/events.schemas.ts` AND to `ActiveProfileSource` in `packages/engine/src/config.ts`.
- `DAEMON_API_VERSION` bump with a one-line `// vN: ...` description prepended to the existing comment.
- `loadConfig(cwd?, options?: { profileOverride?: string })` — when `profileOverride` is set, skip `resolveActiveProfileName`, call `loadProfile(configDir, name, projectRoot)` directly, set `source: 'override'`. On miss, throw a descriptive `Error` whose message names the missing profile and the scopes searched.
- `EforgeEngineOptions.profileOverride?: string`; `EforgeEngine.create` forwards it to `loadConfig`.
- `prdFrontmatterSchema` adds `profile: z.string().optional()` (`packages/engine/src/prd-queue.ts`).
- `EnqueuePrdOptions.profile?: string`; `enqueuePrd` writer serializes `profile: <name>` when set (single-line YAML key, no quoting needed for the validated profile names).
- `EforgeEngine.enqueue(source, options)` accepts `profile?: string` in `EnqueueOptions` and plumbs it to `enqueuePrd`.
- `spawnPrdChild` (`packages/engine/src/eforge.ts:1038`) — pre-flight: when `prd.frontmatter.profile` is set, call `loadProfile(configDir, name, projectRoot)`; on miss, emit `plan:status:change -> failed` and `plan:error:set` (via `mutateState`), move PRD to `failed/`, do not spawn worker; on hit, append `--profile <name>` to the queue-exec argv.
- CLI `eforge enqueue` (`packages/eforge/src/cli/index.ts:135`) — `.option('--profile <name>')`; pass `{ profileOverride }` to `EforgeEngine.create()` and `{ profile }` to `engine.enqueue()`.
- CLI `eforge queue exec` (`packages/eforge/src/cli/index.ts:387`) — `.option('--profile <name>')`; pass `{ profileOverride }` to `EforgeEngine.create()`. Wrap `EforgeEngine.create()` in try/catch — on failure (e.g. profile load error), write a structured error to stderr and exit non-zero (defense-in-depth for the race).
- Daemon `POST /api/enqueue` (`packages/monitor/src/server.ts:1208`) — parse `body.profile`; when set, call `loadProfile(configDir, name, projectRoot)` against the daemon's `cwd`. On miss, return 400 with message `"Profile '<name>' not found"`. On hit, append `'--profile', name` to the enqueue worker's argv.
- CC plugin MCP `eforge_build` (`packages/eforge/src/cli/mcp-proxy.ts`) — schema gains `profile: z.string().optional().describe(...)`; handler forwards `profile` in the daemon request body when set.
- Pi `eforge_build` tool (`packages/pi-eforge/extensions/eforge/index.ts:355`) — TypeBox schema gains `profile: Type.Optional(Type.String({ description: ... }))`; forwards in the daemon request body when set.
- Pi `/eforge:build` native command (`packages/pi-eforge/extensions/eforge/index.ts` near line 2070) — replace the alias-only `skillCommands` entry. New behavior: when `ctx.hasUI`, fetch `${API_ROUTES.profileList}?scope=all`, render `showSearchableSelectOverlay()` items mirroring `profile-commands.ts:88-101` plus a synthetic top entry `{ value: '__no_override__', label: 'Use active profile (no override)', description: 'Run on the daemon\'s currently bound profile' }`. After selection, call `pi.sendUserMessage('/skill:eforge-build [args]')` annotated with the picked profile (passed through to the skill via the existing arg-forwarding mechanism). When `!ctx.hasUI` (headless), preserve current alias behavior — pass `args` through unchanged so users can pass `--profile <name>` inline.
- `eforge-plugin/.claude-plugin/plugin.json` — bump version (per AGENTS.md).
- Vitest coverage (see Verification).

### Out of Scope
- Monitor UI enqueue-form dropdown.
- Mid-build profile switching.
- Profile merging/inheritance.
- Scheduler/parallelism changes (default `maxConcurrentBuilds: 2` already supports two concurrent profile-different builds).
- Profile creation UX (already covered by `/eforge:profile:new`).
- `runs` DB column.

## Files

### Create
- `test/per-build-profile-override.test.ts` — new vitest suite covering the verification list. Group all per-build-profile-override tests here (matches the "group by logical unit, not source file" convention from AGENTS.md).

### Modify
- `packages/client/src/routes.ts` — add `profile?: string` to `EnqueueRequest`.
- `packages/client/src/events.schemas.ts` (lines 481-487) — extend `session:profile` `source` enum with `'override'`.
- `packages/client/src/api-version.ts` — bump `DAEMON_API_VERSION` and prepend a one-line `// v<N+1>: per-build profile override (EnqueueRequest.profile, session:profile source 'override')` to the existing comment block.
- `packages/engine/src/config.ts` — `loadConfig` signature becomes `loadConfig(cwd?: string, options?: { profileOverride?: string })`; short-circuit marker resolution and call `loadProfile` directly when override is set (set `resolvedProfileSource = 'override'`, populate `resolvedProfileScope` from the loadProfile result). On miss, throw `Error` with message `\`Profile override '<name>' not found in any scope (searched: project-local <.eforge/profiles/>, project-team <eforge/profiles/>, user <~/.config/eforge/profiles/>)\``. Add `'override'` to `ActiveProfileSource` union (line 917).
- `packages/engine/src/eforge.ts` — `EforgeEngineOptions.profileOverride?: string` (in the options type definition near top of file); `EforgeEngine.create` passes `{ profileOverride: options.profileOverride }` to `loadConfig`. Add `profile?: string` to `EnqueueOptions`; `engine.enqueue` plumbs it to `enqueuePrd`. In `spawnPrdChild` (line 1038): before constructing argv, if `prd.frontmatter.profile` is set, call `loadProfile(configDir, name, projectRoot)`; on miss, mutate state via `mutateState(state, { type: 'plan:status:change', planId: prd.id, status: 'failed', ...})` then `mutateState(state, { type: 'plan:error:set', planId: prd.id, message: <descriptive> })`, move PRD to `failed/` (existing helper), resolve `'failed'` without spawning. On hit, append `'--profile', name` to argv. Note: `spawnPrdChild` already has parsed `prd.frontmatter` in scope.
- `packages/engine/src/prd-queue.ts` — `prdFrontmatterSchema` (line 27) gains `profile: z.string().optional()`. `EnqueuePrdOptions` (line ~539) gains `profile?: string`. `enqueuePrd` writer (line 590) serializes `profile: <name>` into `fmLines` when set. The line-based `parseFrontmatter` (line 60) already accepts new keys — no parser change needed.
- `packages/eforge/src/cli/index.ts` — `enqueue` command (line 135): `.option('--profile <name>', 'Override active profile for this enqueue + build')`; pass `{ profileOverride: options.profile }` to `EforgeEngine.create()` and `{ profile: options.profile }` to `engine.enqueue()`. `queue exec` command (line 387): `.option('--profile <name>', 'Override active profile for this build')`; pass `{ profileOverride: options.profile }` to `EforgeEngine.create()`. Wrap `EforgeEngine.create()` in try/catch — on throw, `console.error(chalk.red(...))` with the error message and `process.exit(QueueExecExitCode.Failed)` (or whichever non-zero code the existing exit-code contract reserves for pre-init failures; reuse the existing failure code rather than inventing one).
- `packages/monitor/src/server.ts` — `POST /api/enqueue` handler (line 1208): after parsing body, when `body.profile` is a non-empty string, validate via `loadProfile(configDir, name, projectRoot)` against the daemon's `cwd` (use `getConfigDir(cwd)` or compute the equivalent — match the existing pattern used elsewhere in this file for config-dir lookup). On miss, `sendJsonError(res, 400, \`Profile '<name>' not found\`)`. On hit, push `'--profile', body.profile` onto `args` before the `workerTracker.spawnWorker('enqueue', args, ...)` call.
- `packages/eforge/src/cli/mcp-proxy.ts` — `eforge_build` tool: extend `schema` with `profile: z.string().optional().describe('Run this build on the named profile instead of the active profile')`; handler forwards `profile` in the POST body to `API_ROUTES.enqueue` when set.
- `packages/pi-eforge/extensions/eforge/index.ts` — `eforge_build` tool (line 355): TypeBox parameters gain `profile: Type.Optional(Type.String({ description: 'Run this build on the named profile instead of the active profile' }))`; handler forwards `profile` in the daemon request body when set. `/eforge:build` native command (replace the entry in the `skillCommands` loop near line 2069 with a native `pi.registerCommand('eforge:build', { ... })`): when `ctx.hasUI`, fetch profiles via `daemonRequest<ProfileListData>(ctx.cwd, 'GET', \`${API_ROUTES.profileList}?scope=all\`)`, build select items mirroring `profile-commands.ts:88-101` and prepend `{ value: '__no_override__', label: 'Use active profile (no override)', description: 'Run on the daemon\'s currently bound profile' }`. Render with `showSearchableSelectOverlay`. After selection, build the message: when `__no_override__` selected, send `/skill:eforge-build` (preserving original args verbatim); otherwise send `/skill:eforge-build --profile <name>` (appending to original args). When `!ctx.hasUI`, preserve the previous alias behavior (no picker, args pass through). Place new logic before the `skillCommands` loop and remove the `eforge:build` entry from the array so it isn't double-registered.
- `eforge-plugin/.claude-plugin/plugin.json` — bump `version` (per AGENTS.md "Always bump the plugin version" rule).

## Verification

The verify perspective should confirm each criterion below corresponds to a concrete implementation site and a passing test. The code perspective should review correctness of the engine/CLI/MCP/daemon plumbing.

- [ ] `eforge enqueue ./prd.md --profile pi-local` writes `profile: pi-local` to the PRD frontmatter under `.eforge/queue/`. Tested by invoking `engine.enqueue(source, { profile: 'pi-local' })` against a tmpdir with a stub formatter+dep-detector via `agentRuntimes` injection, then reading the resulting file and asserting `parseFrontmatter` returns `{ ..., profile: 'pi-local' }`.
- [ ] When the scheduler's `spawnPrdChild` picks up a PRD whose frontmatter has `profile: pi-local`, it appends `'--profile', 'pi-local'` to the queue-exec argv. Tested by exposing or stubbing `spawnPrdChild`'s argv-construction path (extract a pure helper if needed for testability) and asserting argv contents for both "with profile" and "without profile" cases.
- [ ] The build run's `session:profile` event carries `profileName: 'pi-local'`, `source: 'override'`. Tested by running `loadConfig(cwd, { profileOverride: 'pi-local' })` against a fixtures cwd that ships a `pi-local` profile and asserting the returned `profile.source === 'override'`. (The `session:profile` event emission sites at eforge.ts:243, 467, 1361, 1623, 1840 already pull from `this.configProfile.source` unconditionally — no targeted edit needed; assert via a focused engine test that constructs an engine with `profileOverride: 'pi-local'` and consumes the first emitted event from `engine.compile` or `engine.build`.)
- [ ] Two PRDs (one with override, one without) running concurrently with `maxConcurrentBuilds >= 2` each bind their own profile. Tested via a multi-engine unit test or by asserting that two `loadConfig` calls — one with `profileOverride: 'pi-local'` and one without — return distinct `profile.name` values without cross-contamination.
- [ ] The enqueue subprocess (formatter + dep-detector) runs on the override profile. Tested by extending `test/agent-wiring.test.ts` (or the new test file) with a case that constructs an engine with `profileOverride: 'pi-local'`, invokes `engine.enqueue` via stub harness, and asserts that `agentRuntimeRegistry.forRole('formatter')` and `forRole('dependency-detector')` resolve through the override profile's tiers.
- [ ] `eforge_build` MCP tool with `{ source, profile: 'pi-local' }` produces the same end-to-end behavior as the CLI flag — i.e. it forwards `profile` in the POST body. Tested by mocking the daemon HTTP and asserting the request body contains `profile: 'pi-local'` for both the CC plugin proxy and the Pi extension tool.
- [ ] Pi `/eforge:build` with `ctx.hasUI` shows a searchable picker listing all available profiles plus `'Use active profile (no override)'`; selecting no-override sends `/skill:eforge-build` (no `--profile`), selecting a profile sends `/skill:eforge-build --profile <name>`. Tested by stubbing `ctx.ui.custom`, `daemonRequest`, and `pi.sendUserMessage`, invoking the registered handler, and asserting the resulting `sendUserMessage` payload for both branches.
- [ ] `POST /api/enqueue { profile: 'does-not-exist' }` returns HTTP 400 with body `"Profile 'does-not-exist' not found"` (matches `JSON.stringify` shape produced by `sendJsonError`); no enqueue worker is spawned, no PRD is written. Tested by spinning up the monitor server with a stub `workerTracker`, posting a body with a bogus profile, asserting the response status/body, and asserting `workerTracker.spawnWorker` was not called.
- [ ] CLI surface mirrors HTTP 400: `eforge enqueue source --profile does-not-exist` exits non-zero with a stderr message naming the missing profile (the `EforgeEngine.create` call inside the CLI handler throws from `loadConfig` before any file I/O happens).
- [ ] With no `profile` field anywhere, marker-chain resolution behaves as today — `loadConfig({})` and `loadConfig()` are equivalent and produce the same `profile.source` for a fixtures cwd whose `.active-profile` resolves normally.
- [ ] Commits produced by an override run carry the override profile's model id in the `Models-Used:` trailer. Verified by inspecting the engine's `ModelTracker` flow: agents resolved through the override profile's tiers record their model into the tracker just as marker-resolved agents do (no code change needed; assert via a focused test that builds a tracker through an override-resolved registry and asserts trailer composition).
- [ ] `pnpm type-check` passes — exhaustive switches over `ActiveProfileSource` and the `session:profile` `source` enum compile cleanly after adding `'override'`. (The compile-time guard is the design intent of the new enum value per Decision D4.)
- [ ] Deleting the override profile file between enqueue and scheduler pickup causes the PRD to land in `.eforge/queue/failed/` with a `plan:error:set` event whose message names the missing profile and the scopes searched. No worker is spawned. Auto-build pauses (existing behavior on a failed PRD per memory `feedback_dont_retry_builds.md`). Tested by writing a PRD with `profile: pi-local`, calling the extracted pre-flight helper from `spawnPrdChild` against a tmpdir whose `pi-local` profile file does not exist, and asserting (a) the events emitted, (b) the file is at `.eforge/queue/failed/<id>.md`, (c) `workerTracker.spawnWorker`/`child_process.spawn` was not called.
- [ ] Vitest specifically covers:
  - `loadConfig(cwd, { profileOverride: 'pi-local' })` returns the merged config with `profile.source === 'override'`; throws on missing with a message containing the profile name and the searched scopes.
  - `engine.enqueue(source, { profile: 'pi-local' })` writes the field; `parseFrontmatter` reads it back; `prdFrontmatterSchema.safeParse` accepts the value.
  - PRD with `frontmatter.profile = 'pi-local'` produces `--profile pi-local` in the queue-exec argv; without, no flag (assert via the extracted argv-builder helper).
  - Pre-flight failure path in `spawnPrdChild`: missing profile -> `plan:error:set` emitted, PRD moved to `failed/`, no spawn.
  - Override threads through `agentRuntimeRegistry` so agents bind to the override profile's tiers (extension to `test/agent-wiring.test.ts` or a focused new case in the new test file).
  - Daemon `POST /api/enqueue` with bogus profile returns HTTP 400 and does not call `workerTracker.spawnWorker`.
  - Daemon `POST /api/enqueue` with a valid profile appends `'--profile', name` to the args passed to `workerTracker.spawnWorker`.
  - CC plugin MCP `eforge_build` and Pi `eforge_build` tools forward `profile` in the daemon request body when set, and omit it when unset.
