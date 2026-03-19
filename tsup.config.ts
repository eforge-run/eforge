import { defineConfig } from "tsup";
import { cp } from "node:fs/promises";

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
    entry: ["src/monitor/server-main.ts"],
    format: ["esm"],
    target: "node22",
    clean: false,
    dts: false,
    external: [],
    outDir: "dist",
  },
]);
