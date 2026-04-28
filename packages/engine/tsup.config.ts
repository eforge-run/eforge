import { defineConfig } from "tsup";
import { existsSync } from "node:fs";
import { cp, readdir, readFile, writeFile } from "node:fs/promises";
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
  },
});
