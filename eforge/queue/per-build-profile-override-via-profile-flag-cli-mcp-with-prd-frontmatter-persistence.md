---
title: Per-build profile override via --profile flag (CLI + MCP) with PRD-frontmatter persistence
created: 2026-05-07
---

# Per-build profile override via --profile flag (CLI + MCP) with PRD-frontmatter persistence

## Problem / Motivation

Today the daemon binds one active profile per lifetime by reading `.active-profile` markers (precedence: `.eforge/.active-profile` → `eforge/.active-profile` → `~/.config/eforge/.active-profile`). The daemon's single-profile binding forces an all-or-nothing trade-off: pick frontier and burn tokens on every build, or pick local and lose frontier quality where it matters. There is no way to run a frontier build and a local build in parallel from the same daemon, which makes managing frontier-quota exhaustion painful (you have to restart the daemon and lose in-flight queue state to swap profiles).

The user wants a per-build override so a frontier-profile build and a `pi-local` build can run in parallel from one daemon, mainly to manage frontier-model usage limits.

**What makes it cheap:** every subprocess (daemon, enqueue worker, build worker) calls `loadConfig(cwd)` independently. There's no shared in-memory profile state to coordinate around. The override only needs to flow through one durable hop (PRD frontmatter) and two transient ones (HTTP body → enqueue argv; PRD file → queue-exec argv).

**Why frontmatter must carry it:** the build doesn't run at enqueue time. The scheduler picks up a PRD later, possibly across a daemon restart. The PRD file is the only durable queue artifact, so the override has to live in its frontmatter.

Existing profiles in this repo (verified): `claude-sdk-4-7`, `pi-codex-5-5`, `pi-local`.

### Code paths (verified)

| Concern | File:line |
|---|---|
| `loadConfig` / `resolveActiveProfileName` | `packages/engine/src/config.ts:820`, `:1161` |
| `EforgeEngine.create` / `spawnPrdChild` | `packages/engine/src/eforge.ts:176`, `:1037` |
| `session:profile` event | `packages/client/src/events.schemas.ts:364` |
| `/api/enqueue` route | `packages/monitor/src/server.ts:1208` |
| Enqueue / `queue exec` CLI | `packages/eforge/src/cli/index.ts:135`, `:388` |
| PRD frontmatter schema / parser / writer | `packages/engine/src/prd-queue.ts:35`, `:60`, `:590` |
| `EnqueueRequest` / `API_ROUTES` | `packages/client/src/routes.ts:7`, `:109` |
| Pi UI primitives / profile picker reference | `packages/pi-eforge/extensions/eforge/ui-helpers.ts:35,77`, `profile-commands.ts:72-111` |

## Goal

Allow individual builds to run on a profile other than the daemon's active profile by passing a `--profile <name>` flag (CLI + MCP), persisting the override in PRD frontmatter so it survives daemon restarts, and threading it cleanly through enqueue and build subprocesses without auto-fallback.

## Approach

### Design Decisions

**D1. Override is a profile name, not an inline tier blob.** Profiles are already file-backed and validated; inlining would create a parallel config surface. Users must pre-create the profile.

**D2. Persist in PRD frontmatter, not a sidecar or DB column.** PRD is the only durable queue artifact. A sidecar can drift; a DB column wouldn't help — the scheduler needs the override before any run row exists.

**D3. Override resolution bypasses the marker chain entirely.** `loadConfig` short-circuits `resolveActiveProfileName` when `profileOverride` is set. Override wins, or the load throws — no fallback (would mask user intent and quietly burn frontier tokens on a build the user wanted local).

**D4. New `source: 'override'` enum value, not a separate boolean.** Keeps the event shape closed; gives the monitor UI one discriminator to switch on. Widening `ActiveProfileSource` triggers compile errors at every exhaustive switch (a feature).

