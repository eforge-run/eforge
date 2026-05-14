---
id: plan-03-extension-docs-and-reference
name: Extension Documentation and Generated Reference
branch: add-extension-discovery-config-and-loader/plan-03-extension-docs-and-reference
agents:
  builder:
    effort: medium
    rationale: Documentation and generated reference synchronization across docs and
      web mirrors.
  reviewer:
    effort: medium
    rationale: Docs/API review is needed to prevent drift between runtime behavior,
      config reference, and integration surfaces.
---

# Extension Documentation and Generated Reference

## Architecture Context

The first two plans add the runtime foundation and tooling. This plan updates human-facing and agent-facing documentation so users understand the config shape, discovery rules, loader strategy, trust model, provenance output, and current runtime limitations. Generated reference artifacts must be refreshed after CLI/API/config/MCP/Pi changes.

## Implementation

### Overview

Update conceptual docs, API docs, config docs, SDK README, examples, root README, and public web docs. Run `pnpm docs:generate` after code changes so reference docs, schema JSON, MCP/Pi tool tables, API route tables, CLI reference, and LLM artifacts include the new extension surfaces.

### Key Decisions

1. Document that TypeScript and JavaScript extension modules execute in the eforge daemon/worker Node process without a sandbox.
2. Document the MVP trust gate: user and project-local extensions load when enabled; project/team extensions require `extensions.trustProjectExtensions: true`.
3. Document that loader/registry capture is available, while event dispatch and blocking/runtime capability execution remain future phases.
4. Distinguish native eforge extensions from Claude Code plugins, Pi extensions, shell hooks, playbooks, session plans, and profile toolbelts.
5. Regenerate reference docs rather than editing generated route, CLI, config schema, and tools reference output by hand.

## Scope

### In Scope

- Runtime support docs for discovery, layouts, config keys, loader strategy, diagnostics, statuses, registration summaries, and trust.
- SDK API docs for any `registerTool` addition and loader-time registration capture.
- Example comments updated from "not loaded" to "loaded/recorded, execution deferred" where applicable.
- Root README extension/config overview update.
- Web docs mirrors for extensions, extension API, and configuration guide.
- Generated reference docs and schema artifacts from `pnpm docs:generate`.

### Out of Scope

- `/eforge:extend` scaffold workflow documentation beyond marking it future work.
- Hash-based trust prompts/stores documentation as shipped behavior.
- Event replay testing documentation as shipped behavior.
- Monitor UI documentation for extension pages.

## Files

### Create

- None expected.

### Modify

- `docs/extensions.md` — Add shipped runtime foundation docs: config, discovery layouts, precedence, include/exclude/paths, statuses, diagnostics, trust, loader strategy, provenance tooling, and current limitations.
- `docs/extensions-api.md` — Update runtime status table and API reference for loader-time registration capture and any SDK method additions.
- `docs/config.md` — Add the top-level `extensions` config section with defaults and examples.
- `packages/extension-sdk/README.md` — Align SDK package README with runtime loader support and current limitations.
- `examples/extensions/minimal-event-logger.ts` — Update runtime note to say the factory can be loaded and registration captured; event dispatch remains deferred if not implemented.
- `examples/extensions/protected-paths.ts` — Update runtime note to say policy gate registration can be captured; policy enforcement remains deferred.
- `README.md` — Add a short native extensions mention in configuration/extensibility overview.
- `web/content/docs/extensions.md` — Mirror conceptual extension docs for the public site.
- `web/content/docs/extensions-api.md` — Mirror extension API reference updates for the public site.
- `web/content/docs/configuration.md` — Add practical extension config guidance for the public site.
- `web/content/reference/{api,cli,config,tools}.md` — Regenerated reference output from `pnpm docs:generate`.
- `web/public/reference/{api,cli,config,tools}.md` — Regenerated raw reference mirrors.
- `web/public/schemas/config.schema.json` — Regenerated config schema with `extensions`.
- `web/public/docs/configuration.md` — Regenerated guide mirror after configuration guide changes.
- `web/public/llms.txt` and `web/public/llms-full.txt` — Regenerated agent-facing docs artifacts.

## Verification

- [ ] `docs/extensions.md` documents all three extension directories, precedence, supported file/directory layouts, include/exclude/paths semantics, statuses, diagnostics, and trust defaults.
- [ ] `docs/config.md` includes `extensions.enabled`, `extensions.include`, `extensions.exclude`, `extensions.paths`, and `extensions.trustProjectExtensions` with default values.
- [ ] `docs/extensions-api.md` runtime table states that loader-time registration capture is available and runtime execution for deferred capability families is not active in this slice.
- [ ] SDK README and example comments no longer claim that native extension loading is absent.
- [ ] Public web docs contain the same extension config and trust details as root docs.
- [ ] Generated API reference includes the new extension daemon routes.
- [ ] Generated CLI reference includes `eforge extension` commands.
- [ ] Generated config schema contains the `extensions` top-level field.
- [ ] Generated tools reference includes `eforge_extension` in both MCP and Pi tool tables.
- [ ] `pnpm docs:generate` completes.
- [ ] `pnpm docs:check` passes.