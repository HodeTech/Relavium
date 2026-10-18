import { describe, expect, it } from 'vitest';
import { CLI_ERROR_POLICY } from './cli-error.js';
import { formatFixedDiagnostic, type FixedDiagnosticKind } from './fixed-diagnostic.js';

const kinds: readonly FixedDiagnosticKind[] = [
  'cli_internal',
  'output_unavailable',
  'background_failure',
  'background_suppressed',
];

describe('fixed native diagnostics', () => {
  it.each(kinds)(
    'projects %s as a single fixed stderr JSON envelope at every verbosity',
    (kind) => {
      const expectedCode = kind === 'output_unavailable' ? kind : 'cli_internal';
      const messages = {
        cli_internal: CLI_ERROR_POLICY.cli_internal.fixedMessage,
        output_unavailable: CLI_ERROR_POLICY.output_unavailable.fixedMessage,
        background_failure:
          'A background operation failed. Inspect existing work before repeating paid or effectful operations.',
        background_suppressed:
          'Further background failures suppressed. Inspect existing work before repeating paid or effectful operations.',
      };
      for (const verbosity of ['quiet', 'normal', 'verbose'] as const) {
        const text = formatFixedDiagnostic(kind, { json: true, verbosity });
        expect(text).toBe(
          `${JSON.stringify({ type: 'error', code: expectedCode, message: messages[kind] })}\n`,
        );
        expect(text.split('\n')).toHaveLength(2);
      }
    },
  );

  it.each(kinds)('human %s uses the same authored message without JSON decoration', (kind) => {
    const json: unknown = JSON.parse(
      formatFixedDiagnostic(kind, { json: true, verbosity: 'normal' }),
    );
    expect(json).toHaveProperty('message');
    const message: unknown =
      typeof json === 'object' && json !== null
        ? Object.getOwnPropertyDescriptor(json, 'message')?.value
        : undefined;
    if (typeof message !== 'string') throw new Error('fixed envelope requires a message');
    expect(formatFixedDiagnostic(kind, { json: false, verbosity: 'verbose' })).toBe(
      `relavium: ${message}\n`,
    );
  });
});
