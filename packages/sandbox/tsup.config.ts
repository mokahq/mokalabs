import { defineConfig } from "tsup";

// The published CLI bundles ALL of its dependencies (including @mokalabs/core),
// so `npx @mokalabs/sandbox` installs exactly one package with zero transitive
// dependencies. Versions come from the repo's pnpm lockfile, which only admits
// releases at least 14 days old (pnpm-workspace.yaml: minimumReleaseAge).
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  splitting: true,
  // Bundled CommonJS deps call require(); give ESM output a real require.
  banner: {
    js: 'import { createRequire as __mokaCreateRequire } from "node:module"; const require = __mokaCreateRequire(import.meta.url);',
  },
  dts: { entry: { index: "src/index.ts" }, resolve: ["@mokalabs/core"] },
  clean: false,
});
