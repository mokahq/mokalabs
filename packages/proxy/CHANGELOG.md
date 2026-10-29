# @mokalabs/proxy

## 0.5.0

### Minor Changes

- [#42](https://github.com/mokahq/mokalabs/pull/42) [`1bd456f`](https://github.com/mokahq/mokalabs/commit/1bd456f3ec4042ec04ac70e2732b43f5d16f54cc) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Improve: better tool wording, proven on your tests.** In Tests, **Improve** diagnoses why runs fail (wrong tool, missed call, wrong argument, a call that shouldn't happen), has your strongest model propose new descriptions, parameter hints and examples, and verifies each proposal on every test and model plus paraphrased prompts the proposer never sees. A proposal wins only if it passes more often, does no worse on the unseen prompts, breaks no passing test and passes the security check. Review before → after per model with a word diff, then **Try it in Moka** (saved as `toolOverrides` in `moka.json`, undo any time), **Copy changes** as Markdown, or **Copy as code** for the TypeScript SDK and Python FastMCP. `moka improve --models a,b --runs 3 [--apply]` does the same from the command line.
  
  **Record, replay & faults.** Turn on **Record traffic** for a server and its JSON-RPC messages go to `~/.moka/recordings/`. **Replay** (Proxy view) adds a server that answers from a recording, in both MCP revisions; `npx @mokalabs/sandbox mock recording.jsonl` runs it anywhere, and proxy sessions replay too. **Fault injection** adds delays, JSON-RPC errors, tool errors, hangs, crashes and malformed results to chosen tool calls, seeded and marked ⚡ in the inspector.
  
  **Tool tests in CI.** `moka test` gains `--min-pass 0.9` (fail only below a pass rate), `--markdown scorecard.md` (for a job summary or a sticky PR comment) and `--baseline results.json` (the change per model). The docs have a ready-to-copy GitHub Actions workflow.
  
  **See how the model thinks.** Like Copilot or Claude Code, the chat shows the model's reasoning live (**Thinking…**, streaming), then folds it to **Thought for 6s**, before each tool call and the answer. Moka asks for it where the model can reason: OpenAI reasoning summaries, Claude thinking, Gemini 2.5+ thoughts, and `<think>` blocks from local models (Qwen3, DeepSeek-R1) in Ollama and LM Studio. Per model: Settings → Models → **Reasoning** (auto, an effort level, or off).
  
  **Misnamed tool calls.** When a model calls `get_time` but the tool is `moka-demo__get_time` (and it's the only one with that name), Moka runs it and says so in the inspector; calls to tools that don't exist get their own *unknown tool* error. A short formatting hint (Markdown, Mermaid, code fences) is added to the system prompt; `formatHints: false` turns it off.
  
  Also: clicking Moka on the empty chat opens a small about card (version, what's new, docs); the Docker image runs on Node 24.

- [#42](https://github.com/mokahq/mokalabs/pull/42) [`1bd456f`](https://github.com/mokahq/mokalabs/commit/1bd456f3ec4042ec04ac70e2732b43f5d16f54cc) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **The proxy works with HTTP servers.** `wrap` used to skip remote servers ("HTTP servers aren't supported yet"); now each one becomes a local bridge that your editor starts like any local server, and that forwards every message to the real URL, unchanged and recorded for the Proxy tab. Streamable HTTP and HTTP+SSE; VS Code, Cursor, Claude Code, Windsurf and Gemini entry shapes (`url`, `httpUrl`, `serverUrl`). Headers move to `env` (`MOKA_PROXY_HEADER_n`), so tokens aren't in the process list; `${input:…}` still works. Sessions are kept and closed with the editor, and when a server forgets one (idle timeout, restart) the bridge opens a new session and resends the request. `unwrap` restores the original entry exactly. Servers that sign in with OAuth need their credentials as headers. By hand: `npx @mokalabs/proxy --url https://… --header "Authorization: Bearer …"`.

## 0.4.1

### Patch Changes

- [#39](https://github.com/mokahq/mokalabs/pull/39) [`47b3571`](https://github.com/mokahq/mokalabs/commit/47b3571eb4cc76b55e4ac0b0e7bbcdce1f2507f7) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Formatting.** Code is syntax-highlighted wherever Moka shows it (replies, the preview pane, Export, the inspector, JSON tool results), with light and dark themes and a header with the language and a copy button. The `moka.json`, tool-arguments and `SKILL.md` editors highlight as you type. Replies also get GitHub callouts (`> [!NOTE]`…), math (KaTeX: `$…$`, `\(…\)`, `$$…$$`, `\[…\]`), checklists, footnotes, and a short list of inline HTML: color, `mark`, `kbd`, `sub`, `sup`, `u`. Other HTML is dropped. Inter and JetBrains Mono now ship with Moka (before, they were used only if installed). The highlighter (Shiki) and KaTeX load only when needed.

- [#39](https://github.com/mokahq/mokalabs/pull/39) [`47b3571`](https://github.com/mokahq/mokalabs/commit/47b3571eb4cc76b55e4ac0b0e7bbcdce1f2507f7) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - Fixes from the first team rollout.
  
  - **Expired MCP sessions recover.** Streamable HTTP servers that keep sessions (MongoDB's MCP server, for one) forget them when idle or restarted and answer "session not found" (HTTP 404). Moka kept sending the old session, so every call failed until Moka restarted. Now it starts a new session and retries the request once (safe: the server refused it without running it), for tool calls, resources and prompts.
  - **A model that never answers no longer hangs the chat.** If a model or its gateway sends nothing for 5 minutes (or pauses 2 minutes mid-reply), the run ends with an error that says so. Set `timeoutMs` on the model to change it. Time spent running tools or waiting for your approval doesn't count.
  - **Approvals you can't miss.** While a tool waits for your OK, a bar above the message box names it (**Show** scrolls to it) and the tab title reads "(1) Waiting for you".
  - **Approval settings stick.** Saving a server's form no longer resets the per-tool asks/auto switches you'd just changed.
  - **Inspector in its own window.** ↗ in the inspector opens it in a separate window; "Inspect run →" shows runs there. **Dock** (or closing the window) puts it back in the main window.
  - **Add the demo server back.** "Moka demo tools" is in the Add server gallery when it's not configured.
  - **Sampling is easier to find.** The server form shows the Sampling setting next to Tool approval (it was under Advanced), and new setups get a "Brainstorm names for a coffee robot" starter prompt that uses it.
  - The message box no longer shows a scrollbar for a single line when the OS always shows scrollbars.

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
