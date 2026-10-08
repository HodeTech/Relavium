/** Maintainer-only live fixture capture (ADR-0096). No classification is inferred here. */
import { openDeadline, type SetDeadlineTimer } from '@relavium/shared';
import { z } from 'zod';

import { scrubSecrets } from '../llm-error.js';

export const CAPTURE_TIMEOUT_MS = 60_000;
export const CAPTURE_MAX_RESPONSE_BYTES = 1_048_576;
export const CAPTURE_MAX_INPUT_CHARACTERS = 8_388_608;
export const CAPTURE_TOOL_VERSION = 'w7-overflow-capture-v2';
const MAX_OVERFLOW_OUTPUT_TOKENS = 4096;
const MAX_CONTEXT_STOP_OUTPUT_TOKENS = 16_384;
const MAX_RESPONSE_CHUNKS = 16_384;

const CaptureOptionsSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'deepseek', 'gemini']),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    inputCharacters: z.number().int().min(1024).max(CAPTURE_MAX_INPUT_CHARACTERS),
    maxOutputTokens: z.number().int().min(1).max(MAX_CONTEXT_STOP_OUTPUT_TOKENS),
    purpose: z.enum(['overflow', 'context-stop-probe']),
    out: z
      .string()
      .min(1)
      .max(4096)
      // eslint-disable-next-line no-control-regex -- Reject NUL/control bytes in a filesystem destination.
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict()
  .refine((value) => value.purpose !== 'context-stop-probe' || value.provider === 'anthropic')
  .refine(
    (value) =>
      value.purpose === 'context-stop-probe' || value.maxOutputTokens <= MAX_OVERFLOW_OUTPUT_TOKENS,
  );

export type CaptureOptions = z.infer<typeof CaptureOptionsSchema>;
export type CaptureFailureCode =
  | 'invalid_arguments'
  | 'invalid_key'
  | 'timeout'
  | 'cancelled'
  | 'transport'
  | 'response_limit'
  | 'response_not_json'
  | 'secret_in_response'
  | 'destination_changed';

export class CaptureError extends Error {
  readonly code: CaptureFailureCode;
  constructor(code: CaptureFailureCode) {
    super(`overflow capture refused: ${code}`);
    this.name = 'CaptureError';
    this.code = code;
  }
}

/** Strict finite arguments; unknown/duplicate flags refuse before a key or network is touched. */
export function parseCaptureArguments(args: readonly string[]): CaptureOptions {
  const flags = new Map<string, string>();
  const allowed = new Set([
    '--provider',
    '--model',
    '--input-chars',
    '--max-output',
    '--purpose',
    '--out',
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !allowed.has(flag) || flags.has(flag) || value === undefined) {
      throw new CaptureError('invalid_arguments');
    }
    flags.set(flag, value);
  }
  const integer = (value: string | undefined): number =>
    value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : NaN;
  const parsed = CaptureOptionsSchema.safeParse({
    provider: flags.get('--provider'),
    model: flags.get('--model'),
    inputCharacters: integer(flags.get('--input-chars')),
    maxOutputTokens: integer(flags.get('--max-output') ?? '64'),
    purpose: flags.get('--purpose') ?? 'overflow',
    out: flags.get('--out'),
  });
  if (!parsed.success) throw new CaptureError('invalid_arguments');
  if (scrubSecrets(parsed.data.model) !== parsed.data.model) {
    throw new CaptureError('invalid_arguments');
  }
  return parsed.data;
}

export function validateCaptureKey(key: string): void {
  if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw new CaptureError('invalid_key');
}

export function validateCaptureInput(options: CaptureOptions, key: string): void {
  validateCaptureKey(key);
  // Re-validate the runtime boundary too: callers cannot bypass fixed-host/path and allocation bounds.
  if (!CaptureOptionsSchema.safeParse(options).success) throw new CaptureError('invalid_arguments');
  if (
    options.model.includes(key) ||
    options.out.includes(key) ||
    scrubSecrets(options.model) !== options.model
  ) {
    throw new CaptureError('invalid_arguments');
  }
}

/** Only synthetic ASCII enters the request. No configurable endpoint, tools, files or user prompt. */
export function captureRequest(
  options: CaptureOptions,
  key: string,
): { url: string; init: RequestInit } {
  validateCaptureInput(options, key);
  const pattern = '0123456789 abcdefghijklmnopqrstuvwxyz\n';
  const filler = pattern.repeat(Math.ceil(options.inputCharacters / pattern.length));
  const instruction =
    options.purpose === 'context-stop-probe'
      ? '\nIgnore the filler above. Print all integers from 1 through 1000000, in order, separated by spaces. Do not summarize, abbreviate, add commentary or stop at a smaller number. Continue until the server stops generation.'
      : '\nReturn only OK.';
  const text = filler.slice(0, options.inputCharacters) + instruction;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url: string;
  let body: unknown;
  switch (options.provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/messages';
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: options.model,
        max_tokens: options.maxOutputTokens,
        stream: false,
        messages: [{ role: 'user', content: text }],
      };
      break;
    case 'openai':
    case 'deepseek':
      url =
        options.provider === 'openai'
          ? 'https://api.openai.com/v1/chat/completions'
          : 'https://api.deepseek.com/chat/completions';
      headers['authorization'] = `Bearer ${key}`;
      body = {
        model: options.model,
        [options.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']:
          options.maxOutputTokens,
        stream: false,
        messages: [{ role: 'user', content: text }],
      };
      break;
    case 'gemini':
      url = `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`;
      headers['x-goog-api-key'] = key;
      body = {
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { maxOutputTokens: options.maxOutputTokens },
      };
      break;
  }
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' } };
}

