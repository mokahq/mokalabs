# Contributing to Moka

Thanks for helping! Moka is a pnpm monorepo:

```
packages/
  core/          @mokalabs/core    headless engine (providers, MCP, skills, agent loop, events)
  sandbox/       @mokalabs/sandbox CLI + Hono server (src/) and React UI (web/)
  create-moka/   create-moka       zero-dependency scaffolder + templates
```

## Setup

```bash
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm build             # core → sandbox (UI + server) → schema
pnpm dev               # API on :4000 (no auth) + Vite on :5173 with HMR
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the Moka server.

## Checks

```bash
pnpm typecheck
pnpm test              # vitest (core + sandbox e2e) and node:test (create-moka)
```

The sandbox e2e suite boots a real server, the bundled demo MCP server (stdio) and a fake OpenAI-compatible LLM, so you don't need API keys.

## Changesets

Any user-facing change needs a changeset:

```bash
pnpm changeset
```

All packages are versioned together. See [docs/releasing.md](docs/releasing.md).

## Guidelines

- Keep `@mokalabs/core` UI-agnostic; the server should stay a thin HTTP layer.
- Every new capability should show up in the inspector (emit an event on `engine.bus`).
- UI: Tailwind tokens from `web/src/styles.css`, and both themes must look right.
- No telemetry, ever.
