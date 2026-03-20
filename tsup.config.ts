import { defineConfig } from "tsup";
import { cp, readFile, writeFile } from "node:fs/promises";
import { globSync } from "node:fs";

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
    external: ["@anthropic-ai/claude-agent-sdk"],
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
  },
]);
