import { describe, expect, it, vi } from 'vitest';

import { captureIo } from '../test-support.js';
import { warnSnapshotLiterals } from './snapshot-notice.js';

describe('authored snapshot credential notice', () => {
  it('detects existing credential shapes without values or arbitrary keys in the notice', () => {
    const key = 'sk-syntheticSnapshotCredential123456789';
    const definition = {
      metadata: { privatePropertyLabel: key },
      prompt: 'Bearer synthetic-bearer',
      env: { TOKEN: 'https://synthetic:password@example.invalid/' },
      default: 'https://example.invalid/?client_secret=synthetic-query',
    };
    const original = structuredClone(definition);
    const { io, out, err } = captureIo();
    warnSnapshotLiterals(definition, io);
    expect(err(), 'SNAPSHOT_CAUSAL_DETECTOR').toContain(
      '4 string(s) matching known credential shapes',
    );
    expect(err()).not.toContain(key);
    expect(err()).not.toContain('privatePropertyLabel');
    expect(err()).not.toContain('synthetic');
    expect(out()).toBe('');
    expect(definition).toEqual(original);
  });

  it('counts a matching arbitrary property name without printing it', () => {
    const key = 'AIzaSyntheticSnapshotKey1234567890';
    const { io, err } = captureIo();
    warnSnapshotLiterals({ metadata: { [key]: 'benign' } }, io);
    expect(err()).toContain('1 string(s) matching known credential shapes');
    expect(err()).not.toContain(key);
  });

  it('keeps ordinary literals and unresolved placeholders quiet within the finite authority', () => {
    const { io, err } = captureIo();
    warnSnapshotLiterals(
      {
        env: { TOKEN: '{{secrets.gh}}', AUTH: 'Bearer {{secrets.token}}' },
        prompt: 'Use {{ inputs.topic }} with sk-short and AIza-short.',
        metadata: { token: 'ordinary-value', ghp: 'ghp_notARecognizedFamilyHere' },
        url: 'https://example.invalid/?monkey=banana&token_count=7',
        templatedUrl: 'https://example.invalid/?token={{inputs.token}}',
      },
      io,
    );
    expect(err()).toBe('');
  });

  it('does not exempt credential literals beside placeholders or inside filter arguments', () => {
    const literal = 'sk-templateSyntheticCredential123456789';
    const { io, err } = captureIo();
    warnSnapshotLiterals(
      {
        prompt: `{{inputs.topic}} ${literal}`,
        fallback: `{{inputs.topic | default("${literal}")}}`,
        disguised: `{{secrets.${literal}}}`,
        path: `{{inputs.topic.${literal}}}`,
        unknown: `{{env.${literal}}}`,
        malformed: `{{secrets.${literal}`,
      },
      io,
    );
    expect(err()).toContain('6 string(s) matching known credential shapes');
    expect(err()).not.toContain(literal);
  });

  it('reports incomplete scanning for an oversized string without claiming safety', () => {
    const { io, err } = captureIo();
    warnSnapshotLiterals(
      { prompt: 'a'.repeat(16_385) + 'sk-hiddenSyntheticCredential123456789' },
      io,
    );
    expect(err()).toContain('scan is incomplete');
    expect(err()).not.toContain('matching known credential shapes');
    expect(err()).not.toContain('sk-hidden');
  });

  it('bounds aggregate string work and leaves a credential beyond the budget unclassified', () => {
    const { io, err } = captureIo();
    warnSnapshotLiterals(
      [...Array.from({ length: 16 }, () => 'a'.repeat(16_384)), 'sk-beyondBudget123456789'],
      io,
    );
    expect(err()).toContain('scan is incomplete');
    expect(err()).not.toContain('matching known credential shapes');
  });

  it('does not invoke accessors or proxy traps even behind a huge property name', () => {
    const getter = vi.fn(() => 'sk-getterCredential123456789');
    const trap = vi.fn(() => {
      throw new Error('must not run');
    });
    const object = Object.defineProperties(
      {},
      {
        ordinary: { enumerable: true, get: getter },
        ['x'.repeat(100_000)]: { enumerable: true, get: getter },
      },
    );
    const { io, err } = captureIo();
    warnSnapshotLiterals([object, new Proxy({}, { getPrototypeOf: trap, ownKeys: trap })], io);
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(err()).toContain('scan is incomplete');
    expect(err()).not.toContain('matching known credential shapes');
  });

  it('bounds sparse array traversal before a remote getter', () => {
    const getter = vi.fn(() => 'sk-arrayCredential123456789');
    const array: unknown[] = [];
    Object.defineProperty(array, 1_000_000_000, { enumerable: true, get: getter });
    const { io, err } = captureIo();
    warnSnapshotLiterals(array, io);
    expect(getter).not.toHaveBeenCalled();
    expect(err()).toContain('scan is incomplete');
  });

  it('bounds depth and marks repeated object identities incomplete without recursion failure', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    let deep: unknown = 'sk-beyondDepth123456789';
    for (let i = 0; i < 100; i += 1) deep = { child: deep };
    const { io, err } = captureIo();
    warnSnapshotLiterals({ cycle, deep }, io);
    expect(err()).toContain('scan is incomplete');
    expect(err()).not.toContain('matching known credential shapes');
  });

  it('bounds record-node visits before a later matching field', () => {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < 4_096; i += 1) record[`field${i}`] = 0;
    record['late'] = 'sk-beyondNodes123456789';
    const { io, err } = captureIo();
    warnSnapshotLiterals(record, io);
    expect(err()).toContain('scan is incomplete');
    expect(err()).not.toContain('matching known credential shapes');
  });
});
