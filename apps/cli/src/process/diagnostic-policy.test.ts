import { describe, expect, it } from 'vitest';

import {
  resolveDiagnosticPolicy,
  shouldEmitCategory,
  type DiagnosticPolicy,
  type OutputCategory,
} from './diagnostic-policy.js';

describe('diagnostic policy resolution', () => {
  it.each([undefined, '', '0', 'false', 'TRUE', '01', '1'])(
    'enables the debug alias only for exact RELAVIUM_DEBUG=%s',
    (value) => {
      expect(resolveDiagnosticPolicy({}, { RELAVIUM_DEBUG: value })).toEqual({
        json: false,
        verbosity: value === '1' ? 'verbose' : 'normal',
      });
    },
  );

  it.each([undefined, '', '0', '1'])(
    'preserves explicit quiet and verbose precedence over environment %s',
    (value) => {
      const env = { RELAVIUM_DEBUG: value };
      expect(resolveDiagnosticPolicy({ quiet: true }, env)).toEqual({
        json: false,
        verbosity: 'quiet',
      });
      expect(resolveDiagnosticPolicy({ verbose: true }, env)).toEqual({
        json: false,
        verbosity: 'verbose',
      });
    },
  );

  it.each([false, true])('refuses quiet plus verbose with JSON=%s', (json) => {
    let failure: unknown;
    try {
      resolveDiagnosticPolicy({ quiet: true, verbose: true, json }, { RELAVIUM_DEBUG: '1' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'invalid_invocation', exitCode: 2 });
  });

  it.each([{}, { CI: 'true' }, { TERM: 'dumb' }, { NO_COLOR: '1' }, { FORCE_COLOR: '1' }])(
    'never infers JSON or verbosity from unrelated environment %j',
    (env) => {
      expect(resolveDiagnosticPolicy({}, env)).toEqual({ json: false, verbosity: 'normal' });
      expect(resolveDiagnosticPolicy({ json: true }, env)).toEqual({
        json: true,
        verbosity: 'normal',
      });
    },
  );

  it('does not mutate supplied flags or environment', () => {
    const flags = Object.freeze({ quiet: true, json: true });
    const env = Object.freeze({ RELAVIUM_DEBUG: '1' });
    expect(resolveDiagnosticPolicy(flags, env)).toEqual({ json: true, verbosity: 'quiet' });
    expect(flags).toEqual({ quiet: true, json: true });
    expect(env).toEqual({ RELAVIUM_DEBUG: '1' });
  });
});

describe('diagnostic output categories', () => {
  const cases: readonly {
    readonly policy: DiagnosticPolicy;
    readonly decoration: boolean;
    readonly notice: boolean;
    readonly detail: boolean;
  }[] = [
    {
      policy: { json: false, verbosity: 'quiet' },
      decoration: false,
      notice: false,
      detail: false,
    },
    { policy: { json: false, verbosity: 'normal' }, decoration: true, notice: true, detail: false },
    { policy: { json: false, verbosity: 'verbose' }, decoration: true, notice: true, detail: true },
    { policy: { json: true, verbosity: 'quiet' }, decoration: false, notice: false, detail: false },
    { policy: { json: true, verbosity: 'normal' }, decoration: false, notice: true, detail: false },
    { policy: { json: true, verbosity: 'verbose' }, decoration: false, notice: true, detail: true },
  ];

  it.each(cases)('keeps requested/safety/compatibility output under $policy', ({ policy }) => {
    const preserved: readonly OutputCategory[] = ['requested', 'safety', 'compatibility'];
    for (const category of preserved) expect(shouldEmitCategory(policy, category)).toBe(true);
  });

  it.each(cases)(
    'applies decoration/notice/detail policy under $policy',
    ({ policy, decoration, notice, detail }) => {
      expect(shouldEmitCategory(policy, 'decoration')).toBe(decoration);
      expect(shouldEmitCategory(policy, 'notice')).toBe(notice);
      expect(shouldEmitCategory(policy, 'detail')).toBe(detail);
    },
  );
});
