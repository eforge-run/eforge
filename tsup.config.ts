import { defineConfig } from "tsup";
import { cp } from "node:fs/promises";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  external: ["@anthropic-ai/claude-agent-sdk"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  async onSuccess() {
    await cp("src/engine/prompts", "dist/prompts", { recursive: true });
  },
});
