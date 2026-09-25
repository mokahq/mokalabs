---
"@mokalabs/core": minor
"@mokalabs/sandbox": minor
---

**Remote agents, MCP OAuth, elicitation & sampling, attachments and replay.**

- **Remote agents.** New `agents[]` config and `workspace.agentId`: chat with any **A2A** agent (agent card discovery, `message/stream`/`message/send`, context and task continuity, A2UI DataParts, the A2UI extension header) or **AG-UI** agent (text, reasoning, tool calls, state, A2UI in custom events). With `shareTools`, AG-UI agents can call the workspace's MCP tools and render tool as frontend tools, and Moka runs them and continues the run. Agents appear in the model menu and in Compare, and have their own Settings → Agents tab with a card/connection test. New `moka demo-agent` command.
- **MCP OAuth.** Remote servers that need sign-in get a **Sign in** button: discovery, dynamic client registration, PKCE and a loopback callback, with tokens stored in `~/.moka/oauth.json` (0600). Per-server `oauth` settings (client id/secret, scopes, or `false`) and `MOKA_PUBLIC_URL` for non-local hosts.
- **Elicitation & sampling.** Servers can ask the user for input (form and URL modes) and borrow the workspace's model (with approval, or per-server `sampling: "auto" | "deny"`). New demo tools: `order_coffee` and `brainstorm`.
- **Composer.** Attach images and files (picker, paste, drag and drop), attach MCP resources with **@**, and insert MCP prompts with **/**.
- **Replay, export & import.** Replay any saved chat with typing and tool animations and no model calls; export and import chats as JSON.
- New `agent.request` / `agent.event` / `agent.response` inspector events.