**D5. Both enqueue and build subprocesses honor the override.** Otherwise the formatter + dep-detector still burn frontier tokens at enqueue, defeating the goal. Two `--profile` flag definitions in the CLI; cheap.

**D6. Validate at enqueue (HTTP 400), not at build start.** Catches typos before any PRD lands in the queue. One extra `loadProfile` call on the enqueue path; negligible.

**D7. Pi `/eforge:build` gets a picker; `eforge_build` tool stays a string.** Matches the existing convention (interactive command vs. programmatic tool) seen in `profile-commands.ts`. Both still target the same wire field.

**D8. No merging of override and marker-resolved profile.** Would create surprising semantics with no clear use case. Hybrids must be expressed as a new explicit profile file.

**D9. No backward-compat shim.** Field is optional; old PRDs without it work unchanged; old daemons ignore the new field. Bump `DAEMON_API_VERSION` for honest skew detection.

**D10. Build-time profile-load failure: hard-fail with a structured error.** The override file could be deleted between enqueue and build (or YAML could go corrupt). Two layers handle it:
- **Pre-flight in scheduler** (primary): `spawnPrdChild` validates via `loadProfile` before spawning. On miss, emit `plan:error:set` whose message names the missing profile and the scopes searched, mark the PRD failed via `mutateState`, move to `.eforge/queue/failed/` with frontmatter intact, no worker spawned. Auto-build pauses per existing failure behavior.
- **Worker startup** (defense-in-depth): tiny race window after pre-flight passes. `EforgeEngine.create()` throws; the CLI handler logs to stderr and exits non-zero; the scheduler marks the run failed pointing at the worker log.

No auto-fallback and no auto-mutation of the user's PRD. Recovery is manual: restore the profile, or edit `profile:` out of the PRD frontmatter.

### Code Impact

**Wire (`@eforge-build/client`):**
- `routes.ts:7` — `EnqueueRequest.profile?: string`.
- `events.schemas.ts:364` — extend `session:profile` `source` union with `'override'`.
- `api-version.ts` — bump `DAEMON_API_VERSION`.

**Daemon HTTP route:**
- `monitor/src/server.ts:1208` — parse `body.profile`; validate via `loadProfile(configDir, name, projectRoot)`; on miss return 400 `"Profile '<name>' not found"`; on hit append `'--profile', name` to enqueue worker argv.

**CLI:**
- `eforge/src/cli/index.ts:135` (`enqueue`) — add `.option('--profile <name>')`; pass `{ profileOverride }` to `EforgeEngine.create()` and `{ profile }` to `engine.enqueue()` for PRD persistence.
- `eforge/src/cli/index.ts:388` (`queue exec`) — add `.option('--profile <name>')`; pass `{ profileOverride }` to `EforgeEngine.create()`.

**Engine + config loader:**
- `engine/src/eforge.ts:176` — `EforgeEngineOptions.profileOverride?: string`; forward to `loadConfig`.
- `engine/src/eforge.ts:1037` (`spawnPrdChild`) — pre-flight validate `prd.frontmatter.profile` via `loadProfile`. On miss: emit `plan:status:change → failed` + `plan:error:set` (via `mutateState`), move PRD to `failed/`, do not spawn worker. On hit: append `--profile <name>` to argv.
- `engine/src/config.ts:820` (`loadConfig`) — accept `{ profileOverride? }`; when set, skip `resolveActiveProfileName`, call `loadProfile(...)` directly, return `source: 'override'`. Throw a descriptive `Error` on miss.
- `engine/src/config.ts:917` — add `'override'` to `ActiveProfileSource`.

**PRD frontmatter:**
- `engine/src/prd-queue.ts:35` — add `profile: z.string().optional()` to `prdFrontmatterSchema`.
- `engine/src/prd-queue.ts:60` (`parseFrontmatter`) — line-based parser already accepts new keys; only the schema changes.
- `engine/src/prd-queue.ts:590` — writer serializes `profile: <name>` when set.
- `engine/src/eforge.ts` — `engine.enqueue(source, { profile })` plumbs through to the writer.

