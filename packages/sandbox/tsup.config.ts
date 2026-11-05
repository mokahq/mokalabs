import { defineConfig } from "tsup";

// The published CLI bundles ALL of its dependencies (including @mokalabs/core),
// so `npx @mokalabs/sandbox` installs exactly one package with zero transitive
// dependencies. Versions come from the repo's pnpm lockfile, which only admits
// releases at least 14 days old (pnpm-workspace.yaml: minimumReleaseAge).
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
    // Server Studio: the SDK and zod as modules of their own, for servers whose folder has no node_modules.
    "studio/sdk-server": "src/studio/sdk-server.ts",
    "studio/sdk-server-stdio": "src/studio/sdk-server-stdio.ts",
    "studio/zod": "src/studio/zod.ts",
  },
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