export interface CaptureArtifact {
  readonly captureTool: typeof CAPTURE_TOOL_VERSION;
  readonly capturedAt: string;
  readonly provider: CaptureOptions['provider'];
  readonly model: string;
  readonly purpose: CaptureOptions['purpose'];
  readonly syntheticInputCharacters: number;
  readonly maxOutputTokens: number;
  readonly response: {
    readonly status: number;
    readonly contentType: 'application/json';
    readonly body: string;
  };
}

export interface CaptureDependencies {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly newAbortController: () => AbortController;
  readonly setTimer: SetDeadlineTimer;
  readonly now: () => string;
  readonly signal?: AbortSignal;
}

/** Inspect EVERY decoded JSON string, including values overwritten by duplicate object members. */
function assertSafeBody(body: string, key: string): void {
  try {
    JSON.parse(body); // Validate the grammar before scanning its string tokens.
  } catch {
    throw new CaptureError('response_not_json');
  }
  if (body.includes(key) || scrubSecrets(body) !== body) {
    throw new CaptureError('secret_in_response');
  }
  // The alternatives are disjoint: ordinary bytes cannot be quotes or backslashes. The validated JSON
  // grammar makes each match an independently parseable string. Traversing the parsed object alone loses
  // overwritten duplicate values while the exact raw body retains them, leaving an escaped-key bypass.
  for (const token of body.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const value: unknown = JSON.parse(token[0]);
    if (typeof value !== 'string' || value.includes(key) || scrubSecrets(value) !== value) {
      throw new CaptureError('secret_in_response');
    }
  }
}

/** One request, zero retries. Header wait and every body read share one absolute hard deadline. */
export async function captureResponse(
  options: CaptureOptions,
  key: string,
  deps: CaptureDependencies,
): Promise<CaptureArtifact> {
  const request = captureRequest(options, key);
  const controller = deps.newAbortController();
  const deadline = openDeadline(CAPTURE_TIMEOUT_MS, () => controller, deps.setTimer, deps.signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (deps.signal?.aborted) throw new CaptureError('cancelled');
    const fetched = await deadline.race(
      deps.fetch(request.url, { ...request.init, signal: controller.signal }),
    );
    if (fetched.outcome !== 'settled') throw new CaptureError('timeout');
    const response = fetched.value;
    if (
      (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    ) {
      throw new CaptureError('response_not_json');
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > CAPTURE_MAX_RESPONSE_BYTES) {
      throw new CaptureError('response_limit');
    }
    reader = response.body?.getReader();
    if (reader === undefined) throw new CaptureError('response_not_json');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let chunks = 0;
    let body = '';
    for (;;) {
      const read = await deadline.race(reader.read());
      if (read.outcome !== 'settled') throw new CaptureError('timeout');
      if (read.value.done) break;
      chunks += 1;
      if (chunks > MAX_RESPONSE_CHUNKS) throw new CaptureError('response_limit');
      bytes += read.value.value.byteLength;
      if (bytes > CAPTURE_MAX_RESPONSE_BYTES) throw new CaptureError('response_limit');
      body += decoder.decode(read.value.value, { stream: true });
    }
    body += decoder.decode();
    assertSafeBody(body, key);
    const capturedAt = z.string().datetime({ offset: true }).safeParse(deps.now());
    if (!capturedAt.success) throw new CaptureError('invalid_arguments');
    const artifact: CaptureArtifact = {
      captureTool: CAPTURE_TOOL_VERSION,
      capturedAt: capturedAt.data,
      provider: options.provider,
      model: options.model,
      purpose: options.purpose,
      syntheticInputCharacters: options.inputCharacters,
      maxOutputTokens: options.maxOutputTokens,
      response: { status: response.status, contentType: 'application/json', body },
    };
    // Also cover metadata/field names: even an accidentally pasted opaque key cannot survive by
    // coinciding with the timestamp or a fixed artifact label. The response byte cap bounds this scan.
    assertSafeBody(JSON.stringify(artifact), key);
    return artifact;
  } catch (error) {
    if (deadline.classify() === 'caller') throw new CaptureError('cancelled');
    if (deadline.classify() === 'deadline') throw new CaptureError('timeout');
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('transport'); // Never carry a transport/body error or its cause into output.
  } finally {
    deadline.dispose();
    controller.abort();
    // A refused stream may ignore cancel; cleanup must not defeat the caller's hard deadline.
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
  }
}