**MCP surfaces (sync per AGENTS.md):**
- `eforge-plugin/.claude-plugin/plugin.json` — bump version.
- `eforge-plugin/` `eforge_build` tool — optional `profile: string`; forward to HTTP body.
- `packages/pi-eforge/extensions/eforge/index.ts:356` (`eforge_build` tool) — same string parameter.
- `packages/pi-eforge/extensions/eforge/index.ts` (`/eforge:build` native command, near `pi.registerCommand` ~line 2070) — when `ctx.hasUI`: fetch `${API_ROUTES.profileList}?scope=all`, render `showSearchableSelectOverlay()` mirroring `profile-commands.ts:88-101` with a synthetic top entry "Use active profile (no override)". Headless: honor inline `--profile <name>`.

**Worker startup defense-in-depth:**
- `eforge/src/cli/index.ts:388` (`queue exec`) — wrap engine construction in try/catch. On `loadConfig` throw, write structured error to stderr (captured to `.eforge/worker-<sid>.log`), exit non-zero. Scheduler observes the non-zero exit and surfaces a generic "build worker exited before initialization" failure pointing at the log.

## Scope

**In:**
- `EnqueueRequest.profile?: string` on the wire.
- `--profile <name>` flag on `eforge enqueue` and `eforge queue exec`.
- Optional `profile` parameter on the `eforge_build` MCP tool in both `eforge-plugin/` and `packages/pi-eforge/`.
- Pi `/eforge:build` interactive command: `showSearchableSelectOverlay()` profile picker (when `ctx.hasUI`).
- Persisted as `profile: <name>` in PRD frontmatter.
- `EforgeEngineOptions.profileOverride?: string` → `loadConfig(cwd, { profileOverride })`.
- `'override'` added to `ActiveProfileSource` and the `session:profile` event `source` enum.
- HTTP 400 at enqueue if profile doesn't resolve.
- Pre-flight + worker-startup handling for the build-time-missing-profile race.
- Vitest coverage.

**Out:**
- Monitor UI enqueue-form dropdown.
- Mid-build profile switching.
- Profile merging/inheritance.
- Scheduler/parallelism changes.
- Profile creation UX.
- `runs` DB column.

## Acceptance Criteria

1. `eforge enqueue ./prd.md --profile pi-local` writes `profile: pi-local` to the PRD frontmatter in `.eforge/queue/`.
2. Scheduler picks up that PRD and spawns `queue exec <id> ... --profile pi-local`; the run's `session:profile` event carries `profileName: 'pi-local'`, `source: 'override'`.
3. Two PRDs (one with override, one without) run concurrently with `maxConcurrentBuilds >= 2`, each on its own profile.
4. The enqueue subprocess (formatter + dep-detector) also runs on the override profile when `--profile` is set.
5. `eforge_build` MCP tool with `{ source, profile: 'pi-local' }` produces the same end-to-end behavior as the CLI flag.
6. Pi `/eforge:build` with `ctx.hasUI` shows a searchable picker listing all three profiles plus "Use active profile (no override)"; selecting no-override sends no `profile` field; selecting `pi-local` flows through.
7. `POST /api/enqueue { profile: 'does-not-exist' }` returns HTTP 400 naming the missing profile; no worker spawned, no PRD written. CLI surface mirrors this.
8. With no `profile` field anywhere, marker-chain resolution behaves exactly as today.
9. Commits produced by an override run carry the override profile's model id in the `Models-Used:` trailer.
10. `pnpm type-check` passes — exhaustive switches on `ActiveProfileSource` and the `session:profile` variant compile cleanly after adding `'override'`.
11. Deleting the override profile file between enqueue and scheduler pickup causes the PRD to land in `.eforge/queue/failed/` with a `plan:error:set` event whose message names the missing profile and the scopes searched. No worker is spawned. Auto-build pauses.
12. Vitest:
    - `loadConfig(cwd, { profileOverride: 'pi-local' })` returns the merged config with `source: 'override'`; throws on missing.
    - `engine.enqueue(source, { profile: 'pi-local' })` writes the field; `parseFrontmatter` reads it back.
    - PRD with `frontmatter.profile = 'pi-local'` produces `--profile pi-local` in the queue-exec argv; without, no flag.
    - Pre-flight failure path in `spawnPrdChild`: missing profile → `plan:error:set` emitted, PRD moved to `failed/`, no spawn.
    - Override threads through `agentRuntimeRegistry` so agents bind to the override profile's tiers (extend `test/agent-wiring.test.ts`).

