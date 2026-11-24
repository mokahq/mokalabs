---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

Web search is built in. Turn on **Search** in the chat input and any model that can call tools gets `web_search` (titles, links and snippets) and `web_fetch` (a page as readable text), with no MCP server needed. The button is remembered. The first time you turn it on, it asks which provider to use: your own SearXNG, Tavily, Brave Search or DuckDuckGo (no key, but it often blocks scripts; when it does, the chat offers to switch). Change it from the arrow next to the button, Settings → Config file → Web search, or `webSearch` in moka.json.
