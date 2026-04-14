/**
 * Shared helpers for the eforge lockstep version scheme.
 *
 * All public @eforge-build/* packages ship at the same version. The version
 * in packages/eforge/package.json is the source of truth; the other lockstep
 * packages are kept in sync by propagation (done once in git before tagging,
 * and again at publish time as a safety net).
 */

import { readFileSync, writeFileSync } from "node:fs";

export const SOURCE_OF_TRUTH = "packages/eforge/package.json";

export const LOCKSTEP_PACKAGE_PATHS = [
  "packages/client/package.json",
  "packages/engine/package.json",
  "packages/monitor/package.json",
  "packages/pi-eforge/package.json",
];

export const ALL_PACKAGE_PATHS = [SOURCE_OF_TRUTH, ...LOCKSTEP_PACKAGE_PATHS];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readSourceVersion() {
  const pkg = readJson(SOURCE_OF_TRUTH);
  if (!pkg.version) {
    throw new Error(`Missing version in ${SOURCE_OF_TRUTH}`);
  }
  return pkg.version;
}

export function propagateVersion(version, { log = console.log } = {}) {
  for (const path of LOCKSTEP_PACKAGE_PATHS) {
    const pkg = readJson(path);
    if (pkg.version !== version) {
      log(`  ${path}: ${pkg.version} -> ${version}`);
      pkg.version = version;
      writeJson(path, pkg);
    } else {
      log(`  ${path}: already at ${version}`);
    }
  }
}

export function verifyAllAtVersion(version) {
  for (const path of ALL_PACKAGE_PATHS) {
    const pkg = readJson(path);
    if (pkg.version !== version) {
      throw new Error(
        `Version mismatch: ${path} is ${pkg.version}, expected ${version}`,
      );
    }
  }
}

export function bumpSemver(version, bumpType) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  const [maj, min, pat] = parts;
  switch (bumpType) {
    case "major": return `${maj + 1}.0.0`;
    case "minor": return `${maj}.${min + 1}.0`;
    case "patch": return `${maj}.${min}.${pat + 1}`;
    default: throw new Error(`Unknown bump type: ${bumpType}`);
  }
}
