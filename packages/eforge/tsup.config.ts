import { defineConfig } from "tsup";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  external: [/^@eforge-build\//],
  define: { EFORGE_VERSION: JSON.stringify(version) },
  banner: {
    js: "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
  },
});
