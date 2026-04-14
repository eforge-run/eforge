#!/usr/bin/env node

/**
 * Bump the lockstep version, propagate across all lockstep package.jsons,
 * commit the bump, and create an annotated tag.
 *
 * Does NOT push. The caller (e.g. the /eforge-release skill) pushes with
 * `git push origin <branch> --follow-tags` once the changelog commit is also
 * in place.
 *
 * Usage: node scripts/bump-version.mjs <patch|minor|major>
 */

import { execSync } from "node:child_process";
import {
  ALL_PACKAGE_PATHS,
  bumpSemver,
  propagateVersion,
  readJson,
  readSourceVersion,
  SOURCE_OF_TRUTH,
  verifyAllAtVersion,
  writeJson,
} from "./lib/lockstep-version.mjs";

const bumpType = process.argv[2];
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("Usage: node scripts/bump-version.mjs <patch|minor|major>");
  process.exit(1);
}

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// Refuse to run with a dirty index, so the `X.Y.Z` commit contains only the
// lockstep package.json bumps (and not whatever else happened to be staged).
const staged = execSync("git diff --cached --name-only", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
if (staged.length > 0) {
  console.error(
    "Refusing to bump: the git index has staged changes. Commit or unstage them first.",
  );
  console.error("Staged files:");
  for (const path of staged) console.error(`  ${path}`);
  process.exit(1);
}

const previous = readSourceVersion();
const next = bumpSemver(previous, bumpType);

// 1. Write next version to source of truth.
const sourcePkg = readJson(SOURCE_OF_TRUTH);
sourcePkg.version = next;
writeJson(SOURCE_OF_TRUTH, sourcePkg);
console.log(`${SOURCE_OF_TRUTH}: ${previous} -> ${next}`);

// 2. Propagate to the other lockstep packages.
propagateVersion(next);

// 3. Verify.
verifyAllAtVersion(next);

// 4. Commit and tag.
run(`git add ${ALL_PACKAGE_PATHS.join(" ")}`);
run(`git commit -m "${next}"`);
run(`git tag -a v${next} -m "v${next}"`);

console.log(`\nBumped ${previous} -> ${next} and tagged v${next}.`);
console.log(`Push with: git push origin HEAD --follow-tags`);
