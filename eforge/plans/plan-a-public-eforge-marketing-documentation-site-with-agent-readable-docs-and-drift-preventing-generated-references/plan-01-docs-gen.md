---
id: plan-01-docs-gen
name: Docs generator package and checked-in generated reference artifacts
branch: plan-a-public-eforge-marketing-documentation-site-with-agent-readable-docs-and-drift-preventing-generated-references/plan-01-docs-gen
agents:
  builder:
    effort: high
    rationale: Generators must extract from heterogeneous source-of-truth files
      (Commander CLI registration, Commander-nested playbook command, API_ROUTES
      + TypeScript wire types, TypeBox event schemas, Zod v4 config schemas, MCP
      createDaemonTool registrations, Pi extension command/tool TS files,
      Claude/Pi skill SKILL.md frontmatter) without introducing a parallel
      source of truth. Requires careful extraction strategy choices per surface.
  test-writer:
    effort: medium
    rationale: Tests are mostly happy-path on extraction plus a drift-detection
      assertion; medium effort is sufficient.
---


## Architecture Context

This plan establishes the deterministic documentation-generation layer that produces all agent-readable canonical artifacts and human-readable generated references for the eforge public site. Per `AGENTS.md`, the daemon HTTP route contract, event protocol, config schema, MCP tool surface, and Pi/Claude integration skill surface are all code-owned single-sources-of-truth. The generator must consume those contracts directly — it must not redeclare them or create a parallel source of truth.

Design decisions enforced here:

- Generator outputs are checked into git so PRs surface contract changes as reviewable diffs and CI can detect drift with `git diff --exit-code` after regeneration.
- Generated Markdown is provenance-bearing: every reference file begins with a header that includes a 'Generated file. Do not edit.' warning, the source files used, the eforge package version, and the git commit short hash.
- `llms.txt` is intentionally curated (not a sitemap): a hand-authored manifest in `packages/docs-gen/src/manifest.ts` decides what eforge is, identifies canonical docs, and links to raw references and schemas. `llms-full.txt` is the deterministic concatenation of all canonical reference Markdown plus the curated overview.
- The package is workspace-internal (`@eforge-build/docs-gen`, `private: true`) — not published to npm.
- Outputs land in `web/content/reference/` (Markdown rendered as pages), `web/public/reference/` (raw `.md` mirror for agents), `web/public/schemas/` (JSON schemas), `web/public/llms.txt`, and `web/public/llms-full.txt`. Plan-02 will scaffold the rest of `web/`.

Extraction strategy per surface (pragmatic, no upstream refactor for MVP):

- **CLI** (`/reference/cli.md`): static-build a Commander program in-process by importing `registerPlaybookCommand` and reproducing the top-level `eforge` Command tree from `packages/eforge/src/cli/index.ts` via a small refactor that exports a `buildEforgeCommand()` factory (introduces no new source of truth — it is the same Commander wiring, just exported). Walk the resulting Command tree to extract name, description, options, and subcommands.
- **Daemon API** (`/reference/api.md`): import `API_ROUTES` from `@eforge-build/client` and the typed request/response interfaces co-located in `packages/client/src/routes.ts` / `packages/client/src/types.ts`. Use the TypeScript Compiler API (`ts.createProgram`) at generation time to read the interface declarations and emit a Markdown table per route. Best-effort `/schemas/daemon-api.json` is acceptable but optional — for MVP, ship `/reference/api.md` and skip the JSON dump if extraction is brittle.
- **Events** (`/reference/events.md`, `/schemas/events.schema.json`): import `EforgeEventSchema` from `@eforge-build/client` (TypeBox). TypeBox schemas are already JSON Schema at runtime — write `EforgeEventSchema` directly as `web/public/schemas/events.schema.json`. Walk the union to emit one Markdown section per variant with its discriminant `type` and field summary.
- **Config** (`/reference/config.md`, `/schemas/config.schema.json`): import the Zod v4 schemas from `@eforge-build/engine/config`. Use `z.toJSONSchema()` (Zod v4 native) to emit the JSON schema. Walk the schema tree to emit Markdown sections for each top-level config block.
- **Tools** (`/reference/tools.md`): scan `packages/eforge/src/cli/mcp-proxy.ts` with `ts-morph` (or the TypeScript Compiler API) to extract every `createDaemonTool(server, cwd, { name, description, inputSchema, ... })` call's `name` string-literal property and the description/inputSchema object-literal properties. Repeat for Pi extension command/tool declarations in `packages/pi-eforge/extensions/eforge/`. Inline schemas (Zod) are converted to a short Markdown table of parameters.
- **Skills** (folded into `/reference/tools.md` under a 'Skill surfaces' section): walk `eforge-plugin/skills/` and `packages/pi-eforge/skills/`, parse each `SKILL.md` YAML frontmatter for `name` and `description`, and list both surfaces side by side so the Pi/Claude parity required by `AGENTS.md` is visible.

