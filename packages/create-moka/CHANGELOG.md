# create-moka

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
