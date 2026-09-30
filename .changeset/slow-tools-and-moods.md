---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

**Slow tools, a puppy, and a way to turn Moka branding off.**

- **Progress.** Moka now asks every tool call for progress (`progressToken`). While a tool runs, its card shows a progress bar with the server's message and a clock, and a new `tool.progress` event lands in the inspector. Raw `notifications/progress` messages are linked to their request.
- **Tool timeouts per server** (Advanced → Slow tools): the Moka default (2 minutes, progress restarts the timer), a preset that behaves like clients on the MCP SDK defaults (60 seconds, progress doesn't help), or custom values. New config fields: `toolTimeoutMs`, `resetTimeoutOnProgress`, `maxTotalTimeoutMs`.
- **See when the client gives up.** A timeout gets a **timed out** badge on the request, a "Moka gave up on tools/call #7 after 60.0s (timeout)" marker (`rpc.reason: "timeout"`), and a clear tool error instead of the SDK's generic one.
- A final progress update that arrives together with the result (the MCP SDK drops it) is no longer reported as an error.
- **Demo server:** new `slow_backtest` tool, a simulated 90-second backtest that reports progress every second.
- **Moka is a puppy now.** A front-facing pup with a coffee cup replaces the dino as the header logo and on the empty chat, where its eyes follow your cursor, hovering pets it and a click plays peekaboo. The chat itself stays neutral: a spinner while the model thinks and a plain progress bar for tools. The favicon, docs, README and brand kit switch to the puppy too, with a new tagline: *Good pup. Strong brew.*
- **"Moka branding" preference** (Settings → Config file → Preferences, or `"ui": { "branding": false }`): hides the puppy, the Moka name (header, empty chat, composer, tab title) and the star line, in the app and the terminal, for a neutral chat when you demo your own product.
- **"Animate Moka" preference** (Settings → Config file → Preferences, or `"ui": { "animations": false }`): stops the puppy moving. The OS "reduce motion" setting does the same.
