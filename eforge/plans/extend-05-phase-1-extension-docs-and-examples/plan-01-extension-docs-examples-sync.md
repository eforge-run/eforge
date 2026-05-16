---
id: plan-01-extension-docs-examples-sync
name: Synchronize Extension Docs, Examples, and Validation
branch: extend-05-phase-1-extension-docs-and-examples/plan-01-extension-docs-examples-sync
---

# Synchronize Extension Docs, Examples, and Validation

## Architecture Context

Native extension authoring spans hand-authored repository docs, public web docs, the `@eforge-build/extension-sdk` package README, TypeScript examples, static wiring tests, and generated public artifacts. The current runtime already supports extension discovery/loading, `onEvent` dispatch and replay, `onAgentRun` `promptAppend`, extension management commands, and pre-build `registerProfileRouter` dispatch. Other capability families remain loader-captured but deferred.

This plan keeps those surfaces in one coordinated slice so the documentation matrix, examples, generated mirrors, and tests move together. It must not add `/eforge:extend`, extension enable/disable/promote/demote workflows, policy-gate enforcement, custom tool injection, input-source execution, reviewer perspective execution, or validation provider execution.

## Implementation

### Overview

Update the native extension documentation and examples to match shipped runtime behavior, add a safe Slack/webhook-style event notifier example, import all examples in the SDK smoke test, and regenerate public docs artifacts.

### Key Decisions

1. **Treat `onAgentRun` prompt append and `registerProfileRouter` as shipped runtime behavior.** Code and tests for `agent-context-runtime.ts`, `profile-router-runtime.ts`, and `extension-tooling-wiring.test.ts` already assert these paths, so docs must not describe profile routing as deferred.
2. **Keep deferred families explicit.** Policy gates, custom tools/tool availability, input sources, reviewer perspectives, validation providers, package/install workflows, enable/disable/promote/demote, and `/eforge:extend` remain future/deferred.
3. **Make the Slack notifier safe by default.** The new example must only send a webhook when an environment variable is set, must avoid committing real URLs or tokens, and must log/skip without credentials so import tests and event replay do not require live Slack access.
4. **Sync hand-authored and generated docs in the same plan.** `web/content/docs/*` are public-site source pages; `web/public/docs/*` are raw mirrors generated from them by `pnpm docs:generate`.

## Scope

### In Scope

- Update runtime-support wording and tables across repository docs, public web docs source, and the SDK README.
- Fix contradictory statements that call profile routing or all non-event capabilities deferred while `registerProfileRouter` is documented as runtime-supported.
- Add or update docs for scopes, config fields, discovery precedence, loader strategy, trust/security, lifecycle/loading, statuses/diagnostics/provenance, management commands, replay testing, scaffold templates, examples, limitations, and the extension/toolbelt boundary.
- Add `examples/extensions/slack-webhook-notifier.ts` as an event-oriented notifier example guarded by an env var such as `EFORGE_SLACK_WEBHOOK_URL`.
- Update `examples/extensions/README.md` to list every example with runtime-status labels and validation instructions.
- Update `test/extension-sdk-example.test.ts` to import/type-check every example, including `agent-context.ts` and the new notifier.
- Update static documentation tests so stale runtime-status drift and unavailable workflow claims fail in CI.
- Run `pnpm docs:generate` and commit resulting public docs artifacts.

### Out of Scope

- Implementing `/eforge:extend` in Pi or Claude Code integration packages.
- Implementing `eforge extension enable`, `disable`, `promote`, or `demote`.
- Enforcing policy gates before merge.
- Injecting or executing extension-contributed custom tools.
- Executing input sources, reviewer perspectives, or validation providers.
- Changing extension SDK public TypeScript contracts except doc comments required for consistency.
- Changing plugin package files or plugin versions.

## Files

### Create

- `examples/extensions/slack-webhook-notifier.ts` — event-hook example that formats a Slack-compatible payload for `plan:error:set`, sends only when a webhook env var is present, and logs a credential-free skip when unset.

### Modify

