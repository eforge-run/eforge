---
id: plan-01-engine-trust-foundation
name: Engine Trust Store, Hashing, and Loader Enforcement
branch: harden-extension-trust-model/plan-01-engine-trust-foundation
agents:
  builder:
    effort: high
    rationale: Security-sensitive extension loader changes require careful hashing,
      persistence, and backward-compatible type updates.
  reviewer:
    effort: high
    rationale: Trust-boundary changes need close review for bypasses and accidental
      code execution before trust.
---

# Engine Trust Store, Hashing, and Loader Enforcement

## Architecture Context

Native extensions are loaded in-process by `packages/engine/src/extensions/loader.ts`. Today project/team extensions under `eforge/extensions/` are gated only by `extensions.trustProjectExtensions`; this plan replaces the coarse load decision with per-extension local trust records and content-hash comparison before any extension import occurs.

The trust decision must remain local to the user/clone. Store trust records under `.eforge/extension-trust.json` or an equivalent gitignored `.eforge/` file, never under committed `eforge/` metadata. Keep the existing config guard that strips `extensions.trustProjectExtensions` from project/team config and profiles.

## Implementation

### Overview

Add engine-level trust metadata, deterministic hashing, trust-store read/write helpers, and discovery/loader enforcement for committed project/team extensions. Discovery computes trust state and hash/provenance before execution. The loader skips untrusted and changed project/team extensions without importing them.

### Key Decisions

1. Use explicit per-extension trust records keyed by project-team extension identity plus SHA-256 content hash. The coarse `extensions.trustProjectExtensions` boolean remains in config for compatibility and stripping tests, but it must not be a trust-all path for loading project/team code.
2. Represent trust as a richer state. Expand the engine trust type to include `not-required`, `untrusted`, `trusted`, and `changed` (or add an equivalent `trustState` field while preserving existing `trust` for compatibility). User, project-local, and external explicit paths do not require project/team trust.
3. Hash before execution. File-layout extensions hash the resolved entrypoint file. Directory-layout extensions hash a stable sorted manifest of relevant files in the extension directory, including `package.json` and supported source files (`.ts`, `.mts`, `.js`, `.mjs`), excluding `node_modules/`, `dist/`, `.git/`, and other generated/heavy directories.
4. Changed project/team extensions are skipped until re-trusted. A trust record whose stored hash differs from the current hash yields a changed trust state and a stable diagnostic such as `extension:trust-changed`.

## Scope

### In Scope

- Trust-store module under `packages/engine/src/extensions/` with:
  - schema/versioned JSON parsing and tolerant handling of missing or malformed files,
  - deterministic write with parent directory creation,
  - helper to upsert a trust record from a discovered project/team candidate,
  - helper to remove a trust record by candidate identity,
  - exported types for records and trust metadata.
- Hashing helper under `packages/engine/src/extensions/` with deterministic SHA-256 hashing for file and directory layouts.
- Type updates in `packages/engine/src/extensions/types.ts` for trust state, current hash, trusted hash, trusted timestamp/source, trust identity, and trust-store path metadata.
- Discovery changes in `packages/engine/src/extensions/discovery.ts`:
  - compute hash/provenance for project-team candidates,
  - read `.eforge` trust metadata once per discovery call,
  - classify project-team candidates as untrusted, trusted, or changed,
  - classify user/project-local/external candidates as not requiring project trust,
  - preserve precedence, shadowing, include/exclude, and explicit path behavior.
- Loader changes in `packages/engine/src/extensions/loader.ts`:
  - skip untrusted and changed project/team candidates before `importExtension`,
  - emit stable diagnostics with name/path/scope/source/hash details,
  - keep missing-entrypoint and factory diagnostics behavior intact.
- Projection/replay updates in `packages/engine/src/extensions/projector.ts` and `packages/engine/src/extensions/replay.ts` so trust/hash/provenance metadata is retained in engine projections and replay/test result construction.
- Tests in `test/extension-discovery.test.ts`, `test/extension-loader.test.ts`, and a new focused trust-store/hash test file.

### Out of Scope

- Daemon HTTP routes, CLI commands, MCP/Pi tools, and user documentation. Those are handled by later plans.
- Package manifest conventions, npm install, git install, or package-level trust policy.
- Sandboxing extension execution.

## Files

### Create

- `packages/engine/src/extensions/trust-store.ts` — local trust record schema, read/write/upsert/remove helpers, candidate identity helpers, and trust-store path resolution.
- `packages/engine/src/extensions/hash.ts` — deterministic content hashing for file and directory extension units.
- `test/extension-trust-store.test.ts` — trust-store parsing, write, upsert/remove, and malformed-file behavior.
- `test/extension-hash.test.ts` — hash determinism and change detection for file and directory layouts.

### Modify

- `packages/engine/src/extensions/types.ts` — extend trust state and candidate metadata types.
- `packages/engine/src/extensions/discovery.ts` — evaluate trust records and hashes during discovery.
- `packages/engine/src/extensions/loader.ts` — enforce changed/untrusted skip before import.
- `packages/engine/src/extensions/projector.ts` — include trust/hash/provenance metadata in projections.
- `packages/engine/src/extensions/replay.ts` — propagate trust metadata into replay/test extension entries.
- `packages/engine/src/extensions/index.ts` — export trust-store/hash helpers needed by daemon management routes.
- `test/extension-discovery.test.ts` — update existing trust tests and add changed-hash discovery cases.
- `test/extension-loader.test.ts` — update coarse-trust expectations and add no-import checks for untrusted/changed project-team extensions.
- `test/config.test.ts` — keep/extend assertions that project/team config and profiles cannot set coarse trust.

## Verification

- [ ] `discoverNativeExtensions` returns a project-team candidate with `trust`/trust-state `untrusted` and a current SHA-256 hash when no trust record exists.
- [ ] After inserting a matching `.eforge/extension-trust.json` record, discovery returns the same project-team candidate as trusted with matching current and trusted hashes.
- [ ] After changing a trusted project-team extension file, discovery returns the candidate as changed and exposes both the old trusted hash and new current hash.
- [ ] `loadNativeExtensions` never calls `importExtension` for untrusted or changed project-team candidates and reports `extension:untrusted` or `extension:trust-changed` diagnostics.
- [ ] User, project-local, and external explicit extension paths keep loading without a project/team trust record.
- [ ] Directory hashes change when a supported source file or `package.json` changes and remain equal when excluded `node_modules/` or `dist/` files change.
- [ ] Project/team `extensions.trustProjectExtensions: true` from committed config/profile layers remains stripped by existing config protections.