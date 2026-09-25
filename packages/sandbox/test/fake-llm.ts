import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal OpenAI-compatible Chat Completions server for tests. On the first
 * turn it calls `toolName` with `toolArgs`; once a tool result is present it
 * answers with text that echoes the tool output.
 */
export async function startFakeLlm(toolName: string, toolArgs: Record<string, unknown>) {
  const requests: any[] = [];
  const server: Server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake-1" }, { id: "fake-2" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const toolMessage = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "tool");
    const base = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body.model };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    if (!toolMessage && body.tools?.length) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    } else {
      const content = typeof toolMessage?.content === "string" ? toolMessage.content : JSON.stringify(toolMessage?.content ?? "");
      for (const piece of ["The ", "answer ", `is ${content}`]) {
        send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
