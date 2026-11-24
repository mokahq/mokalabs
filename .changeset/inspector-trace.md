---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

The inspector shows what each model step was sent and what came back. A request event lists the conversation by role (system prompt, your messages, tool calls and their results) with long content folded, the exact request body sent to the provider, and the tool definitions the model saw. A response event shows the step's thinking, text and tool calls with its token usage. `llm.request` events carry `messages`, `system` and the request `body` again (AI SDK 7 stopped including them by default), and `llm.response` events carry `output`.
