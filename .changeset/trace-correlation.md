---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

**Trace correlation: which response belongs to which request, and which node did what.**

- **Request ↔ response pairing.** Every JSON-RPC response is matched to its request by id, in both directions. Requests in the inspector show their latency, or **error**, **cancelled**, **cancelled · late reply** or **no response**. Clicking one shows the request and response with their ids side by side. New event fields: `rpc` (`id`, `method`, `pairId`, `outcome`) and response `durationMs`.
- **No response.** When a connection closes with requests still open, a new `mcp.unanswered` event says which request never got an answer and how long it waited.
- **Repeated writes.** If the model calls a tool that may write (no `readOnlyHint`) twice in one turn with the same arguments, the second call is flagged: **same call again** on the tool card and a warning in the inspector (`duplicateOf`).
- **Agent graphs.** AG-UI events are nested under the step (graph node) that emitted them, and finished steps show their duration. Nodes that overlap are labelled, since that grouping is best-effort. New event field: `parentId`.
- **Demo server:** new `flaky_write` tool (saves a note, then crashes before answering) and `moka://notes` resource, to try interrupted calls. `roll_dice` and `generate_uuid` are now marked read-only.
