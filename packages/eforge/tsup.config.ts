import { defineConfig } from "tsup";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

function resolveBuildVersion(semver: string): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim().length > 0;
    return `${semver}${dirty ? "-dirty" : ""} (${sha})`;
  } catch {
    return semver;
  }
}

const eforgeVersion = JSON.stringify(resolveBuildVersion(version));

export default defineConfig([
  {
    // Binary entry: the executable eforge CLI
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node22",
    clean: true,
    dts: false,
    external: [/^@eforge-build\//],
    define: { EFORGE_VERSION: eforgeVersion },
    banner: {
      js: "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
    },
  },
  {
    // Library entry: exports buildEforgeCommand for programmatic use (docs-gen, tests)
    entry: { "cli/index": "src/cli/index.ts" },
    format: ["esm"],
    target: "node22",
    clean: false,
    dts: true,
    external: [/^@eforge-build\//, "commander", "chalk", "ora", "yaml", "zod"],
    define: { EFORGE_VERSION: eforgeVersion },
  },
]);