Drift prevention:

- `pnpm docs:generate` always overwrites the generated files in-place. Output writers must sort keys / iterate sources in a stable order so byte-for-byte output is deterministic across machines.
- `pnpm docs:check` runs `pnpm docs:generate` then `git diff --exit-code -- web/content/reference web/public/reference web/public/schemas web/public/llms.txt web/public/llms-full.txt` and exits non-zero if any generated file changed.
- A vitest test `test/docs-gen-drift.test.ts` calls the in-process generator entry point against a temp output directory and asserts every emitted file is byte-identical to the checked-in copy. This guards against forgetting `pnpm docs:check` in CI as well as catching environment-specific differences.

## Implementation

### Overview

Introduce `packages/docs-gen/` (workspace-internal) with a single CLI entry point that drives per-surface generators, a curated `llms.txt` manifest, and a deterministic concatenator for `llms-full.txt`. Export `buildEforgeCommand()` from `packages/eforge/src/cli/index.ts` so the CLI generator can walk the command tree without reproducing it. Add root `pnpm docs:generate` and `pnpm docs:check` scripts. Commit the initial set of generated outputs and JSON schemas into `web/content/` and `web/public/`. Add one vitest spec that locks in determinism and drift detection.

### Key Decisions

1. **Single generator binary, sub-commands per surface.** `pnpm docs:generate` runs `node packages/docs-gen/dist/cli.js generate --all`, which delegates to per-surface generator modules. This keeps the public surface stable and the per-surface code internal.
2. **Use the TypeScript Compiler API plus `ts-morph` for extraction.** Importing TS source from a sibling workspace package is fine for CLI/MCP extraction; for the Commander tree we instantiate the program in-process by importing `buildEforgeCommand()` directly. This avoids parsing source as text whenever a runtime hook is available.
3. **TypeBox emits JSON Schema natively.** Write `EforgeEventSchema` directly to disk — no converter dependency.
4. **Zod v4's `z.toJSONSchema()` covers config.** Zod v4 (used by `packages/engine/src/config.ts`) supports `z.toJSONSchema(schema)` natively, no separate converter package needed.
5. **Skill parity check is in scope.** The existing `scripts/check-skill-parity.mjs` validates Pi/Claude skill parity but does not produce docs. Reuse the parity catalog logic shape (walk both skill directories) to emit a 'Skill surfaces' Markdown section in `/reference/tools.md`.
6. **Provenance metadata is captured at generate-time, not build-time.** The generator records `process.env.EFORGE_VERSION ?? require('../../packages/eforge/package.json').version` and `git rev-parse --short HEAD` once and stamps every output file with the same value, so a single run produces a consistent provenance set.
7. **Generated files live in `web/` even though `web/` does not exist as a Next.js app yet.** Plan-01 creates `web/content/reference/`, `web/public/reference/`, `web/public/schemas/`, and the top-level `web/public/llms*.txt` files. Plan-02 will scaffold the Next.js app around them. A `web/.gitkeep` is unnecessary because the generated content files themselves provide the directory structure.

## Scope

### In Scope

- New workspace package `packages/docs-gen/` with `package.json`, `tsconfig.json`, `tsup.config.ts`, and TypeScript source under `src/`.
- Per-surface generator modules: `cli.ts`, `api.ts`, `events.ts`, `config.ts`, `tools.ts`, `llms.ts`.
- Curated manifest in `src/manifest.ts` driving `llms.txt` and the `llms-full.txt` concat order.
- Provenance helper `src/provenance.ts` producing the standard generated-file header.
- Drift-check entry point `src/check.ts` exporting `runDriftCheck(): Promise<{ ok: boolean; changed: string[] }>` plus a CLI subcommand `docs-gen check` that wraps it with `git diff --exit-code`.
- Root `package.json` scripts: `docs:generate`, `docs:check`.
- Export `buildEforgeCommand()` from `packages/eforge/src/cli/index.ts` and re-route the existing `program` construction through it.
- Initial checked-in generated outputs under `web/content/reference/`, `web/public/reference/`, `web/public/schemas/`, and `web/public/llms.txt` / `web/public/llms-full.txt`.
- One vitest spec covering determinism and drift detection.

### Out of Scope

- Next.js scaffolding, hand-written human docs, sidebar manifest, landing page, and CI updates — those are plan-02.
- Migrating CLI/MCP/Pi declarations to a shared registry; only pragmatic in-place extraction is used.
- Publishing `@eforge-build/docs-gen` to npm; it is workspace-internal and `private: true`.
- A second human-readable docs framework or full-text search.
- Versioned docs.

