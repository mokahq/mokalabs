---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

**Retry lineage, and tool arguments from model to server.** When the model calls the same tool again with the same arguments, Moka now treats it as another attempt of the same call, not a new one. Thanks to u/Tariq9977 on Reddit for the idea.

- **One lineage per call.** Attempts share a lineage id (the first attempt's tool call id), matched by a fingerprint of the server, tool, input schema and normalized arguments. It's on `tool.call`, `tool.result` and `tool.error` events (`data.lineage`) and in the trace download.
- **Error classes.** Every failed tool call gets `errorClass`: `timeout`, `cancelled`, `transport`, `protocol`, `tool`, `declined`, `input` or `other`.
- **"Did the write land?"** When a tool that may write fails with a timeout, cancellation or broken connection, the call is marked **outcome unknown**. If a retry then succeeds, it's flagged **may have run twice**. A repeat of a write that already succeeded is still **same call again**; a retry after a clear error isn't a warning.
- **Attempts in the inspector.** Open any attempt, or its raw `tools/call`, to see every attempt with its outcome, duration and request, linked to the RPC log. Raw `tools/call` messages, cancellations and late replies now carry `rpc.callId`, the tool call they belong to.
- A late reply to a request Moka already gave up on no longer shows up a second time as an "unknown message ID" error; it's in the RPC log as a late reply.
- **Idempotent tools.** Tools marked `idempotentHint` aren't flagged when the model repeats them: no "same call again" or "may have run twice", just "attempt 2 (idempotent)".
- **Arguments: model → server.** Open a tool call in the inspector to see its arguments exactly as the model streamed them, as Moka parsed them, and as the server received them in `tools/call`, with differences listed by path. Broken or truncated JSON from the model is shown as such (error class `input`; nothing is sent). New on `tool.call`: `rawInput` and `invalid`.
- **The model is told too.** When a write's outcome is unknown, the error the model gets ends with "the tool may have run. Check whether it did before retrying", so it no longer reports a save as failed when it may have worked.
- **Crashed servers come back.** A server that closes the connection after working (it exited or crashed) is now **disconnected** (amber), not "Could not connect". Moka starts it again on the next tool call, even in the middle of a turn, so a retry really retries, and the Tools page reconnects it by itself.
- **Demo server:** new read-only `read_notes` tool, so the model can check whether `flaky_write` saved the note before retrying.
- **Run a message again.** Hover a message you sent to see when you sent it, copy it, or run it again (on an earlier message, it replaces the replies after it). **↑** in an empty message box brings back your last message to edit.
- With Moka branding off, the default "What is Moka…" starter prompt is hidden.
- "1 step" instead of "1 steps" under a reply.
- The inspector's detail view now opens scrolled to the top for each event.
