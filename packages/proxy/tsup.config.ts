import { defineConfig } from "tsup";

// The proxy sits between an editor and its MCP server, so it must start fast and
// install nothing extra: its one dependency (jsonc-parser, for `wrap`) is bundled.
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  splitting: true,
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
});