## Files

### Create

- `packages/docs-gen/package.json` — workspace-internal package; `private: true`; depends on `@eforge-build/client`, `@eforge-build/engine`, `@eforge-build/eforge`, `commander`, `ts-morph`, `yaml`, `zod`; exposes a `docs-gen` bin via `tsup` build that emits to `dist/cli.js`.
- `packages/docs-gen/tsconfig.json` — extends `tsconfig.base.json`, `composite: false`, references workspace packages.
- `packages/docs-gen/tsup.config.ts` — bundles `src/cli.ts` to `dist/cli.js` (ESM, Node target).
- `packages/docs-gen/src/cli.ts` — Commander entry. Subcommands: `generate --all | --surface <name>`, `check`. `generate` calls each surface generator with a shared `OutputContext` (root dir, provenance metadata). `check` runs `runDriftCheck` and exits non-zero on differences.
- `packages/docs-gen/src/output-paths.ts` — exported constants for every output file path, rooted at the repo root via `findRepoRoot()`. Keeps paths in one place so plan-02 and tests can import them.
- `packages/docs-gen/src/provenance.ts` — `buildProvenanceHeader({ sourceFiles, eforgeVersion, gitCommit, generatedAt })` returning the standard generated-file header block. Also exports `gatherProvenance()` that resolves `eforgeVersion` from `packages/eforge/package.json` and `gitCommit` from `git rev-parse --short HEAD` (falling back to env `EFORGE_GIT_COMMIT` when not in a git workdir).
- `packages/docs-gen/src/manifest.ts` — exports `LLMS_MANIFEST` describing the curated `llms.txt` content (overview paragraph, canonical doc list, link map) and the concatenation order for `llms-full.txt`.
- `packages/docs-gen/src/generators/cli.ts` — imports `buildEforgeCommand` from `@eforge-build/eforge/cli`, walks the resulting Commander tree, and emits Markdown to `web/content/reference/cli.md` and a mirror to `web/public/reference/cli.md`.
- `packages/docs-gen/src/generators/api.ts` — imports `API_ROUTES` and parses `packages/client/src/routes.ts` and `packages/client/src/types.ts` with `ts-morph` to extract the request/response interfaces for each route; emits `web/content/reference/api.md` and `web/public/reference/api.md`.
- `packages/docs-gen/src/generators/events.ts` — imports `EforgeEventSchema` from `@eforge-build/client`, writes `web/public/schemas/events.schema.json` (the TypeBox schema serialized as JSON Schema), and emits `web/content/reference/events.md` + `web/public/reference/events.md` describing each event variant.
- `packages/docs-gen/src/generators/config.ts` — imports the engine config Zod schemas from `@eforge-build/engine/config`, writes `web/public/schemas/config.schema.json` via `z.toJSONSchema()`, and emits `web/content/reference/config.md` + `web/public/reference/config.md`.
- `packages/docs-gen/src/generators/tools.ts` — uses `ts-morph` to extract every `createDaemonTool(...)` call in `packages/eforge/src/cli/mcp-proxy.ts` and every Pi tool/command registration in `packages/pi-eforge/extensions/eforge/`; also walks `eforge-plugin/skills/` and `packages/pi-eforge/skills/` to parse SKILL.md frontmatter; emits `web/content/reference/tools.md` + `web/public/reference/tools.md` containing a 'MCP tools (Claude Code)' table, a 'Native commands (Pi)' table, and a 'Skill surfaces' parity table.
- `packages/docs-gen/src/generators/llms.ts` — reads the manifest, all five emitted reference Markdown files (after they are written by the other generators), and the project README; emits `web/public/llms.txt` (curated index, ~80 lines) and `web/public/llms-full.txt` (concatenation in manifest order with separator markers).
- `packages/docs-gen/src/check.ts` — `runDriftCheck()` writes outputs to a tmp directory, hashes both the tmp and on-disk versions, and reports any file whose content drifted. The CLI `check` subcommand additionally runs `git diff --exit-code -- <tracked output paths>` as belt-and-suspenders for files that are tracked.
- `test/docs-gen-determinism.test.ts` — vitest spec: calls `runDriftCheck()` from `@eforge-build/docs-gen/check` and asserts the result reports zero changed files. A second case calls `generate` twice in a row against a tmp dir and asserts byte-identical outputs (deterministic emission).
- `web/content/reference/cli.md` — initial generated output (header + body produced by the generator).
- `web/content/reference/api.md` — initial generated output.
- `web/content/reference/events.md` — initial generated output.
- `web/content/reference/config.md` — initial generated output.
- `web/content/reference/tools.md` — initial generated output.
- `web/public/reference/cli.md` — raw mirror of the content file.
- `web/public/reference/api.md` — raw mirror.
- `web/public/reference/events.md` — raw mirror.
- `web/public/reference/config.md` — raw mirror.
- `web/public/reference/tools.md` — raw mirror.
- `web/public/schemas/events.schema.json` — TypeBox `EforgeEventSchema` serialized as JSON Schema.
- `web/public/schemas/config.schema.json` — engine config Zod schemas via `z.toJSONSchema()`.
- `web/public/llms.txt` — curated index of canonical docs and reference artifacts.
- `web/public/llms-full.txt` — deterministic concatenation of all canonical reference Markdown.

