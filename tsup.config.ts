import { defineConfig } from "tsup";
import { cp, readFile, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

// esbuild resolves `node:` protocol imports internally and strips the `node:`
// prefix for newer builtins (like `node:sqlite`) that aren't in its hardcoded
// list. We restore the prefix in a post-tsup build step since tsup runs array
// configs in parallel — onSuccess on one config may fire before others finish.
export async function restoreNodePrefixes() {
  const builtins = ["sqlite"];
  for (const file of globSync("dist/**/*.js")) {
    let content = await readFile(file, "utf8");
    let changed = false;
    for (const mod of builtins) {
      const fixed = content.split(`from "${mod}"`).join(`from "node:${mod}"`);
      if (fixed !== content) {
        content = fixed;
        changed = true;
      }
    }
    if (changed) await writeFile(file, content);
  }
}

export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node22",
    clean: true,
    dts: false,
    external: [
      "@anthropic-ai/claude-agent-sdk",
      "@mariozechner/pi-coding-agent",
      "@mariozechner/pi-agent-core",
      "@mariozechner/pi-ai",
      "@sinclair/typebox",
    ],
    // Force-bundle workspace packages so the CLI executable is self-contained.
    // tsup's default treats `dependencies` as external for Node targets; this
    // override ensures @eforge-build/* workspace packages are inlined into
    // dist/cli.js rather than left as runtime imports.
    noExternal: [/^@eforge-build\//],
    define: { EFORGE_VERSION: JSON.stringify(version) },
    banner: {
      js: "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
    },
    async onSuccess() {
      await cp("src/engine/prompts", "dist/prompts", { recursive: true });
    },
  },
  {
    entry: ["src/engine/index.ts"],
    format: ["esm"],
    target: "node22",
    clean: false,
    dts: false,
    splitting: true,
    outDir: "dist",
    external: [
      "@anthropic-ai/claude-agent-sdk",
      "@mariozechner/pi-coding-agent",
      "@mariozechner/pi-agent-core",
      "@mariozechner/pi-ai",
      "@sinclair/typebox",
      "chalk",
      "commander",
      "langfuse",
      "ora",
      "yaml",
      "zod",
    ],
  },
  {
    entry: ["src/monitor/server-main.ts"],
    format: ["esm"],
    target: "node22",
    clean: false,
    dts: false,
    outDir: "dist",
    // Same self-contained-executable rationale as the CLI entry above.
    noExternal: [/^@eforge-build\//],
  },
]);
