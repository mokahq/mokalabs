/**
 * Some OpenAI-compatible gateways add their own events to a chat-completions
 * stream, e.g. `{"start_time":…,"ttft":…,"elapsed_time":1.66}` with timing
 * metrics. The AI SDK checks every chunk and fails the whole reply on one it
 * doesn't recognise. This fetch wrapper drops `data:` events whose JSON is
 * neither a completion chunk (`choices`) nor an error, and passes everything
 * else through unchanged.
 */

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Is this event's data something the chat-completions parser understands? */
function isCompletionEvent(event: string): boolean {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return true;
  try {
    const value = JSON.parse(data);
    return !value || typeof value !== "object" || Array.isArray(value) || "choices" in value || "error" in value;
  } catch {
    return true; // not JSON: leave it to the SDK to report
  }
}

/** The SSE body without extra events. `onDropped` sees each one (for the inspector). */
export function filterCompletionStream(body: ReadableStream<Uint8Array>, onDropped?: (data: string) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const emit = (event: string, controller: TransformStreamDefaultController<Uint8Array>, separator: string) => {
    if (isCompletionEvent(event)) controller.enqueue(encoder.encode(event + separator));
    else onDropped?.(event.replace(/^data:\s?/gm, ""));
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let match: RegExpExecArray | null;
        // Events end with a blank line.
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          emit(event, controller, match[0]);
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) emit(buffer, controller, "");
      },
    }),
  );
}

/** A fetch whose event-stream responses have extra gateway events removed. */
export function tolerantStreamFetch(base: FetchLike = fetch, onDropped?: (data: string) => void): FetchLike {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
    return new Response(filterCompletionStream(response.body, onDropped), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
