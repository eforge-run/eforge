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
  async onSuccess() {
    if (existsSync("../monitor-ui/dist")) {
      await cp("../monitor-ui/dist", "dist/monitor-ui", { recursive: true });
    }
  },
});
