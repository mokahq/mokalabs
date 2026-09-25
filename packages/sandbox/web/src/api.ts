import type { ChatChunk, MokaEvent } from "./types";

const TOKEN_KEY = "moka.token";

function readToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // storage unavailable
    }
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token = readToken();

export function setToken(value: string) {
  token = value;
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // ignore
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(token ? { "x-moka-token": token } : {}), ...extra };
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: headers(init.body !== undefined ? { "content-type": "application/json" } : {}),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

/** Read an NDJSON response body line by line. */
async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as T;
}

export async function* streamChat(
  body: { messages: unknown[]; workspaceId?: string; llmId?: string; agentId?: string },
  signal: AbortSignal,
): AsyncGenerator<ChatChunk> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data?.error ?? res.statusText, res.status);
  }
  yield* ndjson<ChatChunk>(res);
}

/** Subscribe to the inspector event stream, reconnecting automatically. */
export function subscribeEvents(onEvent: (event: MokaEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let delay = 500;
  const loop = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch("/api/events", { headers: headers(), signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        onStatus(true);
        delay = 500;
        for await (const event of ndjson<MokaEvent>(res)) {
          if (event.kind !== "heartbeat") onEvent(event);
        }
      } catch {
        // fall through to reconnect
      }
      onStatus(false);
      if (stopped) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  };
  void loop();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
