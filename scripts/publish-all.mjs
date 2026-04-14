#!/usr/bin/env node

/**
 * Build, test, and publish all public @eforge-build/* packages in lockstep.
 *
 * Version source of truth: packages/eforge/package.json
 *   - Hand-edit that file's version, then run this script.
 *   - The version is propagated to client, engine, monitor, and pi-eforge.
 *   - pnpm -r publish rewrites workspace:* refs to concrete versions and
 *     skips packages marked "private": true (currently monitor-ui).
 *
 * Usage:
 *   pnpm publish-all            # full publish
 *   pnpm publish-all --dry-run  # build + stage + pnpm publish --dry-run
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

const LOCKSTEP_PACKAGE_PATHS = [
  "packages/client/package.json",
  "packages/engine/package.json",
  "packages/monitor/package.json",
  "packages/pi-eforge/package.json",
];
const SOURCE_OF_TRUTH = "packages/eforge/package.json";

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// 1. Propagate the lockstep version from packages/eforge/package.json.
const sourcePkg = readJson(SOURCE_OF_TRUTH);
const targetVersion = sourcePkg.version;
if (!targetVersion) {
  throw new Error(`Missing version in ${SOURCE_OF_TRUTH}`);
}
console.log(`\nLockstep version: ${targetVersion} (from ${SOURCE_OF_TRUTH})`);

for (const path of LOCKSTEP_PACKAGE_PATHS) {
  const pkg = readJson(path);
  if (pkg.version !== targetVersion) {
    console.log(`  ${path}: ${pkg.version} -> ${targetVersion}`);
    pkg.version = targetVersion;
    writeJson(path, pkg);
  } else {
    console.log(`  ${path}: already at ${targetVersion}`);
  }
}

// 2. Verify everything matches.
const allPaths = [SOURCE_OF_TRUTH, ...LOCKSTEP_PACKAGE_PATHS];
for (const path of allPaths) {
  const pkg = readJson(path);
  if (pkg.version !== targetVersion) {
    throw new Error(
      `Version mismatch after propagation: ${path} is ${pkg.version}, expected ${targetVersion}`,
    );
  }
}

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
