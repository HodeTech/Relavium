/**
 * The fixture record/replay substrate of the conformance harness (1.F). A `RecordedResponse` is one
 * provider HTTP reply captured as text; `replayFetch` serves it back so an adapter can be driven
 * **offline and deterministically** in PR mode, and `recordFetch` captures live responses to mint
 * fresh fixtures. Provider SDKs accept a custom `fetch`, so the adapter is exercised end-to-end
 * (real SDK parsing + our normalization) without touching the network or a key.
 */

/** One recorded HTTP response — the unit of a conformance fixture. */
export interface RecordedResponse {
  readonly status: number;
  /** Defaults to `application/json`; a streamed transcript uses `text/event-stream`. */
  readonly contentType?: string;
  /** The raw response body — a JSON string, or an SSE transcript for a stream. */
  readonly body: string;
}

/** The provider-SDK `fetch` shape (matches `@anthropic-ai/sdk`'s `Fetch`, and the OpenAI/Gemini ones). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A `fetch` that replays one recorded response — drives an adapter offline, deterministically. */
export function replayFetch(recorded: RecordedResponse): FetchLike {
  return () =>
    Promise.resolve(
      new Response(recorded.body, {
        status: recorded.status,
        headers: { 'content-type': recorded.contentType ?? 'application/json' },
      }),
    );
}

/** Wrap a real `fetch` to capture each response as a `RecordedResponse` — the live-mode recorder. */
export function recordFetch(realFetch: FetchLike): {
  readonly fetch: FetchLike;
  readonly recordings: readonly RecordedResponse[];
} {
  const recordings: RecordedResponse[] = [];
  const fetch: FetchLike = async (input, init) => {
    const response = await realFetch(input, init);
    const body = await response.clone().text();
    const contentType = response.headers.get('content-type');
    recordings.push(
      contentType !== null
        ? { status: response.status, contentType, body }
        : { status: response.status, body },
    );
    return response;
  };
  return { fetch, recordings };
}
