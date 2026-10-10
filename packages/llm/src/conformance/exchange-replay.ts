/** Internal synthetic-fixture request oracle. No SDK or public seam export belongs here. */
import { looksLikeSecret, type FetchLike, type RecordedResponse } from './replay.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface RequestProjection {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  /** Raw search, including `?` when nonempty, with credential parameters removed. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly kind: 'none' } | { readonly kind: 'json'; readonly value: JsonValue };
}

export interface ExpectedExchange {
  readonly request: RequestProjection;
  readonly response: RecordedResponse;
}

const REASONS = [
  'invalid_expectation',
  'invalid_request',
  'invalid_json',
  'unsafe_content',
  'request_mismatch',
  'over_consumed',
  'under_consumed',
  'in_flight',
  'network_failure',
  'invalid_response',
] as const;
export type ExchangeReplayReason = (typeof REASONS)[number];

/** Fixed diagnostics deliberately carry no raw cause, URL, header, body or mismatch value. */
export class ExchangeReplayError extends Error {
  readonly code = 'exchange_replay';
  constructor(
    readonly reason: ExchangeReplayReason,
    readonly ordinal: number,
  ) {
    super(`Exchange replay refused: ${reason} (exchange ${String(ordinal)})`);
    this.name = 'ExchangeReplayError';
    Object.freeze(this);
  }
}

const PROTOCOL_HEADERS = new Set([
  'accept',
  'content-type',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
]);
const CREDENTIAL_NAMES = new Set([
  'key',
  'apikey',
  'xapikey',
  'accesstoken',
  'token',
  'authtoken',
  'authorization',
  'authentication',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'credential',
  'credentials',
  'signature',
  'sig',
]);

function refuse(reason: ExchangeReplayReason, ordinal: number): never {
  throw new ExchangeReplayError(reason, ordinal);
}

/** Classify external exceptions without retaining even their messages or causes. */
function sanitized(
  error: unknown,
  fallback: ExchangeReplayReason,
  ordinal: number,
): ExchangeReplayError {
  try {
    if (error instanceof ExchangeReplayError) {
      // A hostile thrown object must not execute a reason getter or retain mutable diagnostics.
      const descriptor = Object.getOwnPropertyDescriptor(error, 'reason');
      const reason: unknown = descriptor?.value;
      const known = REASONS.find((candidate) => candidate === reason);
      return new ExchangeReplayError(known ?? fallback, ordinal);
    }
  } catch {
    return new ExchangeReplayError(fallback, ordinal);
  }
  return new ExchangeReplayError(fallback, ordinal);
}

function credentialName(name: string): boolean {
  return CREDENTIAL_NAMES.has(name.toLowerCase().replace(/[-_]/g, ''));
}

function safeText(value: string, ordinal: number): void {
  if (looksLikeSecret(value)) refuse('unsafe_content', ordinal);
}

/** Own only faithful JSON data: no lossy stringify coercion, descriptors or inherited fields. */
function ownJson(value: unknown, ordinal: number, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    safeText(value, ordinal);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    return refuse('invalid_json', ordinal);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) refuse('invalid_json', ordinal);
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          refuse('invalid_json', ordinal);
        }
        const item: unknown = descriptor.value;
        result.push(ownJson(item, ordinal, ancestors));
      }
      return Object.freeze(result);
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      refuse('invalid_json', ordinal);
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') refuse('invalid_json', ordinal);
      safeText(key, ordinal);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        refuse('invalid_json', ordinal);
      }
      const item: unknown = descriptor.value;
      if (
        credentialName(key) &&
        key.toLowerCase() !== 'signature' &&
        key.toLowerCase() !== 'sig' &&
        typeof item === 'string' &&
        item.length > 0
      ) {
        refuse('unsafe_content', ordinal);
      }
      Object.defineProperty(result, key, {
        value: ownJson(item, ordinal, ancestors),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function jsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (jsonArray(left)) {
    return (
      jsonArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index] ?? null))
    );
  }
  if (jsonArray(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = new Map(Object.entries(right));
  return (
    leftEntries.length === rightEntries.size &&
    leftEntries.every(([key, value]) => {
      const other = rightEntries.get(key);
      return other !== undefined && sameJson(value, other);
    })
  );
}

function projectedQuery(url: URL, ordinal: number): string {
  const parts = url.search
    .slice(1)
    .split('&')
    .filter((part) => {
      const name = new URLSearchParams(part).keys().next().value;
      return name === undefined || !credentialName(name);
    });
  const query = parts.join('&');
  safeText(query, ordinal);
  safeText(decodeURIComponent(query.replace(/\+/g, ' ')), ordinal);
  return query.length === 0 ? '' : `?${query}`;
}

function effectiveRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  ordinal: number,
): Request {
  try {
    return new Request(input, init);
  } catch {
    return refuse('invalid_request', ordinal);
  }
}

