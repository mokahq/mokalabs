/**
 * Azure OpenAI's newer models (GPT-5, o-series) reject `max_tokens` and want
 * `max_completion_tokens`, while many other OpenAI-compatible servers only know
 * `max_tokens`. This fetch wrapper sends `max_tokens` as usual; if the server
 * rejects it, it retries once with `max_completion_tokens` and keeps doing so
 * for that endpoint.
 */

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const UNSUPPORTED = /max_tokens/i;
const SUGGESTS = /max_completion_tokens|unsupported_parameter|not supported/i;

export function maxTokensFallbackFetch(base: FetchLike = fetch): FetchLike {
  const useCompletionTokens = new Set<string>();
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (!body || !body.includes('"max_tokens"')) return base(input, init);
    const renamed = () => {
      const json = JSON.parse(body);
      json.max_completion_tokens = json.max_tokens;
      delete json.max_tokens;
      return { ...init, body: JSON.stringify(json) };
    };
    if (useCompletionTokens.has(url)) return base(input, renamed());
    const response = await base(input, init);
    if (response.status !== 400) return response;
    const text = await response.clone().text();
    if (!UNSUPPORTED.test(text) || !SUGGESTS.test(text)) return response;
    useCompletionTokens.add(url);
    return base(input, renamed());
  };
}
