# Configuration reference

Moka reads a single JSON file. Lookup order: `--config <file>`, then `$MOKA_CONFIG`, then `./moka.json`, then `~/.moka/config.json`.
Add `"$schema": "https://unpkg.com/@mokalabs/sandbox/dist/moka.schema.json"` for editor autocompletion.

Every string that holds a secret or URL supports environment references:

| Syntax | Meaning |
|---|---|
| `env:NAME` | The whole value is `$NAME` |
| `${NAME}` | Interpolate `$NAME` inside a larger string, e.g. `Bearer ${TOKEN}` |

## `llms[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique, referenced by workspaces |
| `name` | string | Display name |
| `provider` | `openai` \| `anthropic` \| `google` \| `azure` \| `ollama` \| `openai-compatible` | |
| `model` | string | Model id, or the deployment name for Azure |
| `apiKey` | string? | Literal or `env:NAME` |
| `baseURL` | string? | Required for `openai-compatible`; optional override for the others |
| `headers` | object? | Extra HTTP headers on every request |
| `resourceName`, `apiVersion` | string? | Azure only |
| `useChatApi` | boolean? | OpenAI only: use Chat Completions instead of Responses |
| `temperature` | number? | 0–2 |
| `maxOutputTokens` | number? | |
| `providerOptions` | object? | Passed through as AI SDK `providerOptions`, e.g. `{ "openai": { "reasoningEffort": "low" } }` |

## `mcpServers[]`

| Field | Type | Notes |
|---|---|---|
| `id`, `name` | string | |
| `transport` | `stdio` \| `http` \| `sse` | `http` = Streamable HTTP |
| `command`, `args`, `env`, `cwd` | | stdio only. `env` is merged over a safe default environment |
| `url`, `headers` | | http / sse only |
| `disabledTools` | string[]? | Hidden from the model, still callable from the Tools view |
| `timeoutMs` | number? | Connect timeout (default 30 s); tool calls default to 120 s |

`"command": "moka:demo"` refers to the demo server bundled with Moka.

## `skills[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `path` | string? | A folder containing `SKILL.md`, or a path to the file. Relative paths resolve against the config file's folder; `~` is expanded |
| `content` | string? | Inline `SKILL.md` instead of `path` |
| `name`, `description` | string? | Override the frontmatter |

## `workspaces[]`

| Field | Type | Notes |
|---|---|---|
| `id`, `name` | string | |
| `llmId` | string? | Defaults to the first model |
| `mcpServerIds`, `skillIds` | string[] | What's enabled in this workspace |
| `systemPrompt` | string? | |
| `starterPrompts` | string[]? | One-click prompts on an empty chat |
| `maxSteps` | number? | Max model ↔ tool round trips per message (default 12) |
| `generativeUi` | boolean? | Offer the built-in `render_ui` (A2UI) tool (default true) |

## Environment variables

| Variable | |
|---|---|
| `PORT`, `MOKA_HOST` | Listen address |
| `MOKA_TOKEN` | Fixed access token |
| `MOKA_CONFIG` | Config file path |
| `MOKA_HOME` | Data directory (default `~/.moka`) for the default config and chat sessions |
| `MOKA_NO_OPEN=1` | Don't open a browser |
| `OLLAMA_HOST` | Where to look for Ollama on first run |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY`, `AZURE_API_KEY` + `AZURE_RESOURCE_NAME`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY` | Detected on first run |
