# create-moka

## 0.4.0

### Minor Changes

- [#37](https://github.com/mokahq/mokalabs/pull/37) [`7cec2ed`](https://github.com/mokahq/mokalabs/commit/7cec2ed43c3ff6aa878b74c3e4a36686e9ee7623) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - Tool tests, a security check, context budgets, and pages, diagrams and files next to the chat.
  
  **Tool tests.** A new **Tests** view runs prompts on several models at once, several times each, and grades what each model did: tools it had to call, tools it mustn't, arguments (partial match), words in the answer. Results fill a model-by-test grid as runs finish; a cell shows each run's failure reasons, tool calls, answer and a link to the inspector. **Suggest tests** asks the workspace's model to write tests from its tools; **Copy scorecard** copies a Markdown table. Tests are saved in the workspace (`tests` in moka.json) and `moka test [config] --models a,b --runs 3` runs them from the command line, exiting 1 on failure, for CI. By default only tools marked read-only really run (`--tools run|read-only|none`). Core: `runToolTests()`, `grade()`, `suggestTests()`, `engine.runTests()`, and a `toolMode` option for chats.
  
  **Security check.** Every MCP server is checked when it connects: hidden-instruction tags, "don't tell the user", instruction overrides, credentials and secret files, invisible Unicode, sending data away, steering other tools, shadowing (same tool name on two servers, or naming another server's tool), and very long descriptions, in tool, parameter, instruction and prompt text. Moka remembers each server's tools (`~/.moka/tool-pins.json`) and reports tools whose description or schema changed since, with a before/after diff, until you trust them. Findings show as a shield in the sidebar, a section in the server's settings and an inspector event; servers behind the proxy are checked too. Core: `scanServer()`, `ToolPins`, `engine.securityReport()`.
  
  **Context budget.** The empty chat shows how many tokens the workspace's system prompt, skills, server instructions and tool definitions cost on every request; click for a breakdown per server and tool, biggest first, with a switch to hide each tool, and warnings past half of an 8K window or 40 tools. Settings shows each tool's estimate. Core: `contextBudget()`.
  
  **Pages and diagrams in replies.** HTML, SVG and Mermaid that a model writes are shown, not just printed: Mermaid and SVG draw in the chat, a whole HTML page shows as a card and opens next to the chat when the reply finishes, and snippets get a Preview button. Pages run sandboxed; a banner lists the hosts a page loads from, with one click to block them. The preview pane can expand.
  
  **Preview files next to the chat.** Attachments and files returned by tools open in a resizable pane: PDF pages (pdf.js, loaded only when needed), Word documents, HTML, Markdown, CSV, JSON, images, SVG, Mermaid, audio, video and code. Documents a tool makes open on their own. Tool results with images, audio, embedded resources or resource links show as file cards; tool-call chunks now carry `serverId`.
  
  **Attached PDFs and Word files work with every model.** Moka reads their text in the browser when attached. Models that read PDFs (OpenAI, Anthropic, Gemini, Azure) get the PDF; LM Studio, Ollama and other OpenAI-compatible models get its text, and Word files go to every model as Markdown. Before, attaching one to those models failed with "file part media type … not supported", and so did every later message in the chat. Core: `adaptAttachments()`.
  
  **Local models.** LM Studio is detected on first run like Ollama, and Settings → Models offers to add LM Studio or Ollama when they're running but not added. Replies without tool calls show tokens per second, in the chat and in Compare.
  
  **Workspaces in the sidebar.** Chats are grouped by workspace; start a chat in any workspace, or create one with the current model, MCP servers and skills.
  
  Also: the demo server's `create_document` tool writes PDF, Word, HTML or Markdown files; `.mjs` files are served as JavaScript.

### Patch Changes

- [#37](https://github.com/mokahq/mokalabs/pull/37) [`7cec2ed`](https://github.com/mokahq/mokalabs/commit/7cec2ed43c3ff6aa878b74c3e4a36686e9ee7623) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - MCP 2026-07-28. Moka's MCP client moves to the TypeScript SDK v2 (`@modelcontextprotocol/client` 2.2) and speaks the stateless revision as well as 2025-11-25 and earlier.
  
  **Per-server version.** A new `protocol` setting (Settings → MCP servers → Advanced: **MCP version**): `auto` asks the server with `server/discover` and falls back to 2025, `2026` requires 2026-07-28, `2025` keeps the `initialize` handshake. Default: `auto` for HTTP servers and the demo server, `2025` for stdio and SSE. Settings shows the negotiated version as a badge, and `mcp.status` events carry `protocol: { version, era }`.
  
  **Sampling and elicitation inside the call.** On 2026-07-28 a server asks for a completion, a form or roots by answering `tools/call` (or `prompts/get`, `resources/read`) with `input_required`. Moka shows the same approval and form as before, then calls again with the answers, up to 10 rounds. Rejecting a sampling request ends the call in Moka, since a retry can't carry an error back.
  
  **Subscriptions.** On 2026-07-28 servers, list changes and resource updates arrive on one `subscriptions/listen` stream; subscribing to a resource reopens it with the new URI set. 2025 servers still use `resources/subscribe`.
  
  **Inspector and proxy.** `input_required` replies get a badge naming what the server asked for, retried requests show as `round 2 with <keys>` and belong to the original tool call, and the stdio `server/discover` probe (run on a separate copy of the server) is shown in the RPC log. The proxy reads the client's identity and version from 2026-07-28 request `_meta` too, and the proxy view shows the MCP version.
  
  **Demo server.** Built on `@modelcontextprotocol/server` 2.2 with `serveStdio`, it serves both revisions from one codebase: `brainstorm` and `order_coffee` return `input_required`, and the SDK turns that into `sampling/createMessage` and `elicitation/create` requests for 2025 clients.
  
  Also: Moka's MCP errors now distinguish the server's JSON-RPC errors (`ProtocolError`) from local SDK errors (`SdkError`) for "outcome unknown" detection.
  
  Fix: the current workspace in the sidebar can be collapsed too (it was always open). A collapsed workspace opens again when you switch to it or a chat starts in it.

## 0.3.1

### Patch Changes

- [#35](https://github.com/mokahq/mokalabs/pull/35) [`89be29c`](https://github.com/mokahq/mokalabs/commit/89be29c2f8d10cc90eb2aefb81e8641909bdbef5) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Company LLM gateways work.**
  
  - **Gateways that add their own stream events no longer fail every reply.** Some OpenAI-compatible gateways send extra events in the response stream, for example timings at the end (`event: done` with `{"ttft": …, "elapsed_time": …}`) instead of `data: [DONE]`. The reply streamed in, then failed with "Type validation failed". Moka now skips stream events that are neither completion chunks nor errors.
  - **Stream responses on/off, per model.** Turn it off (the model's Advanced options, or `"stream": false`) for gateways that don't stream reliably: Moka asks for the whole reply in one response, and everything else works the same, tool calls included.
  - **Company certificates just work.** Moka trusts the certificates your operating system trusts (macOS keychain, Windows certificate store), like a browser, so gateways with internal certificates connect instead of failing with "self-signed certificate in certificate chain". It loads them at startup on Node 22.19+/24.5+ and restarts once with `--use-system-ca` on Node 22.15+; MCP servers it starts get `NODE_USE_SYSTEM_CA=1`. `--no-system-ca` turns it off.
  - **Azure OpenAI's newer models (GPT-5, o-series) accept token limits.** They reject `max_tokens`; when a gateway says so, Moka retries once with `max_completion_tokens` and keeps using it for that endpoint. This fixes the model **Test** button and the Max output tokens setting for them. Azure's stream shapes (filter results, content-filter chunks) are covered by tests.
  - **Clearer network errors.** Certificate errors say how to fix them (system store or `NODE_EXTRA_CA_CERTS`), and "Fetch models" shows the real reason instead of "fetch failed".
  - **Docs at mokalabs.dev.** The docs build asks GitHub Pages for the site's address, so it works on the custom domain (it was building for `/mokalabs/` and every asset 404'd). Links in the README, the app and the proxy README now point to https://mokalabs.dev.
  - **`npm create moka` installs the current Moka.** New projects depended on `@mokalabs/sandbox@^0.1.0`, which on 0.x means 0.1.x only; they now get the version released with `create-moka`.
  - **npm pages:** new READMEs for all four packages with the feature GIFs, and homepage, issues link and keywords pointing to mokalabs.dev.

## 0.3.0

### Minor Changes

- [#32](https://github.com/mokahq/mokalabs/pull/32) [`1b9dc11`](https://github.com/mokahq/mokalabs/commit/1b9dc118ae6dc6abaa848e5a96f4fced895bca1b) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Moka Proxy: see what your AI editor sends to your MCP servers.**
  
  - **New package: `@mokalabs/proxy`.** A pass-through proxy for MCP servers. It starts the real server, passes every byte through untouched, and records each JSON-RPC message to a session log in `~/.moka/proxy/sessions/`. It never writes to stdout itself and keeps working if the log can't be written.
  - **`npx @mokalabs/proxy wrap`** finds the MCP configs of VS Code / GitHub Copilot, Cursor, Claude Desktop, Claude Code, Windsurf and Gemini (global, plus the project you run it in), shows what it will change and asks first. Only each server's `command` and `args` change; comments and formatting are kept, a backup is saved, and wrapping twice changes nothing. `unwrap` puts them back, `status` shows what's wrapped. `--only`, `--dry-run` and `--yes` work as you'd expect. HTTP servers are skipped for now.
  - **New Proxy tab in Moka.** Clients and their servers in a tree, and each server's traffic as it happens: requests with latencies, **timed out**, **late reply**, **no response** and errors, "VS Code gave up on tools/call [#8](https://github.com/mokahq/mokalabs/issues/8) after 60.0s", and retries of a call whose outcome is unknown ("retry after a timeout: the first call may have run"). Server stderr is there too. Click a row (or use ↑ ↓) for the request and response side by side in a resizable detail pane. The client's name and version come from its `initialize` message. Moka can start before or after the editor.
  - **Export everything recorded** as one JSON file: **Export** in the Proxy tab, or `npx @mokalabs/proxy export [--client] [--name] [--since 24h] [-o file]`. Secrets (tokens, keys, passwords, bearer headers, known key formats) are redacted by default; **Export as recorded** / `--raw` keeps them.
  - `RpcTracker` (core) pairs JSON-RPC requests with their responses, cancellations and "no response" markers; Moka's own connections and proxied sessions now share it.

## 0.2.5

No changes in this release.

## 0.2.4

No changes in this release.

## 0.2.3

No changes in this release.

## 0.2.2

No changes in this release.

## 0.2.1

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.1

### Patch Changes

- [#10](https://github.com/mokahq/mokalabs/pull/10) [`b2d6ac7`](https://github.com/mokahq/mokalabs/commit/b2d6ac703737ee143842bb69ee31cc4f657d4914) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - Dependencies now resolve only to releases at least 14 days old (MCP SDK floor lowered to 1.30.0), so installs work behind curated/quarantined registries.
