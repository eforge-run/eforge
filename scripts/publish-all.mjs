#!/usr/bin/env node

/**
 * Build, test, stage, and publish @eforge-build/eforge + @eforge-build/eforge-pi.
 *
 * Usage:
 *   pnpm publish-all            # full publish
 *   pnpm publish-all --dry-run  # build + stage + npm pack (no publish)
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function tryRun(cmd) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch {
    console.log(`  (command failed - this is OK for first-time publishes)`);
  }
}

// 1. Build and test
run("pnpm build");
run("pnpm -r type-check");
run("pnpm test");

// 2. Stage both packages
run("node scripts/prepare-eforge-publish.mjs");
run("node scripts/prepare-eforge-pi-publish.mjs");

// Sanity check
for (const dir of ["tmp/eforge-publish", "tmp/pi-package-publish"]) {
  if (!existsSync(dir)) {
    console.error(`Stage directory ${dir} not found`);
    process.exit(1);
  }
}

if (dryRun) {
  // 3a. Dry run - pack but don't publish
  console.log("\n--- DRY RUN: packing tarballs ---\n");
  run("npm pack --dry-run", { cwd: "tmp/eforge-publish" });
  run("npm pack --dry-run", { cwd: "tmp/pi-package-publish" });
  console.log("\nDry run complete. No packages published.");
} else {
  // 3b. Publish
  console.log("\n--- Publishing ---\n");
  run("npm publish", { cwd: "tmp/eforge-publish" });
  run("npm publish", { cwd: "tmp/pi-package-publish" });

  // 4. Deprecate old names (may fail if you don't own the old packages)
  tryRun('npm deprecate eforge "Renamed to @eforge-build/eforge. Install with: npm install -g @eforge-build/eforge"');
  tryRun('npm deprecate eforge-pi "Renamed to @eforge-build/eforge-pi. Install with: npm install -g @eforge-build/eforge-pi"');

  // 5. Verify
  tryRun("npm view @eforge-build/eforge version");
  tryRun("npm view @eforge-build/eforge-pi version");

  console.log("\nPublish complete.");
}
