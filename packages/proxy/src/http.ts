import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { guessHttpName } from "./names.js";
import { SessionLog, sessionsDir } from "./session.js";
import { VERSION } from "./version.js";

export type HttpTransportKind = "http" | "sse";

export interface RunHttpProxyOptions {
  /** The server's URL, exactly as in the client's config. */
  url: string;
  /** "http": Streamable HTTP (default). "sse": the older HTTP+SSE transport. */
  transport?: HttpTransportKind;
  /** Headers to send with every request (e.g. Authorization), as in the client's config. */
  headers?: Record<string, string>;
  client?: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  fetch?: typeof fetch;
}

type Message = Record<string, any>;

/**
 * A stdio ↔ HTTP bridge: the editor starts this as if it were a stdio server,
 * and every JSON-RPC message goes to the real HTTP server and back unchanged,
 * recorded to a session log like the stdio proxy.
 *
 * Streamable HTTP: each message is POSTed; replies come back as JSON or an SSE
 * stream; the server's own messages arrive on a GET stream. The Mcp-Session-Id
 * and MCP-Protocol-Version headers are kept. When the server forgets the
 * session (404), the bridge opens a new one with the editor's original
 * initialize and sends the request again, so the editor never sees it.
 *
 * HTTP+SSE (older servers): one GET stream, whose "endpoint" event says where
 * to POST.
 */
