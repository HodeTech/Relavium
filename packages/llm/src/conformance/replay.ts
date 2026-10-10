/**
 * The fixture record/replay substrate of the conformance harness (1.F). A `RecordedResponse` is one
 * provider HTTP reply captured as text; `replayFetch` serves it back so an adapter can be driven
 * **offline and deterministically** in PR mode, and `recordFetch` captures live responses to mint
 * fresh response seeds. These legacy helpers do not verify the wire request; the strict
 * expected-exchange harness lives in `exchange-replay.ts`. SDK parsing and normalization
 * alone are not proof of correct request lowering.
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
  /\bAQ\.[0-9A-Za-z_-]{24,}/, // newer Google API key representation
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/, // Slack tokens
];

/** True if `text` looks like it embeds a secret — used to refuse recording an unsafe fixture. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A `fetch` that replays one recorded response — drives an adapter offline, deterministically. It
 * fails loud on a malformed request (a body that isn't valid JSON) rather than serving the canned
 * response without that syntax check. Canonical request matching belongs to `createExchangeReplay`.
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
 * Refuses known secret-shaped response bodies/metadata and returns immutable recording snapshots.
 * This heuristic cannot establish that arbitrary provider/user content is secret-free; use only
 * synthetic inputs. It does not record or validate requests; see `recordExchangeFetch` for exchanges.
 */
export function recordFetch(realFetch: FetchLike): {
  readonly fetch: FetchLike;
  readonly recordings: readonly RecordedResponse[];
} {
  const recordings: RecordedResponse[] = [];
  const fetch: FetchLike = async (input, init) => {
    try {
      const response = await realFetch(input, init);
      const body = await response.clone().text();
      const contentType = response.headers.get('content-type');
      if (looksLikeSecret(body) || (contentType !== null && looksLikeSecret(contentType))) {
        throw new FixtureRecordingError('unsafe_recording');
      }
      recordings.push(
        Object.freeze(
          contentType === null
            ? { status: response.status, body }
            : { status: response.status, contentType, body },
        ),
      );
      return response;
    } catch (error) {
      if (error instanceof FixtureRecordingError) {
        // Even an externally thrown instance may have a mutated message or raw cause.
        throw new FixtureRecordingError(
          error.code === 'unsafe_recording' ? 'unsafe_recording' : 'capture_failed',
        );
      }
      // Transport/read errors may contain the credential-bearing URL or provider response.
      throw new FixtureRecordingError('capture_failed');
    }
  };
  return {
    fetch,
    get recordings() {
      return Object.freeze([...recordings]);
    },
  };
}

/** Fixed diagnostics: recording failures never carry raw requests, provider text or causes. */
export class FixtureRecordingError extends Error {
  readonly code: 'unsafe_recording' | 'capture_failed';

  constructor(code: 'unsafe_recording' | 'capture_failed') {
    super('recordFetch: refusing an unsafe or failed fixture capture');
    this.name = 'FixtureRecordingError';
    this.code = code;
  }
}

/** Replay the SDK's diagnostic body verbatim, so classification sees the captured provider message. */
export function replayGeminiError(
  recorded: RecordedResponse,
): Error & { status: number; body: string } {
  return Object.assign(new Error(recorded.body), { status: recorded.status, body: recorded.body });
}
