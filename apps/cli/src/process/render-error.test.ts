import { describe, expect, it } from 'vitest';
import { makeLlmError } from '@relavium/llm';

import { CliError } from './errors.js';
import type { CliIo } from './io.js';
import { renderError } from './render-error.js';

const overlapShapes = ['normalized key', 'URL userinfo', 'Bearer', 'Basic'] as const;
type OverlapShape = (typeof overlapShapes)[number];

/** Synthetic independent values for actual raw and already-normalized diagnostic paths. */
function overlapValues(shape: OverlapShape): { readonly value: string; readonly secret: string }[] {
  const separators = ['\n', '\t', ' \r\n\t '];
  if (shape === 'normalized key') {
    const controls = [
      '\u0001',
      '\u007f',
      '\u0085',
      '\u202e',
      '\u2066',
      '\x1b[31m',
      '\x1b[1 q',
      '\x1b]52;c;YWJj\x07',
      '\x1b]0;fixture\x1b\\',
      '\x1bPfixture\x07',
      '\x1bPfixture\x1b\\',
      '\x1b^fixture\x1b\\',
      '\x1b_fixture\x1b\\',
      '\x1bXfixture\x1b\\',
      '\x1bM',
      '\x1b]',
    ];
    const secret = 'AbCdEf0123456789xyzUVWXYZ';
    return controls.flatMap((control) =>
      [['sk-', control, 'ant-', 'api03-'].join(''), ['AI', control, 'za', 'SyA'].join('')].flatMap(
        (prefix) =>
          separators.map((separator) => ({ value: `${prefix}${separator}${secret}`, secret })),
      ),
    );
  }
  const secret =
    shape === 'URL userinfo'
      ? 'opaque-userinfo-P8'
      : shape === 'Bearer'
        ? 'opaque-header-Z29'
        : 'dXNlcjpvcGFxdWU=';
  return separators.map((separator) => ({
    value:
      shape === 'URL userinfo'
        ? `https://u${separator}ser:${secret}@provider.invalid/x`
        : `${shape}${separator}${secret}`,
    secret,
  }));
}

const ATTACK = '\x1b[2J\x1b]52;c;Zm9v\x07\x1bPtmux;\x1b\\\x9b2J\r\b\u202E';

function captureIo(): { readonly io: CliIo; readonly stderr: () => string } {
  const writes: string[] = [];
  return {
    io: {
      writeOut: () => {},
      writeErr: (text) => {
        writes.push(text);
      },
      writeErrAcknowledged: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
      env: {},
      stdoutIsTty: false,
      stdinIsTty: false,
      stdin: process.stdin,
    },
    stderr: () => writes.join(''),
  };
}

function messageFromJson(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('message' in value) ||
    typeof value.message !== 'string'
  ) {
    throw new Error('expected an error JSON envelope with a string message');
  }
  return value.message;
}

