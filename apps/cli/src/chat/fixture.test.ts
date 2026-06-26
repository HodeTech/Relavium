import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cassetteResolver, loadCassette, type Cassette } from './fixture.js';

const VALID: Cassette = {
  schema_version: '1.0',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  calls: [
    [
      { type: 'text_delta', text: 'hi' },
      { type: 'stop', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
    ],
  ],
};

describe('loadCassette + cassetteResolver (2.Q)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-cassette-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    writeFileSync(join(cwd, name), content, 'utf8');
    return name;
  }

  it('loads a valid cassette resolved relative to cwd', () => {
    write('c.json', JSON.stringify(VALID));
    const cassette = loadCassette('c.json', cwd);
    expect(cassette.provider).toBe('anthropic');
    expect(cassette.calls).toHaveLength(1);
  });

  it('rejects a missing file as a clean exit-2 fault', () => {
    expect(() => loadCassette('nope.json', cwd)).toThrow(/cannot read fixture/);
  });

  it('rejects invalid JSON as a clean exit-2 fault', () => {
    write('bad.json', '{ not json');
    expect(() => loadCassette('bad.json', cwd)).toThrow(/not valid JSON/);
  });

  it('rejects an unknown schema_version as a clean exit-2 fault', () => {
    write('v.json', JSON.stringify({ ...VALID, schema_version: '2.0' }));
    expect(() => loadCassette('v.json', cwd)).toThrow(/not a valid cassette/);
  });

  it('rejects a malformed StreamChunk as a clean exit-2 fault (boundary validation)', () => {
    write('chunk.json', JSON.stringify({ ...VALID, calls: [[{ type: 'bogus_chunk' }]] }));
    expect(() => loadCassette('chunk.json', cwd)).toThrow(/not a valid cassette/);
  });

  it('cassetteResolver answers ONLY the cassette provider and returns a non-secret key', () => {
    const resolver = cassetteResolver(VALID);
    expect(resolver.resolveProvider('openai')).toBeUndefined(); // not the cassette's provider
    expect(resolver.resolveProvider('anthropic')).toBeDefined();
    expect(resolver.keyFor('anthropic')).toBe('fixture-key'); // offline marker, never a real key
    // (Replay-order + the unscripted-call throw are exercised end-to-end by the agent-run integration tests.)
  });
});
