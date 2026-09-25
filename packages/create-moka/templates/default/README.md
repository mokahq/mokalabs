# Moka demo

A ready-to-run [Moka](https://github.com/thebunnyweb/mokalabs) sandbox: any LLM, MCP servers and skills, with a live inspector.

```bash
npm install
export OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY / GEMINI_API_KEY, or run Ollama
npm start
```

- `moka.json` holds models, MCP servers, skills and workspaces. Commit it; keys stay in env vars (`env:NAME`).
- `skills/` holds Agent Skills (`SKILL.md` + reference files).
- Change anything from **Settings** in the UI; it writes back to `moka.json`.