### Modify

- `package.json` (repo root) — add `docs:generate` (runs `pnpm --filter @eforge-build/docs-gen build && node packages/docs-gen/dist/cli.js generate --all`) and `docs:check` (runs `pnpm docs:generate` then `git diff --exit-code -- web/content/reference web/public/reference web/public/schemas web/public/llms.txt web/public/llms-full.txt`). Add `@eforge-build/docs-gen: workspace:*` to `devDependencies`.
- `packages/eforge/src/cli/index.ts` — extract the existing top-level Commander wiring into a new exported factory function `export function buildEforgeCommand(options?: { version?: string }): Command` so the docs-gen CLI surface generator can import it without spawning a subprocess. The existing default flow that drives `program.parse(process.argv)` keeps working by calling `buildEforgeCommand({ version: EFORGE_VERSION })` and then parsing.
- `packages/eforge/package.json` — add a subpath export for `./cli` so `@eforge-build/eforge/cli` resolves to the compiled `dist/cli/index.js` for in-process imports from docs-gen.
- `tsconfig.json` (repo root) — add the new `packages/docs-gen` path if a `paths`/`references` entry exists (no-op if the file only lists workspace globs).

## Verification

- [ ] `pnpm install` succeeds with `packages/docs-gen` listed in pnpm-workspace's existing `packages/*` glob and no missing dependencies.
- [ ] `pnpm --filter @eforge-build/docs-gen build` produces `packages/docs-gen/dist/cli.js`.
- [ ] `pnpm docs:generate` exits with code 0 and writes all 14 expected output files (5 content/.md + 5 public/.md + 2 schemas/.json + 2 llms*.txt).
- [ ] Running `pnpm docs:generate` twice in a row produces byte-identical outputs (verified by `git diff --exit-code` after the second run).
- [ ] `pnpm docs:check` exits with code 0 immediately after `pnpm docs:generate` and exits non-zero when any tracked generated file is manually edited to a different value.
- [ ] Each of the 5 reference Markdown files begins with a provenance block containing the strings 'Generated file. Do not edit.', a 'Source files:' list, an 'eforge version:' value, and a 'Commit:' short-hash value.
- [ ] `web/public/schemas/events.schema.json` parses as valid JSON Schema and contains every event `type` discriminant literal present in the `EforgeEventSchema` union in `packages/client/src/events.schemas.ts`.
- [ ] `web/public/schemas/config.schema.json` parses as valid JSON Schema and includes top-level fields `maxConcurrentBuilds` and `plugins` from the engine config schema.
- [ ] `web/public/llms.txt` contains an opening 'eforge is' summary line, a 'Canonical reference' section linking to the 5 raw `.md` URLs, and a 'Schemas' section linking to the 2 JSON files.
- [ ] `web/public/llms-full.txt` byte length equals the sum of the manifest overview length plus the 5 reference Markdown file lengths plus their separator markers (deterministic concatenation).
- [ ] `web/content/reference/cli.md` lists every top-level `eforge` subcommand registered in `packages/eforge/src/cli/index.ts` (`enqueue`, `build`, `monitor`, `status`, `queue`, etc.) and every nested `queue` subcommand.
- [ ] `web/content/reference/api.md` lists every key of `API_ROUTES` and prints the route pattern for each.
- [ ] `web/content/reference/tools.md` contains a 'MCP tools (Claude Code)' table with row count equal to the number of `createDaemonTool(server, cwd, { name: ... })` calls in `packages/eforge/src/cli/mcp-proxy.ts` and a 'Skill surfaces' table covering every directory under `eforge-plugin/skills/` and `packages/pi-eforge/skills/`.
- [ ] `test/docs-gen-determinism.test.ts` passes under `pnpm test`.
- [ ] `pnpm build` and `pnpm type-check` succeed for the entire workspace including the new package.
- [ ] No file under `packages/`, `eforge-plugin/`, or `packages/pi-eforge/extensions/` has been edited beyond the documented `packages/eforge/src/cli/index.ts` factory export and the `packages/eforge/package.json` subpath export — generators are read-only consumers of those surfaces.
