---
"@mokalabs/sandbox": patch
"@mokalabs/core": patch
"@mokalabs/proxy": patch
"create-moka": patch
---

Fixes from the first team rollout.

- **Expired MCP sessions recover.** Streamable HTTP servers that keep sessions (MongoDB's MCP server, for one) forget them when idle or restarted and answer "session not found" (HTTP 404). Moka kept sending the old session, so every call failed until Moka restarted. Now it starts a new session and retries the request once (safe: the server refused it without running it), for tool calls, resources and prompts.
- **A model that never answers no longer hangs the chat.** If a model or its gateway sends nothing for 5 minutes (or pauses 2 minutes mid-reply), the run ends with an error that says so. Set `timeoutMs` on the model to change it. Time spent running tools or waiting for your approval doesn't count.
- **Approvals you can't miss.** While a tool waits for your OK, a bar above the message box names it (**Show** scrolls to it) and the tab title reads "(1) Waiting for you".
- **Approval settings stick.** Saving a server's form no longer resets the per-tool asks/auto switches you'd just changed.
- **Inspector in its own window.** ⧉ in the inspector opens it in a separate window; "Inspect run →" shows runs there.
- **Add the demo server back.** "Moka demo tools" is in the Add server gallery when it's not configured.
- **Sampling is easier to find.** The server form shows the Sampling setting next to Tool approval (it was under Advanced), and new setups get a "Brainstorm names for a coffee robot" starter prompt that uses it.
- The message box no longer shows a scrollbar for a single line when the OS always shows scrollbars.
