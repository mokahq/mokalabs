import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { detectLmStudio } from "../src/providers.js";

describe("local model servers", () => {
  it("finds LM Studio's loaded models, leaving out embedding models", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/v1/models" ? JSON.stringify({ object: "list", data: [{ id: "qwen3-4b" }, { id: "text-embedding-nomic-embed-text-v1.5" }, { id: "openai/gpt-oss-20b" }] }) : "{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    expect(await detectLmStudio(url)).toEqual(["qwen3-4b", "openai/gpt-oss-20b"]);
    server.close();
    // Nothing listening: no models, quickly.
    const started = Date.now();
    expect(await detectLmStudio(url, 300)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