- `docs/extensions.md` — update conceptual guide runtime matrix and prose; document only `event-logger` and `blank` scaffold templates; add/mention notifier example; preserve explicit deferred workflow boundaries and valid event reference link.
- `docs/extensions-api.md` — update API reference runtime-support summary and toolbelt/profile-router prose so `registerProfileRouter` is not later described as future work.
- `docs/config.md` — update native extensions config section with `agentContextHookTimeoutMs` and shipped profile-router runtime support.
- `packages/extension-sdk/README.md` — align quick start, runtime loading, registration table, event replay notes, stability statement, and scaffold-template notes with the docs.
- `examples/extensions/README.md` — list `minimal-event-logger.ts`, `slack-webhook-notifier.ts`, `agent-context.ts`, `profile-router.ts`, and `protected-paths.ts`; mark runtime-supported versus provenance-only/deferred behavior; document targeted validation commands.
- `examples/extensions/minimal-event-logger.ts` — refresh header comments only if needed to keep terminology aligned.
- `examples/extensions/agent-context.ts` — refresh header comments only if needed to mention runtime support and unsupported tool fields.
- `examples/extensions/profile-router.ts` — refresh header comments only if needed to mention pre-build dispatch, explicit-frontmatter precedence, and fail-open behavior.
- `examples/extensions/protected-paths.ts` — refresh header comments only if needed to keep policy-gate deferred status clear.
- `test/extension-sdk-example.test.ts` — import/type-check all example default exports, including `agent-context.ts` and `slack-webhook-notifier.ts`.
- `test/extension-tooling-wiring.test.ts` — add assertions for current runtime matrix, stale phrase removal, notifier docs/example coverage, scaffold template wording, and absence of available `/eforge:extend` or enable/disable/promote/demote claims in user-facing extension docs.
- `web/content/docs/extensions.md` — mirror semantic changes from `docs/extensions.md` with public-site frontmatter and public links.
- `web/content/docs/extensions-api.md` — mirror semantic changes from `docs/extensions-api.md` with public-site frontmatter and public links.
- `web/content/docs/configuration.md` — update native extensions section to match shipped runtime support and config fields.
- `web/public/docs/extensions.md` — regenerate raw mirror from `web/content/docs/extensions.md`.
- `web/public/docs/extensions-api.md` — regenerate raw mirror from `web/content/docs/extensions-api.md`.
- `web/public/docs/configuration.md` — regenerate raw mirror from `web/content/docs/configuration.md`.
- `web/public/llms.txt` and `web/public/llms-full.txt` — commit generator changes if `pnpm docs:generate` updates them.
- Any other file listed by `git diff` after `pnpm docs:generate` — commit only deterministic generated output from the docs generator.

## Verification

- [ ] `examples/extensions/slack-webhook-notifier.ts` imports from `@eforge-build/extension-sdk`, registers `onEvent('plan:error:set', ...)`, reads the webhook URL from an env var, and contains no literal Slack webhook URL or token.
- [ ] `test/extension-sdk-example.test.ts` imports and assigns every `examples/extensions/*.ts` default export to `sdk.EforgeExtensionFactory`.
- [ ] Runtime support tables in `docs/extensions.md`, `docs/extensions-api.md`, `packages/extension-sdk/README.md`, `web/content/docs/extensions.md`, and `web/content/docs/extensions-api.md` contain `registerProfileRouter` with `Yes (pre-build dispatch)`.
- [ ] The same runtime support tables keep `registerTool`, `beforePlanMerge`, `registerInputSource`, `registerReviewerPerspective`, and `registerValidationProvider` marked `Deferred`.
- [ ] User-facing docs do not present `/eforge:extend` or `eforge extension enable|disable|promote|demote` as available commands.
- [ ] `web/public/docs/extensions.md` equals `web/content/docs/extensions.md`; `web/public/docs/extensions-api.md` equals `web/content/docs/extensions-api.md`; `web/public/docs/configuration.md` equals `web/content/docs/configuration.md`.
- [ ] `pnpm test -- test/extension-sdk-example.test.ts test/extension-tooling-wiring.test.ts test/docs-link-check.test.ts test/reference-content.test.ts` passes in an environment with workspace dependencies installed.
- [ ] `pnpm docs:check` passes in an environment with workspace dependencies installed.