export function runHttpProxy(options: RunHttpProxyOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const doFetch = options.fetch ?? fetch;
  const kind = options.transport ?? "http";
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const log = new SessionLog(sessionsDir(env), id);
  const name = options.name ?? guessHttpName(options.url);
  log.write({ type: "start", v: 1, t: Date.now(), id, ...(options.client ? { client: options.client } : {}), name, command: options.url, args: [], url: options.url, transport: kind, cwd: process.cwd(), pid: process.pid, proxy: VERSION });

  const note = (message: string) => {
    stderr.write(`[moka proxy] ${message}\n`);
    log.write({ type: "error", t: Date.now(), message });
  };
  const toClient = (message: Message) => {
    log.write({ type: "msg", t: Date.now(), dir: "in", msg: message });
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  const failRequest = (message: Message, text: string) => {
    if (message.id !== undefined && message.method) toClient({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } });
  };

  const bridge = kind === "sse" ? sseBridge() : streamableBridge();

  return new Promise((resolve) => {
    let settled = false;
    const finish = async (code: number) => {
      if (settled) return;
      settled = true;
      await bridge.close().catch(() => undefined);
      log.write({ type: "exit", t: Date.now(), code, signal: null });
      await log.close();
      resolve(code);
    };
    // Messages go out one at a time, in order (the first must open the session).
    let queue = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        let message: Message;
        try {
          message = JSON.parse(line);
        } catch {
          log.write({ type: "raw", t: Date.now(), dir: "out", text: line });
          continue;
        }
        log.write({ type: "msg", t: Date.now(), dir: "out", msg: message });
        queue = queue.then(() => bridge.send(message)).catch((error) => {
          note(`${options.url}: ${error?.message ?? error}`);
          failRequest(message, `Moka proxy could not reach ${options.url}: ${error?.message ?? error}`);
        });
      }
    });
    stdin.on("end", () => void queue.then(() => finish(0)));
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onSignal = () => void finish(0);
    if (!options.stdin) for (const signal of signals) process.once(signal, onSignal);
  });

  /* ------------------------------------------------------ Streamable HTTP */
  function streamableBridge() {
    let sessionId: string | undefined;
    let protocolVersion: string | undefined;
    let initialize: Message | undefined;
    let initialized: Message | undefined;
    let listening: AbortController | undefined;
    const open = new Set<AbortController>();

    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
      ...options.headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      ...extra,
    });

    /** POST one message; replies go to the client (or to `onReply`, for a hidden re-initialize). */
    async function post(message: Message, onReply: (reply: Message) => void = toClient): Promise<Response> {
      const controller = new AbortController();
      open.add(controller);
      // 2026-07-28 messages carry their protocol version; HTTP wants it (and the method) as headers too.
      const version = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
      const res = await doFetch(options.url, {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(typeof version === "string" ? { "mcp-protocol-version": version } : {}),
          ...(typeof message.method === "string" ? { "mcp-method": message.method } : {}),
        }),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (!res.ok) {
        open.delete(controller);
        return res;
      }
      const type = res.headers.get("content-type") ?? "";
      const done = type.includes("text/event-stream")
        ? readSse(res, (event) => event.data && parseAll(event.data).forEach(onReply))
        : res.text().then((text) => text.trim() && parseAll(text).forEach(onReply));
      // Requests wait for their reply (so a session is open before the next message); notifications don't.
      const wait = done.catch((error) => note(`${options.url}: reply stream broke: ${error?.message ?? error}`)).finally(() => open.delete(controller));
      if (message.id !== undefined && message.method === "initialize") await wait;
      return res;
    }

    function remember(reply: Message) {
      const version = reply?.result?.protocolVersion;
      if (typeof version === "string") protocolVersion = version;
    }

    async function send(message: Message): Promise<void> {
      if (message.method === "initialize") {
        initialize = message;
        sessionId = undefined;
        protocolVersion = undefined;
      }
      if (message.method === "notifications/initialized") initialized = message;
      const res = await post(message, (reply) => {
        if (message.method === "initialize" && reply.id === message.id) remember(reply);
        toClient(reply);
      });
      if (res.ok) {
        if (message.method === "notifications/initialized") listen();
        return;
      }
      const body = (await res.text().catch(() => "")).slice(0, 300);
      // The server forgot our session (idle timeout, restart): open a new one and try again, once.
      if (res.status === 404 && sessionId && initialize && message.method !== "initialize" && (await renew())) {
        const retry = await post(message);
        if (retry.ok) return;
        return failRequest(message, `HTTP ${retry.status} from ${options.url}: ${(await retry.text().catch(() => "")).slice(0, 300)}`);
      }
      if (res.status === 401 || res.status === 403) note(`HTTP ${res.status} from ${options.url}: the server wants credentials. Add them as headers in your editor's config (the proxy sends those), or unwrap this server if it signs in with OAuth.`);
      failRequest(message, `HTTP ${res.status} from ${options.url}${body ? `: ${body}` : ""}`);
    }

    /** A new session, with the editor's own initialize; its reply isn't passed on (the editor already has one). */
    async function renew(): Promise<boolean> {
      note(`${options.url}: the session expired on the server; opening a new one`);
      sessionId = undefined;
      listening?.abort();
      let ok = false;
      const res = await post({ ...initialize, id: `moka-proxy-renew-${Date.now()}` }, (reply) => {
        remember(reply);
        ok = !reply.error;
        log.write({ type: "msg", t: Date.now(), dir: "in", msg: reply });
      }).catch(() => undefined);
      if (!res?.ok || !ok) return false;
      if (initialized) await post(initialized).catch(() => undefined);
      listen();
      return true;
    }

    /** The server's own messages (notifications, requests to the client) come on a GET stream, if it offers one. */
    function listen() {
      listening?.abort();
      const controller = (listening = new AbortController());
      void (async () => {
        for (let attempt = 0; attempt < 5 && !controller.signal.aborted; attempt++) {
          try {
            const res = await doFetch(options.url, { method: "GET", headers: headers({ accept: "text/event-stream" }), signal: controller.signal });
            if (res.status === 405 || res.status === 404) return; // no stream offered
            if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return;
            attempt = 0;
            await readSse(res, (event) => event.data && parseAll(event.data).forEach(toClient));
          } catch {
            if (controller.signal.aborted) return;
          }
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      })();
    }

    async function close() {
      listening?.abort();
      for (const c of open) c.abort();
      if (sessionId) await doFetch(options.url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    }

    return { send, close };
  }

  /* --------------------------------------------------------- HTTP + SSE */
  function sseBridge() {
    const controller = new AbortController();
    let endpoint: Promise<string> | undefined;

    function connect(): Promise<string> {
      return new Promise((resolve, reject) => {
        let found = false;
        void doFetch(options.url, { method: "GET", headers: { ...options.headers, accept: "text/event-stream" }, signal: controller.signal })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status} from ${options.url}`);
            await readSse(res, (event) => {
              if (event.event === "endpoint") {
                found = true;
                resolve(new URL(event.data.trim(), options.url).toString());
              } else if (event.data) parseAll(event.data).forEach(toClient);
            });
            if (!controller.signal.aborted) note(`${options.url}: the server closed the event stream`);
          })
          .catch((error) => {
            if (!found) reject(error);
            else if (!controller.signal.aborted) note(`${options.url}: ${error?.message ?? error}`);
          });
      });
    }

    async function send(message: Message) {
      endpoint ??= connect();
      const res = await doFetch(await endpoint, { method: "POST", headers: { ...options.headers, "content-type": "application/json" }, body: JSON.stringify(message) });
      if (!res.ok) failRequest(message, `HTTP ${res.status} from ${options.url}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }

    async function close() {
      controller.abort();
    }

    return { send, close };
  }
}

/** One message or a JSON-RPC batch. */
function parseAll(text: string): Message[] {
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

/** Read a text/event-stream response, calling `onEvent` for each event. */
async function readSse(res: Response, onEvent: (event: { event?: string; data: string }) => void): Promise<void> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = () => {
    if (data.length || event) onEvent({ event, data: data.join("\n") });
    event = undefined;
    data = [];
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.search(/\r?\n/)) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
      if (line === "") dispatch();
      else if (line.startsWith(":")) continue;
      else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
  }
  dispatch();
}
