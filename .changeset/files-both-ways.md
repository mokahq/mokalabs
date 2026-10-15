---
"@mokalabs/sandbox": minor
"@mokalabs/core": minor
"@mokalabs/proxy": minor
"create-moka": minor
---

Tool tests, a security check, context budgets, and pages, diagrams and files next to the chat.

**Tool tests.** A new **Tests** view runs prompts on several models at once, several times each, and grades what each model did: tools it had to call, tools it mustn't, arguments (partial match), words in the answer. Results fill a model-by-test grid as runs finish; a cell shows each run's failure reasons, tool calls, answer and a link to the inspector. **Suggest tests** asks the workspace's model to write tests from its tools; **Copy scorecard** copies a Markdown table. Tests are saved in the workspace (`tests` in moka.json) and `moka test [config] --models a,b --runs 3` runs them from the command line, exiting 1 on failure, for CI. By default only tools marked read-only really run (`--tools run|read-only|none`). Core: `runToolTests()`, `grade()`, `suggestTests()`, `engine.runTests()`, and a `toolMode` option for chats.

**Security check.** Every MCP server is checked when it connects: hidden-instruction tags, "don't tell the user", instruction overrides, credentials and secret files, invisible Unicode, sending data away, steering other tools, shadowing (same tool name on two servers, or naming another server's tool), and very long descriptions, in tool, parameter, instruction and prompt text. Moka remembers each server's tools (`~/.moka/tool-pins.json`) and reports tools whose description or schema changed since, with a before/after diff, until you trust them. Findings show as a shield in the sidebar, a section in the server's settings and an inspector event; servers behind the proxy are checked too. Core: `scanServer()`, `ToolPins`, `engine.securityReport()`.

**Context budget.** The empty chat shows how many tokens the workspace's system prompt, skills, server instructions and tool definitions cost on every request; click for a breakdown per server and tool, biggest first, with a switch to hide each tool, and warnings past half of an 8K window or 40 tools. Settings shows each tool's estimate. Core: `contextBudget()`.

**Pages and diagrams in replies.** HTML, SVG and Mermaid that a model writes are shown, not just printed: Mermaid and SVG draw in the chat, a whole HTML page shows as a card and opens next to the chat when the reply finishes, and snippets get a Preview button. Pages run sandboxed; a banner lists the hosts a page loads from, with one click to block them. The preview pane can expand.

**Preview files next to the chat.** Attachments and files returned by tools open in a resizable pane: PDF pages (pdf.js, loaded only when needed), Word documents, HTML, Markdown, CSV, JSON, images, SVG, Mermaid, audio, video and code. Documents a tool makes open on their own. Tool results with images, audio, embedded resources or resource links show as file cards; tool-call chunks now carry `serverId`.

**Attached PDFs and Word files work with every model.** Moka reads their text in the browser when attached. Models that read PDFs (OpenAI, Anthropic, Gemini, Azure) get the PDF; LM Studio, Ollama and other OpenAI-compatible models get its text, and Word files go to every model as Markdown. Before, attaching one to those models failed with "file part media type … not supported", and so did every later message in the chat. Core: `adaptAttachments()`.

**Local models.** LM Studio is detected on first run like Ollama, and Settings → Models offers to add LM Studio or Ollama when they're running but not added. Replies without tool calls show tokens per second, in the chat and in Compare.

**Workspaces in the sidebar.** Chats are grouped by workspace; start a chat in any workspace, or create one with the current model, MCP servers and skills.

Also: the demo server's `create_document` tool writes PDF, Word, HTML or Markdown files; `.mjs` files are served as JavaScript.
