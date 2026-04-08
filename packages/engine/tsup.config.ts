import { defineConfig } from "tsup";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { globSync } from "node:fs";

export default defineConfig({
  entry: globSync("src/**/*.ts"),
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: true,
  external: [
    "@anthropic-ai/claude-agent-sdk",
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-ai",
    "@sinclair/typebox",
  ],
  async onSuccess() {
    if (existsSync("src/prompts")) {
      await cp("src/prompts", "dist/prompts", { recursive: true });
    }
  },
});
