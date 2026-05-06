import { defineConfig } from "tsup";
import { existsSync } from "node:fs";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
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

export default defineConfig({
  entry: globSync("src/**/*.ts"),
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: true,
  external: [/^@eforge-build\//],
  define: { EFORGE_VERSION: JSON.stringify(resolveBuildVersion(version)) },
  async onSuccess() {
    // node:sqlite prefix is stripped by esbuild; restore it after build
    const files = await readdir("dist");
    for (const f of files) {
      if (!f.endsWith(".js")) continue;
      const path = `dist/${f}`;
      const content = await readFile(path, "utf-8");
      if (content.includes('from "sqlite"')) {
        await writeFile(path, content.replace(/from "sqlite"/g, 'from "node:sqlite"'));
      }
    }
    // Copy monitor-ui dist into monitor's dist for serving
    if (existsSync("../monitor-ui/dist")) {
      await cp("../monitor-ui/dist", "dist/monitor-ui", { recursive: true });
    }
  },
});