async function projectRequest(request: Request, ordinal: number): Promise<RequestProjection> {
  try {
    const url = new URL(request.url);
    if (url.username.length > 0 || url.password.length > 0) refuse('invalid_request', ordinal);
    safeText(url.origin, ordinal);
    safeText(decodeURIComponent(url.pathname), ordinal);
    const headers: Record<string, string> = {};
    for (const name of PROTOCOL_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) {
        safeText(value, ordinal);
        headers[name] = value;
      }
    }
    let body: RequestProjection['body'] = Object.freeze({ kind: 'none' });
    if (request.body !== null) {
      const raw = await request.clone().text();
      safeText(raw, ordinal);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        refuse('invalid_json', ordinal);
      }
      body = Object.freeze({ kind: 'json', value: ownJson(parsed, ordinal) });
    }
    return Object.freeze({
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      query: projectedQuery(url, ordinal),
      headers: Object.freeze(headers),
      body,
    });
  } catch (error) {
    throw sanitized(error, 'invalid_request', ordinal);
  }
}

function ownedResponse(response: RecordedResponse, ordinal: number): RecordedResponse {
  if (
    typeof response.body !== 'string' ||
    !Number.isInteger(response.status) ||
    (response.contentType !== undefined && typeof response.contentType !== 'string')
  ) {
    refuse('invalid_response', ordinal);
  }
  safeText(response.body, ordinal);
  if (response.contentType !== undefined) safeText(response.contentType, ordinal);
  // JSON and SSE data records get the contextual credential-field check as well as the scanner.
  for (const text of [
    response.body,
    ...response.body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5)),
  ]) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    ownJson(parsed, ordinal);
  }
  const result =
    response.contentType === undefined
      ? { status: response.status, body: response.body }
      : { status: response.status, contentType: response.contentType, body: response.body };
  try {
    responseFrom(result);
  } catch {
    refuse('invalid_response', ordinal);
  }
  return Object.freeze(result);
}

function responseFrom(response: RecordedResponse): Response {
  return new Response(
    [204, 205, 304].includes(response.status) && response.body === '' ? null : response.body,
    {
      status: response.status,
      headers: { 'content-type': response.contentType ?? 'application/json' },
    },
  );
}

function jsonObject(
  value: JsonValue | undefined,
  ordinal: number,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse('invalid_expectation', ordinal);
  }
  // Arrays have been excluded; iterating entries avoids asserting the remaining recursive union.
  return Object.fromEntries(Object.entries(value));
}

function ownExchangeValue(exchange: unknown, ordinal: number): ExpectedExchange {
  try {
    // Detach once, then inspect only the owned data, including fields not allowed by the schema.
    const data = jsonObject(ownJson(exchange, ordinal), ordinal);
    if (Object.keys(data).sort().join(',') !== 'request,response')
      refuse('invalid_expectation', ordinal);
    const request = jsonObject(data['request'], ordinal);
    if (Object.keys(request).sort().join(',') !== 'body,headers,method,origin,path,query')
      refuse('invalid_expectation', ordinal);
    const method = request['method'];
    const origin = request['origin'];
    const path = request['path'];
    const query = request['query'];
    if (
      typeof method !== 'string' ||
      typeof origin !== 'string' ||
      typeof path !== 'string' ||
      typeof query !== 'string'
    )
      refuse('invalid_expectation', ordinal);
    const url = new URL(`${origin}${path}${query}`);
    safeText(decodeURIComponent(path), ordinal);
    if (
      url.origin !== origin ||
      url.pathname !== path ||
      url.hash !== '' ||
      projectedQuery(url, ordinal) !== query
    )
      refuse('invalid_expectation', ordinal);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(jsonObject(request['headers'], ordinal))) {
      if (!PROTOCOL_HEADERS.has(name) || typeof value !== 'string')
        refuse('invalid_expectation', ordinal);
      headers[name] = value;
    }
    const body = jsonObject(request['body'], ordinal);
    const kind = body['kind'];
    const value = body['value'];
    if (
      (kind === 'none' && Object.keys(body).join(',') !== 'kind') ||
      (kind === 'json' &&
        (Object.keys(body).sort().join(',') !== 'kind,value' || value === undefined)) ||
      (kind !== 'none' && kind !== 'json')
    )
      refuse('invalid_expectation', ordinal);
    const response = jsonObject(data['response'], ordinal);
    if (Object.keys(response).some((key) => !['status', 'contentType', 'body'].includes(key)))
      refuse('invalid_expectation', ordinal);
    const status = response['status'];
    const responseBody = response['body'];
    const contentType = response['contentType'];
    if (
      typeof status !== 'number' ||
      typeof responseBody !== 'string' ||
      (contentType !== undefined && typeof contentType !== 'string')
    )
      refuse('invalid_expectation', ordinal);
    return Object.freeze({
      request: Object.freeze({
        method,
        origin,
        path,
        query,
        headers: Object.freeze(headers),
        body:
          kind === 'none'
            ? Object.freeze({ kind: 'none' })
            : Object.freeze({ kind: 'json', value: ownJson(value, ordinal) }),
      }),
      response: ownedResponse(
        contentType === undefined
          ? { status, body: responseBody }
          : { status, body: responseBody, contentType },
        ordinal,
      ),
    });
  } catch (error) {
    throw sanitized(error, 'invalid_expectation', ordinal);
  }
}

