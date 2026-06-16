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

/** Secret-shaped patterns a cassette body must not contain (API keys / bearer tokens). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[a-zA-Z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\bBearer\s+[a-z0-9._-]{16,}/i, // bearer tokens (case-insensitive, so a-z covers both cases)
  /AIza[0-9A-Za-z_-]{20,}/, // Google API keys
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/, // Slack tokens
];

/** True if `text` looks like it embeds a secret — used to refuse recording an unsafe fixture. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A `fetch` that replays one recorded response — drives an adapter offline, deterministically. It
 * fails loud on a malformed request (a body that isn't valid JSON) rather than serving the canned
 * response blind; full recorded-request body-matching lands with the on-disk recorder.
 */
export function replayFetch(recorded: RecordedResponse): FetchLike {
  return (_input, init) => {
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        JSON.parse(init.body);
      } catch {
        return Promise.reject(new Error('replayFetch: the request body is not valid JSON'));
      }
    }
    return Promise.resolve(
      new Response(recorded.body, {
        status: recorded.status,
        headers: { 'content-type': recorded.contentType ?? 'application/json' },
      }),
    );
  };
}

/**
 * A `fetch` that replays a SEQUENCE of recorded responses — the Nth call serves `recordings[N]`. Drives a
 * multi-turn scenario (a tool-call turn → a continuation carrying the tool result) offline + deterministically.
 * Fails loud if called more times than there are recordings (a scenario that over-fetches is a fixture bug),
 * and validates each request body is JSON (like {@link replayFetch}).
 */
export function replayFetchSequence(recordings: readonly RecordedResponse[]): FetchLike {
  let call = 0;
  return (_input, init) => {
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        JSON.parse(init.body);
      } catch {
        return Promise.reject(new Error('replayFetchSequence: the request body is not valid JSON'));
      }
    }
    const recorded = recordings[call];
    call += 1;
    if (recorded === undefined) {
      return Promise.reject(
        new Error(
          `replayFetchSequence: no recorded response for call #${String(call)} (only ${String(recordings.length)} recorded)`,
        ),
      );
    }
    return Promise.resolve(
      new Response(recorded.body, {
        status: recorded.status,
        headers: { 'content-type': recorded.contentType ?? 'application/json' },
      }),
    );
  };
}

/**
 * Pick the right replay `fetch` for a conformance scenario: a single {@link RecordedResponse} (the one-shot
 * scenarios) replays the same body each call; an array replays it as a sequence (multi-turn). The `'status'
 * in` check narrows the union cleanly without an unsafe cast (a `RecordedResponse` has `status`; an array
 * does not).
 */
export function replayFor(recorded: RecordedResponse | readonly RecordedResponse[]): FetchLike {
  return 'status' in recorded ? replayFetch(recorded) : replayFetchSequence(recorded);
}

/**
 * Wrap a real `fetch` to capture each response as a `RecordedResponse` — the live-mode recorder. It
 * **refuses to record** a body that looks like it contains a secret, so a captured fixture can never
 * carry a key into version control (security-review.md).
 */
export function recordFetch(realFetch: FetchLike): {
  readonly fetch: FetchLike;
  readonly recordings: readonly RecordedResponse[];
} {
  const recordings: RecordedResponse[] = [];
  const fetch: FetchLike = async (input, init) => {
    const response = await realFetch(input, init);
    const body = await response.clone().text();
    if (looksLikeSecret(body)) {
      throw new Error(
        'recordFetch: refusing to record a fixture whose body looks like it contains a secret',
      );
    }
    const contentType = response.headers.get('content-type');
    recordings.push(
      contentType === null
        ? { status: response.status, body }
        : { status: response.status, contentType, body },
    );
    return response;
  };
  return { fetch, recordings };
}
