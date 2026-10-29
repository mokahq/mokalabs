# @mokalabs/core

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

## 0.2.5

### Patch Changes

- [#30](https://github.com/mokahq/mokalabs/pull/30) [`ef296fd`](https://github.com/mokahq/mokalabs/commit/ef296fd6ad9b5a8041cfd3041c17987223102b0f) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Retry lineage, and tool arguments from model to server.** When the model calls the same tool again with the same arguments, Moka now treats it as another attempt of the same call, not a new one. Thanks to u/Tariq9977 on Reddit for the idea.
  
  - **One lineage per call.** Attempts share a lineage id (the first attempt's tool call id), matched by a fingerprint of the server, tool, input schema and normalized arguments. It's on `tool.call`, `tool.result` and `tool.error` events (`data.lineage`) and in the trace download.
  - **Error classes.** Every failed tool call gets `errorClass`: `timeout`, `cancelled`, `transport`, `protocol`, `tool`, `declined`, `input` or `other`.
  - **"Did the write land?"** When a tool that may write fails with a timeout, cancellation or broken connection, the call is marked **outcome unknown**. If a retry then succeeds, it's flagged **may have run twice**. A repeat of a write that already succeeded is still **same call again**; a retry after a clear error isn't a warning.
  - **Attempts in the inspector.** Open any attempt, or its raw `tools/call`, to see every attempt with its outcome, duration and request, linked to the RPC log. Raw `tools/call` messages, cancellations and late replies now carry `rpc.callId`, the tool call they belong to.
  - A late reply to a request Moka already gave up on no longer shows up a second time as an "unknown message ID" error; it's in the RPC log as a late reply.
  - **Idempotent tools.** Tools marked `idempotentHint` aren't flagged when the model repeats them: no "same call again" or "may have run twice", just "attempt 2 (idempotent)".
  - **Arguments: model → server.** Open a tool call in the inspector to see its arguments exactly as the model streamed them, as Moka parsed them, and as the server received them in `tools/call`, with differences listed by path. Broken or truncated JSON from the model is shown as such (error class `input`; nothing is sent). New on `tool.call`: `rawInput` and `invalid`.
  - **The model is told too.** When a write's outcome is unknown, the error the model gets ends with "the tool may have run. Check whether it did before retrying", so it no longer reports a save as failed when it may have worked.
  - **Crashed servers come back.** A server that closes the connection after working (it exited or crashed) is now **disconnected** (amber), not "Could not connect". Moka starts it again on the next tool call, even in the middle of a turn, so a retry really retries, and the Tools page reconnects it by itself.
  - **Demo server:** new read-only `read_notes` tool, so the model can check whether `flaky_write` saved the note before retrying.
  - **Run a message again.** Hover a message you sent to see when you sent it, copy it, or run it again (on an earlier message, it replaces the replies after it). **↑** in an empty message box brings back your last message to edit.
  - With Moka branding off, the default "What is Moka…" starter prompt is hidden.
  - "1 step" instead of "1 steps" under a reply.
  - The inspector's detail view now opens scrolled to the top for each event.

## 0.2.4

### Patch Changes

- [#22](https://github.com/mokahq/mokalabs/pull/22) [`1b45b4b`](https://github.com/mokahq/mokalabs/commit/1b45b4b229bbc8d5f215fed7bb4026f92971fe21) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Slow tools, a puppy, and a way to turn Moka branding off.**
  
  - **Progress.** Moka now asks every tool call for progress (`progressToken`). While a tool runs, its card shows a progress bar with the server's message and a clock, and a new `tool.progress` event lands in the inspector. Raw `notifications/progress` messages are linked to their request.
  - **Tool timeouts per server** (Advanced → Slow tools): the Moka default (2 minutes, progress restarts the timer), a preset that behaves like clients on the MCP SDK defaults (60 seconds, progress doesn't help), or custom values. New config fields: `toolTimeoutMs`, `resetTimeoutOnProgress`, `maxTotalTimeoutMs`.
  - **See when the client gives up.** A timeout gets a **timed out** badge on the request, a "Moka gave up on tools/call [#7](https://github.com/mokahq/mokalabs/issues/7) after 60.0s (timeout)" marker (`rpc.reason: "timeout"`), and a clear tool error instead of the SDK's generic one.
  - A final progress update that arrives together with the result (the MCP SDK drops it) is no longer reported as an error.
  - **Demo server:** new `slow_backtest` tool, a simulated 90-second backtest that reports progress every second.
  - **Moka is a puppy now.** A front-facing pup with a coffee cup replaces the dino as the header logo and on the empty chat, where its eyes follow your cursor, hovering pets it and a click plays peekaboo. The chat itself stays neutral: a spinner while the model thinks and a plain progress bar for tools. The favicon, docs, README and brand kit switch to the puppy too, with a new tagline: *Good pup. Strong brew.*
  - **"Moka branding" preference** (Settings → Config file → Preferences, or `"ui": { "branding": false }`): hides the puppy, the Moka name (header, empty chat, composer, tab title) and the star line, in the app and the terminal, for a neutral chat when you demo your own product.
  - **"Animate Moka" preference** (Settings → Config file → Preferences, or `"ui": { "animations": false }`): stops the puppy moving. The OS "reduce motion" setting does the same.

## 0.2.3

### Patch Changes

- [#20](https://github.com/mokahq/mokalabs/pull/20) [`675ccb1`](https://github.com/mokahq/mokalabs/commit/675ccb190a9130e9f48f521134a08aaa6ea4a6b6) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Trace correlation: which response belongs to which request, and which node did what.**
  
  - **Request ↔ response pairing.** Every JSON-RPC response is matched to its request by id, in both directions. Requests in the inspector show their latency, or **error**, **cancelled**, **cancelled · late reply** or **no response**. Clicking one shows the request and response with their ids side by side. New event fields: `rpc` (`id`, `method`, `pairId`, `outcome`) and response `durationMs`.
  - **No response.** When a connection closes with requests still open, a new `mcp.unanswered` event says which request never got an answer and how long it waited.
  - **Repeated writes.** If the model calls a tool that may write (no `readOnlyHint`) twice in one turn with the same arguments, the second call is flagged: **same call again** on the tool card and a warning in the inspector (`duplicateOf`).
  - **Agent graphs.** AG-UI events are nested under the step (graph node) that emitted them, and finished steps show their duration. Nodes that overlap are labelled, since that grouping is best-effort. New event field: `parentId`.
  - **Demo server:** new `flaky_write` tool (saves a note, then crashes before answering) and `moka://notes` resource, to try interrupted calls. `roll_dice` and `generate_uuid` are now marked read-only.

## 0.2.2

### Patch Changes

- [#18](https://github.com/mokahq/mokalabs/pull/18) [`c7d9880`](https://github.com/mokahq/mokalabs/commit/c7d988039ef65d105ccf542de383e61e0cc89c34) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **See what went over the wire, and help people find Moka.**
  
  - **Headers view.** For HTTP and SSE servers, **Settings → MCP servers** now shows the last request's method, URL, status, timing and every header it actually carried: your configured headers and the ones the client adds (`Authorization` after OAuth, `mcp-session-id`, `mcp-protocol-version`), plus useful response headers such as `WWW-Authenticate`. Secret values and query-string values are masked. Configured headers that weren't sent are flagged.
  - **Clearer HTTP failures.** A rejected request now says what the server answered (`… (HTTP 401)`), and a new `mcp.http` inspector event carries the status, masked headers and auth challenge.
  - **Readable AG-UI traces.** Adapters such as `ag-ui-langgraph` re-emit every framework event as `RAW`. Moka now collapses them into one `AG-UI RAW × N (collapsed)` entry per run (first 200 kept), so steps, tool calls and state stand out.
  - **Star Moka on GitHub**: a small line on the empty chat screen (with a **Hide** link) and in the terminal banner, plus ⌘K commands to star, open the docs or report an issue. Never shown in presenter mode; turn it off for good with `"ui": { "starLink": false }` or **Settings → Config file → Preferences**.
  - Fix: in the headers and environment-variable editors, the value field was squashed to a few pixels, so values couldn't be seen or edited.
  - The README leads with the inspector and shows it in a short GIF.

## 0.2.1

### Patch Changes

- [#14](https://github.com/mokahq/mokalabs/pull/14) [`651ecd8`](https://github.com/mokahq/mokalabs/commit/651ecd8e9af7207b18b6481b0cbe4ce840c9927c) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Resource subscriptions and templates.**
  
  - **Watch resources:** subscribe to a resource (`resources/subscribe`) from the Tools view. Every `notifications/resources/updated` re-reads it live and shows up in the inspector as `resource.updated`. Subscriptions survive reconnects.
  - **Resource templates:** `resources/templates/list` is shown in the Tools view, with a form that expands RFC 6570 URI templates and reads the result.
  - Typing **@** in the chat composer now opens the resource picker, filtered as you type (the @ button still works too).
  - List-changed notifications for tools, prompts and resources now refresh the lists without a reconnect.
  - The demo server gains a live **brew status** resource (changes every 3 seconds, supports subscriptions) and a **coffee drinks** resource template.
  
  **Generative UI fixes.**
  
  - Gemini: the render tool's schema now declares every component prop. Gemini drops arguments that aren't in the schema, which produced UIs missing `children`, `text` and other props.
  - Playground "Ask a model": pick any model, and invalid UI is sent back to the model for up to 3 tries, like in chat.
  - Playground: a bar shows which catalogs the chosen workspace uses, and each one can be turned on or off with a click. When a component comes from a catalog that isn't enabled (`unknown component "Meter"`), the problem says so and offers **Enable it**.
  - "Send to playground" on a catalog component now opens the playground with that component loaded.

## 0.2.0

### Minor Changes

- [#12](https://github.com/mokahq/mokalabs/pull/12) [`97ec4bc`](https://github.com/mokahq/mokalabs/commit/97ec4bcf7bac45fb91534386ed5644dcf2127a67) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Remote agents, MCP OAuth, elicitation & sampling, attachments and replay.**
  
  - **Remote agents.** New `agents[]` config and `workspace.agentId`: chat with any **A2A** agent (agent card discovery, `message/stream`/`message/send`, context and task continuity, A2UI DataParts, the A2UI extension header) or **AG-UI** agent (text, reasoning, tool calls, state, A2UI in custom events). With `shareTools`, AG-UI agents can call the workspace's MCP tools and render tool as frontend tools, and Moka runs them and continues the run. Agents appear in the model menu and in Compare, and have their own Settings → Agents tab with a card/connection test. New `moka demo-agent` command.
  - **MCP OAuth.** Remote servers that need sign-in get a **Sign in** button: discovery, dynamic client registration, PKCE and a loopback callback, with tokens stored in `~/.moka/oauth.json` (0600). Per-server `oauth` settings (client id/secret, scopes, or `false`) and `MOKA_PUBLIC_URL` for non-local hosts.
  - **Elicitation & sampling.** Servers can ask the user for input (form and URL modes) and borrow the workspace's model (with approval, or per-server `sampling: "auto" | "deny"`). New demo tools: `order_coffee` and `brainstorm`.
  - **Composer.** Attach images and files (picker, paste, drag and drop), attach MCP resources with **@**, and insert MCP prompts with **/**.
  - **Replay, export & import.** Replay any saved chat with typing and tool animations and no model calls; export and import chats as JSON.
  - New `agent.request` / `agent.event` / `agent.response` inspector events.

- [#12](https://github.com/mokahq/mokalabs/pull/12) [`97ec4bc`](https://github.com/mokahq/mokalabs/commit/97ec4bcf7bac45fb91534386ed5644dcf2127a67) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - **Generative UI you can shape, tool approvals, and proxy support.**
  
  - **Custom A2UI catalogs.** Add components from a file, a URL or inline JSON: *template* components built from standard ones with `{{prop}}` placeholders, or *HTML* components that run in a sandboxed iframe with a small `window.moka` API (`onProps`, `action`, `update`). MCP servers can ship their own catalog as a resource and reference it by `catalogId`.
  - **Customizable render tool.** `workspace.generativeUi` now takes an object: `toolName`, `catalogIds`, `standard`, `allow`/`deny`, `instructions`, `description`, `examples`, `repair` and a surface `theme` (accent color, radius, font, density, agent name). `true`/`false` still work.
  - **Self-repair.** UI is validated against the active catalogs (unknown components, missing or invalid props, dangling references), and the model gets actionable errors so it can fix its own UI.
  - **Settings → Generative UI.** A catalog browser with live previews, and a playground: edit UI JSON with live validation, ask a model for UI with only the render tool, and see exactly what the model sees.
  - **Tool approvals.** Per-tool and per-server `approval` rules (`auto`/`ask`, and destructive tools ask by default), plus a workspace-wide `requireApproval` safe mode. Approve, deny, allow for the session, or always allow, right in the tool card.
  - **Corporate proxies.** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (or `--proxy`) now route model, MCP and catalog traffic through your proxy (Node 22.21+/24+), and proxy/CA/registry variables are passed to stdio MCP servers.
  - Core: new `InteractionBroker` (`engine.interactions`, `engine.respond()`, `onInteraction`) and `interaction.request`/`interaction.resolved` events.

## 0.1.1

### Patch Changes

- [#10](https://github.com/mokahq/mokalabs/pull/10) [`b2d6ac7`](https://github.com/mokahq/mokalabs/commit/b2d6ac703737ee143842bb69ee31cc4f657d4914) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - Dependencies now resolve only to releases at least 14 days old (MCP SDK floor lowered to 1.30.0), so installs work behind curated/quarantined registries.
