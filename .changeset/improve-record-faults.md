---
"@mokalabs/proxy": minor
"@mokalabs/sandbox": minor
"@mokalabs/core": minor
"create-moka": minor
---

**Improve: better tool wording, proven on your tests.** In Tests, **Improve** diagnoses why runs fail (wrong tool, missed call, wrong argument, a call that shouldn't happen), has your strongest model propose new descriptions, parameter hints and examples, and verifies each proposal on every test and model plus paraphrased prompts the proposer never sees. A proposal wins only if it passes more often, does no worse on the unseen prompts, breaks no passing test and passes the security check. Review before → after per model with a word diff, then **Try it in Moka** (saved as `toolOverrides` in `moka.json`, undo any time), **Copy changes** as Markdown, or **Copy as code** for the TypeScript SDK and Python FastMCP. `moka improve --models a,b --runs 3 [--apply]` does the same from the command line.

**Record, replay & faults.** Turn on **Record traffic** for a server and its JSON-RPC messages go to `~/.moka/recordings/`. **Replay** (Proxy view) adds a server that answers from a recording, in both MCP revisions; `npx @mokalabs/sandbox mock recording.jsonl` runs it anywhere, and proxy sessions replay too. **Fault injection** adds delays, JSON-RPC errors, tool errors, hangs, crashes and malformed results to chosen tool calls, seeded and marked ⚡ in the inspector.

**Tool tests in CI.** `moka test` gains `--min-pass 0.9` (fail only below a pass rate), `--markdown scorecard.md` (for a job summary or a sticky PR comment) and `--baseline results.json` (the change per model). The docs have a ready-to-copy GitHub Actions workflow.

**See how the model thinks.** Like Copilot or Claude Code, the chat shows the model's reasoning live (**Thinking…**, streaming), then folds it to **Thought for 6s**, before each tool call and the answer. Moka asks for it where the model can reason: OpenAI reasoning summaries, Claude thinking, Gemini 2.5+ thoughts, and `<think>` blocks from local models (Qwen3, DeepSeek-R1) in Ollama and LM Studio. Per model: Settings → Models → **Reasoning** (auto, an effort level, or off).

**Misnamed tool calls.** When a model calls `get_time` but the tool is `moka-demo__get_time` (and it's the only one with that name), Moka runs it and says so in the inspector; calls to tools that don't exist get their own *unknown tool* error. A short formatting hint (Markdown, Mermaid, code fences) is added to the system prompt; `formatHints: false` turns it off.

Also: clicking Moka on the empty chat opens a small about card (version, what's new, docs); the Docker image runs on Node 24.
