---
"@mokalabs/proxy": minor
"@mokalabs/sandbox": minor
"@mokalabs/core": minor
"create-moka": minor
---

**Time-travel.** Fork any reply from any step (⑂ in the margin): edit a tool's result (or turn it into an error), edit a call's arguments (Moka runs it again), rewrite the model's reply, retry, or run the rest on another model. Forks are branches of the reply: switch with ‹ 2 / 3 ›, see what's shared and what was edited (✎), and **Compare** branches side by side with the differences highlighted. Branches are saved with the chat; the inspector labels fork runs. The model's thinking can't be edited.

**Breakpoints.** Pause chats before a tool runs, after it returns, on a tool error, or before each model step, optionally only when an argument matches (`priority is "high"`, `title contains "prod"`). While paused: edit the arguments or the result, switch model for a step, Skip or Fail a tool, **Step** (F10) to the next tool call or model step, **Continue** (F8) or Stop. Set them with the red dot in the chat margin or the inspector's Breakpoints panel; they're saved in the workspace in `moka.json`. Tests and Improve never pause.

**Server Studio.** Write an MCP server in Moka: start from a template (blank, HTTP API wrapper, read a folder), edit `server.ts`, save, and the server restarts with its tools ready in chat, Tools and Tests. Moka supplies the MCP SDK and zod, so there's nothing to install; servers can live in `~/.moka/studio` or any folder, and restart when edited elsewhere too. **Export** gives a project with `package.json`, `tsconfig.json` and a README. TypeScript needs Node 22.18+ (plain `.mjs` works on Node 20).

Also: stopping a run (the Stop button or a breakpoint) now ends it as stopped instead of finished.
