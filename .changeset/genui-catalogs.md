---
"@mokalabs/core": minor
"@mokalabs/sandbox": minor
---

**Generative UI you can shape, tool approvals, and proxy support.**

- **Custom A2UI catalogs.** Add components from a file, a URL or inline JSON: *template* components built from standard ones with `{{prop}}` placeholders, or *HTML* components that run in a sandboxed iframe with a small `window.moka` API (`onProps`, `action`, `update`). MCP servers can ship their own catalog as a resource and reference it by `catalogId`.
- **Customizable render tool.** `workspace.generativeUi` now takes an object: `toolName`, `catalogIds`, `standard`, `allow`/`deny`, `instructions`, `description`, `examples`, `repair` and a surface `theme` (accent color, radius, font, density, agent name). `true`/`false` still work.
- **Self-repair.** UI is validated against the active catalogs (unknown components, missing or invalid props, dangling references), and the model gets actionable errors so it can fix its own UI.
- **Settings → Generative UI.** A catalog browser with live previews, and a playground: edit UI JSON with live validation, ask a model for UI with only the render tool, and see exactly what the model sees.
- **Tool approvals.** Per-tool and per-server `approval` rules (`auto`/`ask`, and destructive tools ask by default), plus a workspace-wide `requireApproval` safe mode. Approve, deny, allow for the session, or always allow, right in the tool card.
- **Corporate proxies.** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (or `--proxy`) now route model, MCP and catalog traffic through your proxy (Node 22.21+/24+), and proxy/CA/registry variables are passed to stdio MCP servers.
- Core: new `InteractionBroker` (`engine.interactions`, `engine.respond()`, `onInteraction`) and `interaction.request`/`interaction.resolved` events.
