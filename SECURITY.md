# Security policy

Moka starts local processes (stdio MCP servers) and calls LLM APIs with your credentials, so we take reports seriously.

**Please do not open public issues for vulnerabilities.** Use GitHub's private vulnerability reporting (Security → Report a vulnerability) on this repository. We aim to acknowledge within 3 business days.

## Threat model and defaults

- The server binds to `127.0.0.1` and requires a random per-run token (`x-moka-token`) on every `/api` call. `--host 0.0.0.0` and `--no-auth` are explicit opt-ins.
- Anyone with the token can run arbitrary commands via stdio MCP servers. That's by design, as with Claude Desktop or Cursor. Don't expose Moka to untrusted networks.
- `env:NAME` / `${NAME}` references are resolved in memory and never persisted. Literal keys you paste into the UI *are* written to your config file with `0600` permissions.
- Config exports from the UI redact literal keys and sensitive-looking headers/env values.
- Skill files are read only from inside the skill's folder (path traversal is rejected).
