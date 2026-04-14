#!/usr/bin/env node

/**
 * Build, test, and publish all public @eforge-build/* packages in lockstep.
 *
 * Version source of truth: packages/eforge/package.json
 *   - Bump via `pnpm release patch|minor|major` (bumps + tags + commits), or
 *     hand-edit the source of truth before running this script.
 *   - On publish, the source-of-truth version is re-propagated to the other
 *     lockstep packages as a safety net.
 *   - pnpm -r publish rewrites workspace:* refs to concrete versions and
 *     skips packages marked "private": true (currently monitor-ui).
 *
 * Usage:
 *   pnpm publish-all            # full publish
 *   pnpm publish-all --dry-run  # build + stage + pnpm publish --dry-run
 */

import { execSync } from "node:child_process";
import {
  propagateVersion,
  readSourceVersion,
  SOURCE_OF_TRUTH,
  verifyAllAtVersion,
} from "./lib/lockstep-version.mjs";

const dryRun = process.argv.includes("--dry-run");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

// 1. Propagate the lockstep version from packages/eforge/package.json.
const targetVersion = readSourceVersion();
console.log(`\nLockstep version: ${targetVersion} (from ${SOURCE_OF_TRUTH})`);
propagateVersion(targetVersion);

// 2. Verify everything matches.
verifyAllAtVersion(targetVersion);

// 3. Build, type-check, test.
run("pnpm -r build");
run("pnpm -r type-check");
run("pnpm test");

// 4. Publish (or dry-run). pnpm -r publish:
//   - publishes workspace packages in topological dependency order
//   - rewrites workspace:* to the concrete version of the target package
//   - auto-skips packages with "private": true (monitor-ui)
//   - --no-git-checks lets CI publish from a detached HEAD on a tag
const publishArgs = [
  "pnpm -r publish",
  "--access public",
  "--no-git-checks",
  dryRun ? "--dry-run" : "",
]
  .filter(Boolean)
  .join(" ");

console.log(dryRun ? "\n--- DRY RUN ---" : "\n--- Publishing ---");
run(publishArgs);

if (!dryRun) {
  console.log(`\nPublish complete. All @eforge-build/* packages at ${targetVersion}.`);
} else {
  console.log("\nDry run complete. No packages published.");
}