describe('renderError terminal projection', () => {
  it.each([
    { json: false, verbose: false },
    { json: false, verbose: true },
    { json: true, verbose: false },
    { json: true, verbose: true },
  ])('redacts new query-secret names in actual diagnostic output %j', (options) => {
    const capture = captureIo();
    const error = new CliError(
      'invalid_invocation',
      'request failed ?client_secret=opaque-value-Q7',
    );
    error.stack = 'safe outer frame ?refresh_token=opaque-stack-V9';
    renderError(error, options, capture.io);
    const output = capture.stderr();
    expect(output).not.toContain('opaque-value-Q7');
    expect(output).not.toContain('opaque-stack-V9');
    expect(output).toContain('?client_secret=[REDACTED]');
    if (options.json) {
      expect(messageFromJson(JSON.parse(output))).toBe('request failed ?client_secret=[REDACTED]');
      expect(output).not.toContain('safe outer frame');
    } else if (options.verbose) {
      expect(output).toContain('safe outer frame ?refresh_token=[REDACTED]');
    }
  });

  it('sanitizes the human diagnostic and its verbose stack without suppressing readable content (G34)', () => {
    const error = new CliError('invalid_invocation', `message visible${ATTACK}\nforged message`);
    error.stack = `stack visible${ATTACK}\nsecond stack line`;
    const capture = captureIo();

    renderError(error, { json: false, verbose: true }, capture.io);

    const output = capture.stderr();
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('message visible');
    expect(output).toContain('stack visible');
    expect(output).toContain('second stack line'); // a stack remains readable multiline prose
  });

  it.each([
    { label: 'human', json: false, verbose: false },
    { label: 'human verbose', json: false, verbose: true },
    { label: 'JSON', json: true, verbose: false },
    { label: 'JSON verbose', json: true, verbose: true },
  ])(
    'SECRETS_CAUSAL_RESIDUAL_SCRUB protects mixed credentials in $label diagnostics',
    (options) => {
      for (const name of [
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ]) {
        const query = `?${name}=opaque-query-value&ordinary=kept`;
        for (const { split, secret } of [
          {
            split: '?api_\nkey=opaque-residual-query-P8',
            secret: 'opaque-residual-query-P8',
          },
          {
            split: 'https://u\nser:opaque-userinfo-P8@provider.invalid/x',
            secret: 'opaque-userinfo-P8',
          },
          {
            split: ['sk-', 'ant-', 'api03-', '\n', 'AbCdEf0123456789xyz'].join(''),
            secret: 'AbCdEf0123456789xyz',
          },
        ]) {
          for (const text of [`${query}; credential: ${split}`, `credential: ${split}; ${query}`]) {
            const capture = captureIo();
            const error = new CliError('invalid_invocation', text);
            error.stack = `outer stack ${text}`;
            renderError(error, options, capture.io);
            const output = capture.stderr();
            expect(output, 'SECRETS_CAUSAL_RESIDUAL_SCRUB').not.toContain(secret);
            expect(output).not.toContain('opaque-query-value');
            expect(output).toContain('[REDACTED]');
            if (options.json) {
              expect(messageFromJson(JSON.parse(output))).toBe('[REDACTED]');
              expect(output).not.toContain('outer stack');
            }
          }
        }
      }
    },
  );

  it('SECRETS_CAUSAL_RESIDUAL_SCRUB protects a mixed-credential verbose stack with a benign message', () => {
    const capture = captureIo();
    const error = new CliError('invalid_invocation', 'request failed; retry after 30s');
    const split = '?api_\nkey=opaque-residual-query-P8';
    error.stack = `outer stack ?refresh_token=opaque-stack-value&ordinary=kept; key: ${split}`;
    renderError(error, { json: false, verbose: true }, capture.io);
    const output = capture.stderr();
    expect(output, 'SECRETS_CAUSAL_RESIDUAL_SCRUB').not.toContain('opaque-residual-query-P8');
    expect(output).not.toContain('opaque-stack-value');
    expect(output).toContain('request failed; retry after 30s');
    expect(output).toContain('[REDACTED]');
  });

  it.each([
    { label: 'human', json: false, verbose: false },
    { label: 'human verbose', json: false, verbose: true },
    { label: 'JSON', json: true, verbose: false },
    { label: 'JSON verbose', json: true, verbose: true },
  ])(
    'SECRETS_CAUSAL_PREFIX_ORDER protects overlapping query values in $label diagnostics',
    (options) => {
      const suffix = 'AbCdEf0123456789xyzUVWXYZ';
      for (const name of [
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ]) {
        for (const prefix of [['sk-', 'ant-', 'api03-'].join(''), ['AI', 'za', 'SyA'].join('')]) {
          for (const separator of ['\n', '\t', ' \r\n\t ']) {
            const text = `?${name}=${prefix}${separator}${suffix}`;
            const llmError = makeLlmError({ provider: 'openai', kind: 'auth', message: text });
            for (const projection of [text, llmError.message]) {
              const capture = captureIo();
              const error = new CliError('invalid_invocation', projection);
              error.stack = `outer stack ${projection}`;
              renderError(error, options, capture.io);
              const output = capture.stderr();
              expect(output, 'SECRETS_CAUSAL_PREFIX_ORDER').not.toContain(suffix);
              expect(output).toContain('[REDACTED]');
              if (options.json) {
                expect(messageFromJson(JSON.parse(output))).toBe('[REDACTED]');
                expect(output).not.toContain('outer stack');
              }
            }
          }
        }
      }
    },
  );

  it('SECRETS_CAUSAL_PREFIX_ORDER protects a pre-scrubbed overlapping query in a verbose stack', () => {
    const suffix = 'AbCdEf0123456789xyzUVWXYZ';
    const query = `?refresh_token=${['sk-', 'ant-', 'api03-', '\n', suffix].join('')}`;
    const llmError = makeLlmError({ provider: 'openai', kind: 'auth', message: query });
    const error = new CliError('invalid_invocation', 'request failed; retry after 30s');
    error.stack = `outer stack ${llmError.message}`;
    const capture = captureIo();
    renderError(error, { json: false, verbose: true }, capture.io);
    const output = capture.stderr();
    expect(output, 'SECRETS_CAUSAL_PREFIX_ORDER').not.toContain(suffix);
    expect(output).toContain('request failed; retry after 30s');
    expect(output).toContain('[REDACTED]');
  });

  it.each(
    [
      { label: 'human', json: false, verbose: false },
      { label: 'human verbose', json: false, verbose: true },
      { label: 'JSON', json: true, verbose: false },
      { label: 'JSON verbose', json: true, verbose: true },
    ].flatMap((mode) => overlapShapes.map((shape) => ({ ...mode, shape }))),
  )(
    'SECRETS_CAUSAL_OVERLAP_ORDER protects $shape query values in $label diagnostics',
    (options) => {
      for (const name of [
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ]) {
        for (const { value, secret } of overlapValues(options.shape)) {
          const text = `?${name}=${value}`;
          const llmError = makeLlmError({
            provider: 'openai',
            kind: 'auth',
            message: text,
            code: text,
          });
          for (const projection of [text, llmError.message, llmError.code ?? '']) {
            const capture = captureIo();
            const error = new CliError('invalid_invocation', projection);
            error.stack = `outer stack ${projection}`;
            renderError(error, options, capture.io);
            const output = capture.stderr();
            expect(output, 'SECRETS_CAUSAL_OVERLAP_ORDER').not.toContain(secret);
            expect(output).toContain('[REDACTED]');
            if (options.json) {
              expect(messageFromJson(JSON.parse(output))).not.toContain(secret);
              expect(output).not.toContain('outer stack');
            }
          }
        }
      }
    },
  );

  it.each(overlapShapes)(
    'SECRETS_CAUSAL_OVERLAP_ORDER protects a pre-scrubbed %s in a verbose stack',
    (shape) => {
      for (const { value, secret } of overlapValues(shape)) {
        const text = `?refresh_token=${value}`;
        const llmError = makeLlmError({
          provider: 'openai',
          kind: 'auth',
          message: text,
          code: text,
        });
        for (const projection of [llmError.message, llmError.code ?? '']) {
          const error = new CliError('invalid_invocation', 'request failed; retry after 30s');
          error.stack = `outer stack ${projection}`;
          const capture = captureIo();
          renderError(error, { json: false, verbose: true }, capture.io);
          const output = capture.stderr();
          expect(output, 'SECRETS_CAUSAL_OVERLAP_ORDER').not.toContain(secret);
          expect(output).toContain('request failed; retry after 30s');
          expect(output).toContain('[REDACTED]');
        }
      }
    },
  );

  it('sanitizes JSON diagnostic values and never appends a raw verbose stack', () => {
    const error = new CliError('invalid_invocation', `message visible${ATTACK}\nforged message`);
    error.stack = `stack visible${ATTACK}`;
    const capture = captureIo();

    renderError(error, { json: true, verbose: true }, capture.io);

    const output = capture.stderr();
    expect(output).not.toContain('\u202E');
    expect(output).not.toContain('stack visible');
    const message = messageFromJson(JSON.parse(output));
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(message).not.toContain(forbidden);
    }
    expect(message).toContain('message visible');
  });
});
