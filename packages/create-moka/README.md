# create-moka

[![npm](https://img.shields.io/npm/v/create-moka?color=c2703d)](https://www.npmjs.com/package/create-moka)

Scaffold a shareable [Moka](https://www.npmjs.com/package/@mokalabs/sandbox) demo: a project anyone can clone and run with one command.

```bash
npm create moka@latest my-demo
cd my-demo && npm install && npm start
```

Also `pnpm create moka`, `yarn create moka` or `bun create moka`. Add `--yes` to skip the questions.

You get:

- `moka.json` with a model, MCP servers and a workspace with starter prompts. API keys are read from the environment (`env:OPENAI_API_KEY`), so the file is safe to commit.
- Two example [Agent Skills](https://mokalabs.dev/guides/skills/) in `skills/`.
- `.env.example`, `.gitignore`, and `npm start` to open Moka.

Edit everything in Moka's settings, then commit and share. Anyone with the repo runs `npm install && npm start` and gets the same demo.

[Docs](https://mokalabs.dev) · [GitHub](https://github.com/mokahq/mokalabs) · MIT
