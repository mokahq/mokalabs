# @mokalabs/sandbox

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

### Patch Changes

- [#12](https://github.com/mokahq/mokalabs/pull/12) [`97ec4bc`](https://github.com/mokahq/mokalabs/commit/97ec4bcf7bac45fb91534386ed5644dcf2127a67) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - `@mokalabs/sandbox` now ships as a single self-contained package with zero runtime dependencies. Everything (including `@mokalabs/core`) is bundled at build time from the repo's 14-day-vetted lockfile, so `npx @mokalabs/sandbox` installs exactly one package — nothing floats to freshly published versions, and it works behind curated/quarantined registries.

## 0.1.1

### Patch Changes

- [#10](https://github.com/mokahq/mokalabs/pull/10) [`b2d6ac7`](https://github.com/mokahq/mokalabs/commit/b2d6ac703737ee143842bb69ee31cc4f657d4914) Thanks [@thebunnyweb](https://github.com/thebunnyweb)! - Dependencies now resolve only to releases at least 14 days old (MCP SDK floor lowered to 1.30.0), so installs work behind curated/quarantined registries.
- Updated dependencies [[`b2d6ac7`](https://github.com/mokahq/mokalabs/commit/b2d6ac703737ee143842bb69ee31cc4f657d4914)]:
  - @mokalabs/core@0.1.1