## Assumptions And Validation

| Assumption | Evidence | Confidence | Validation path | Impact if wrong |
|---|---|---|---|---|
| Each subprocess calls `loadConfig` independently; no env/argv inheritance. | Read of `EforgeEngine.create`, both CLI handlers, `spawnPrdChild`. | high | done | Override would need a different transport (env var or IPC). |
| `loadConfig` can short-circuit `resolveActiveProfileName` cleanly. | Marker resolution at config.ts:882-893 is self-contained; merge at :897 only consumes `profileConfig`. | high | done | Deeper refactor; design holds. |
| PRD file is the only durable queue state. | `runs` DB tracks executions only; queue lives in `.eforge/queue/*.md`. | high | done | An additional DB column would also need updating; plan still applies. |
| `loadProfile(configDir, name, projectRoot)` returns null on miss with no side effects, safe to call from HTTP route and scheduler pre-flight. | Reported by exploration. | medium | Read `loadProfile` body during impl. | Need a separate "exists" helper; trivial. |
| `session:profile` already emits unconditionally at every entry point; new `'override'` value surfaces automatically. | Emission sites at eforge.ts:242, 466, 1361, 1623, 1840. | medium | Run daemon with override; confirm event in `.eforge/event-log.jsonl`. | Targeted edits at emission sites; small impact. |
| `parseFrontmatter` line-based parser accepts new keys without grammar changes. | Parser is regex `/^---\n([\s\S]*?)\n---/` then key:value extraction. | medium | Read parser; add round-trip unit test. | Parser tweak; bounded. |
| `spawnPrdChild` already has parsed `prd.frontmatter` in scope at argv-construction time. | Reported by exploration for eforge.ts:1037. | medium | Read function during impl. | One extra `parsePrdFile()` call; trivial. |
| `showSearchableSelectOverlay()` is the right primitive (matches `/eforge:profile`). | `profile-commands.ts:88-101` uses it; ui-helpers exports it. | high | done | Fall back to `showSelectOverlay()`; same plan. |
| Default `maxConcurrentBuilds: 2` lets two different-profile builds run concurrently with no extra locking. | Memory `feedback_eforge_default_parallelism.md`; each worker is a separate subprocess. | high | done | Parallelism criterion fails; non-blocking for the basic feature. |
| Bumping `DAEMON_API_VERSION` is appropriate for an additive optional field. | AGENTS.md note targets breaking changes. | medium | Decide at impl time. | If unneeded, no harm; if missed, version-skew detection lags one release. |
| Pre-flight validation in `spawnPrdChild` plus startup catch in `queue exec` adequately covers the rare delete-between-enqueue-and-build race. | Window is milliseconds; both layers use the same `loadProfile` predicate. | high | done | Worker would exit on null engine with an opaque error; defense-in-depth catch covers this case. |

## Profile Signal

**Excursion.** Focused, cohesive plumbing across a fully mapped surface (~10 files); design decisions are pivotal but a single planner session can enumerate every file, contract change, and test. Not Errand (real design decisions, multi-package). Not Expedition (no module-level subplans, no architecture planning).
