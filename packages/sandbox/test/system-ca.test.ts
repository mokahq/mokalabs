import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A company LLM gateway whose certificate comes from a private CA that the OS trusts but Node doesn't.
// Only on Linux can a test put a CA in the "system" store (SSL_CERT_FILE); it needs openssl too.
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const supported = process.platform === "linux" && existsSync(SYSTEM_BUNDLE) && spawnSync("openssl", ["version"]).status === 0;
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let dir: string;
let gateway: https.Server;
let gatewayPort: number;
const running: ChildProcess[] = [];

beforeAll(async () => {
  if (!supported) return;
  dir = mkdtempSync(path.join(os.tmpdir(), "moka-ca-"));
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Moka Test Corp Root CA");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost");
  writeFileSync(path.join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  ssl("x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.pem", "-days", "2", "-extfile", "ext.cnf");
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  // The OS store plus the company CA, as if IT had installed it.
  writeFileSync(path.join(dir, "system.pem"), readFileSync(SYSTEM_BUNDLE, "utf8") + read("ca.pem"));
  gateway = https.createServer({ key: read("srv.key"), cert: read("srv.pem") + read("ca.pem") }, (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "corp-llama" }] }));
    req.resume().on("end", () =>
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "corp-llama", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })),
    );
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayPort = (gateway.address() as { port: number }).port;
}, 30_000);

afterAll(() => {
  for (const child of running) child.kill();
  gateway?.close();
});

/** Start the Moka CLI and wait for the URL it prints. */
async function startMoka(env: Record<string, string>): Promise<string> {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-ca-home-"));
  const child = spawn(process.execPath, [cli, "--no-auth", "--no-open", "--port", "0"], {
    env: { ...process.env, HOME: home, MOKA_HOME: home, MOKA_NO_OPEN: "1", HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", SSL_CERT_FILE: path.join(dir, "system.pem"), ...env },
    cwd: home,
  });
  running.push(child);
  let out = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Moka didn't start:\n${out}`)), 20_000);
    child.stdout!.on("data", (chunk) => {
      out += chunk;
      const url = /Open:\s+(http:\/\/\S+?)\/?\s/.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url.replace("localhost", "127.0.0.1"));
      }
    });
  });
}

const profile = () => ({ profile: { id: "corp", name: "Corp gateway", provider: "openai-compatible", model: "corp-llama", baseURL: `https://localhost:${gatewayPort}/v1`, apiKey: "k" } });
const post = async (base: string, route: string) =>
  (await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(profile()) })).json();

describe.skipIf(!supported)("company certificates", () => {
  it("trusts the certificates the OS trusts, so a company gateway just works", async () => {
    const base = await startMoka({});
    expect(await post(base, "/api/llm/test")).toMatchObject({ ok: true, text: "pong" });
    expect(await post(base, "/api/llm/models")).toEqual({ models: ["corp-llama"] });
  }, 40_000);

  it("explains how to fix an untrusted certificate when the OS store is off", async () => {
    const base = await startMoka({ MOKA_SYSTEM_CA: "0" });
    const result = await post(base, "/api/llm/test");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/self-signed certificate in certificate chain\. .*NODE_EXTRA_CA_CERTS/);
    expect((await post(base, "/api/llm/models")).error).toMatch(/^self-signed certificate in certificate chain\./);
  }, 40_000);
});
