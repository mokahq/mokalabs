// A tiny stdio MCP server for tests: answers initialize, tools/list and tools/call (echo).
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
process.stderr.write("fixture server ready\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } },
    });
  }
  if (message.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  }
  if (message.method === "tools/call") {
    // Multi-byte text, to check that it survives the pass-through intact.
    return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `echo: ${message.params.arguments.text} ☕` }] } });
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