/** Every fetch failure is sticky; `assertConsumed` also refuses pending asynchronous inspections. */
export function createExchangeReplay(exchanges: readonly ExpectedExchange[]): {
  readonly fetch: FetchLike;
  readonly assertConsumed: () => void;
} {
  const expected: ExpectedExchange[] = [];
  let constructionOrdinal = 1;
  try {
    if (!Array.isArray(exchanges)) refuse('invalid_expectation', constructionOrdinal);
    for (let index = 0; index < exchanges.length; index += 1) {
      constructionOrdinal = index + 1;
      const descriptor = Object.getOwnPropertyDescriptor(exchanges, String(index));
      if (descriptor === undefined || !('value' in descriptor))
        refuse('invalid_expectation', constructionOrdinal);
      const exchange: unknown = descriptor.value;
      // ownExchange validates the shape after a faithful deep copy; keep its typed entry internal.
      expected.push(ownExchangeValue(exchange, constructionOrdinal));
    }
  } catch (error) {
    throw sanitized(error, 'invalid_expectation', constructionOrdinal);
  }
  Object.freeze(expected);
  let entered = 0;
  let inFlight = 0;
  let failure: ExchangeReplayError | undefined;
  const assertNotFailed = () => {
    if (failure !== undefined) throw failure;
  };
  const fetch: FetchLike = async (input, init) => {
    const ordinal = ++entered;
    inFlight += 1;
    try {
      assertNotFailed();
      const exchange = expected[ordinal - 1];
      if (exchange === undefined) refuse('over_consumed', ordinal);
      const request = await projectRequest(effectiveRequest(input, init, ordinal), ordinal);
      if (!sameJson(ownJson(request, ordinal), ownJson(exchange.request, ordinal)))
        refuse('request_mismatch', ordinal);
      assertNotFailed();
      return responseFrom(exchange.response);
    } catch (error) {
      failure ??= sanitized(error, 'invalid_request', ordinal);
      throw failure;
    } finally {
      inFlight -= 1;
    }
  };
  return Object.freeze({
    fetch,
    assertConsumed: () => {
      assertNotFailed();
      if (inFlight > 0) refuse('in_flight', entered);
      if (entered !== expected.length) refuse('under_consumed', entered + 1);
    },
  });
}

/** Record only complete validated exchanges; the forwarded Request retains authentication. */
export function recordExchangeFetch(realFetch: FetchLike): {
  readonly fetch: FetchLike;
  readonly exchanges: readonly ExpectedExchange[];
} {
  let entered = 0;
  const successful = new Map<number, ExpectedExchange>();
  const fetch: FetchLike = async (input, init) => {
    const ordinal = ++entered;
    try {
      const effective = effectiveRequest(input, init, ordinal);
      const request = await projectRequest(effective, ordinal);
      let response: Response;
      try {
        response = await realFetch(effective);
      } catch {
        refuse('network_failure', ordinal);
      }
      let body: string;
      try {
        body = await response.clone().text();
      } catch {
        refuse('invalid_response', ordinal);
      }
      const contentType = response.headers.get('content-type');
      const recorded = ownedResponse(
        contentType === null
          ? { status: response.status, body }
          : { status: response.status, contentType, body },
        ordinal,
      );
      successful.set(ordinal, Object.freeze({ request, response: recorded }));
      return response;
    } catch (error) {
      throw sanitized(error, 'invalid_response', ordinal);
    }
  };
  return Object.freeze({
    fetch,
    get exchanges() {
      return Object.freeze(
        [...successful].sort(([left], [right]) => left - right).map(([, exchange]) => exchange),
      );
    },
  });
}
