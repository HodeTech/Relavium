import { describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import type { CliIo } from './io.js';
import { renderError } from './render-error.js';

const ATTACK = '\x1b[2J\x1b]52;c;Zm9v\x07\x1bPtmux;\x1b\\\x9b2J\r\b\u202E';

function captureIo(): { readonly io: CliIo; readonly stderr: () => string } {
  const writes: string[] = [];
  return {
    io: {
      writeOut: () => {},
      writeErr: (text) => {
        writes.push(text);
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
