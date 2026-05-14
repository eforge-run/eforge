---
id: plan-04-extension-docs-and-generated-reference
name: Extension Runtime Documentation and Generated Reference
branch: add-extension-discovery-config-and-loader/plan-04-extension-docs-and-generated-reference
agents:
  doc-author:
    effort: high
    rationale: Docs must describe runtime support, trust boundaries, config
      semantics, and distinctions between several extension-adjacent mechanisms.
  reviewer:
    effort: medium
    rationale: Review focuses on documentation accuracy and generated-reference drift.
---

# Extension Runtime Documentation and Generated Reference

## Architecture Context

Plans 01-03 introduce real runtime discovery/loading and user-visible tooling. The existing docs still describe extensions as SDK-only and say loading is not implemented. This plan updates hand-authored docs, example comments, package README text, and generated public reference files so users and agents see the new foundation and its limits.

## Implementation

### Overview

Update extension docs to cover config, scope directories, supported layouts, loader strategy, trust behavior, non-sandboxed execution, statuses, diagnostics, registry capture, and tooling commands. Update config docs and README to distinguish native eforge extensions from Claude Code plugins, Pi extensions, shell hooks, playbooks, and profile toolbelts. Regenerate public reference artifacts after code changes so CLI/API/config/tools references include the new surfaces.

### Key Decisions

1. Document loaded registration capture separately from runtime dispatch; no docs may imply policy gates, profile routing, input adapters, reviewer perspectives, validation providers, or custom tools execute during builds in this slice.
2. Document `trustProjectExtensions: false` as the default for auto-discovered committed project/team extensions and state that extensions run in-process without a sandbox.
3. Keep generated files generated via `pnpm docs:generate`; do not hand-edit generated reference bodies.

## Scope

### In Scope

- Root docs and public web-content docs for native extensions.
- Config documentation for the new top-level `extensions` section.
- Extension SDK README/API updates for any added direct tool registration method.
- Example comments aligned with registration capture and current runtime limits.
- README summary of extension config and CLI visibility.
- Generated reference artifacts from docs generation.

### Out of Scope

- New extension examples beyond small comment or README adjustments.
- `/eforge:extend` scaffold/test/replay workflow docs.
- Hash trust-store UX docs beyond noting it as a future enhancement.

## Files

### Create

- None expected.

### Modify

- `docs/extensions.md` — Runtime guide for discovery, config, loading, statuses, diagnostics, trust, and limitations.
- `web/content/docs/extensions.md` — Public docs-site counterpart with web frontmatter and web-safe links.
- `docs/extensions-api.md` — API reference updates for registration capture, tool registration if added, and runtime support status.
- `web/content/docs/extensions-api.md` — Public docs-site counterpart with web frontmatter and web-safe links.
- `packages/extension-sdk/README.md` — Package README updates for loader-era runtime status and tool registration shape.
- `docs/config.md` — Add documented `extensions:` config block and explain merge/filter/trust semantics.
- `README.md` — Mention native extension scopes/config/tooling in the configuration or standalone CLI section.
- `examples/extensions/minimal-event-logger.ts` — Update runtime comments from SDK-only to loaded/captured status.
- `examples/extensions/protected-paths.ts` — Update policy-gate comments to loaded/captured but not enforced.
- `examples/extensions/README.md` — Update validation/loading notes.
- `web/content/reference/api.md` — Regenerated API reference.
- `web/public/reference/api.md` — Regenerated API reference mirror.
- `web/content/reference/cli.md` — Regenerated CLI reference.
- `web/public/reference/cli.md` — Regenerated CLI reference mirror.
- `web/content/reference/config.md` — Regenerated config reference.
- `web/public/reference/config.md` — Regenerated config reference mirror.
- `web/content/reference/tools.md` — Regenerated tools/skills reference.
- `web/public/reference/tools.md` — Regenerated tools/skills reference mirror.
- `web/public/schemas/config.schema.json` — Regenerated config JSON schema.
- `web/public/llms.txt` — Regenerated LLM manifest.
- `web/public/llms-full.txt` — Regenerated full LLM reference.

## Verification

- [ ] `docs/extensions.md` documents all config fields: `enabled`, `include`, `exclude`, `paths`, and `trustProjectExtensions`.
- [ ] `docs/extensions.md` lists user, project-team, and project-local extension directories and states precedence `project-local > project-team > user`.
- [ ] `docs/extensions.md` states that project/team auto-discovered extensions are skipped unless trusted or explicitly configured.
- [ ] `docs/extensions.md` states that extensions execute in the daemon process without a sandbox.
- [ ] `docs/extensions-api.md` states that registrations are loaded and captured, while execution semantics remain future work for non-loader capabilities.
- [ ] Example comments no longer claim that runtime loading is absent.
- [ ] Generated API reference includes all three extension routes.
- [ ] Generated CLI reference includes the `extension` command group and its three subcommands.
- [ ] Generated tools reference includes `eforge_extension` for both Claude Code and Pi and includes the extension skill pair.
- [ ] Generated config schema includes the top-level `extensions` object.