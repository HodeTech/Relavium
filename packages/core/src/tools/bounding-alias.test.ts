import { describe, expect, it, vi } from 'vitest';

import { boundForModel, redactInlineMedia, redactSecretShapedValue } from './bounding.js';

const WALKERS = [
  { name: 'media', walk: redactInlineMedia },
  { name: 'secret', walk: redactSecretShapedValue },
];

describe.each(WALKERS)('W3S5 #94 $name path-local projection', ({ walk }) => {
  it('ALIAS_OBJECT expands shared siblings and object-array-object joins', () => {
    const shared = { label: 'alice' };
    const source = { left: shared, right: shared, nested: [shared] };
    expect(walk(source), 'ALIAS_OBJECT').toEqual({
      left: { label: 'alice' },
      right: { label: 'alice' },
      nested: [{ label: 'alice' }],
    });
    expect(source.left).toBe(source.right);
    expect(source.nested[0]).toBe(shared);
  });

  it('ALIAS_ARRAY expands shared arrays and array-object-array joins', () => {
    const shared = ['first', { label: 'bob' }];
    const source = [shared, { nested: shared }, shared];
    expect(walk(source), 'ALIAS_ARRAY').toEqual([
      ['first', { label: 'bob' }],
      { nested: ['first', { label: 'bob' }] },
      ['first', { label: 'bob' }],
    ]);
    expect(source[0]).toBe(shared);
    expect(source[2]).toBe(shared);
  });

  it('ALIAS_NULL_PROTOTYPE expands clean null-prototype siblings', () => {
    const shared = { label: 'null-prototype' };
    Object.setPrototypeOf(shared, null);
    expect(walk({ left: shared, right: shared }), 'ALIAS_NULL_PROTOTYPE').toEqual({
      left: { label: 'null-prototype' },
      right: { label: 'null-prototype' },
    });
    expect(Object.getPrototypeOf(shared)).toBeNull();
  });

  it('CYCLE_OBJECT marks only the self back-reference and re-expands the next sibling', () => {
    const self: Record<string, unknown> = { label: 'self' };
    self['back'] = self;
    expect(walk({ first: self, second: self }), 'CYCLE_OBJECT').toEqual({
      first: { label: 'self', back: '[cyclic]' },
      second: { label: 'self', back: '[cyclic]' },
    });
    expect(self['back']).toBe(self);
  });

  it('CYCLE_ARRAY marks self-array ancestry while preserving later aliases', () => {
    const self: unknown[] = ['self'];
    self.push(self);
    expect(walk([self, self]), 'CYCLE_ARRAY').toEqual([
      ['self', '[cyclic]'],
      ['self', '[cyclic]'],
    ]);
    expect(self[1]).toBe(self);
  });

  it('CYCLE_MUTUAL marks mutual object-array ancestry at the actual back-reference', () => {
    const object: Record<string, unknown> = { label: 'mutual' };
    const array: unknown[] = [object];
    object['children'] = array;
    expect(walk({ object, array }), 'CYCLE_MUTUAL').toEqual({
      object: { label: 'mutual', children: ['[cyclic]'] },
      array: [{ label: 'mutual', children: '[cyclic]' }],
    });
  });

  it('ALIAS_NATIVE unwinds Date and nonplain native early returns', () => {
    const date = new Date('2026-10-16T00:00:00.000Z');
    const native = new Map([['label', 'map']]);
    expect(walk({ dates: [date, date], natives: [native, native] }), 'ALIAS_NATIVE').toEqual({
      dates: [date, date],
      natives: [native, native],
    });
  });
});

describe('W3S5 #94 specialized projection arms', () => {
  it('ALIAS_MEDIA repeats byte-free canonical, data-URI and binary markers', () => {
    const data = 'U1lOVEhFVElDX01FRElBX0NBTkFSWQ==';
    const canonical = { kind: 'base64', data };
    const uri = `data:image/png;base64,${data}`;
    const bytes = new Uint8Array([11, 22, 33]);
    const buffer = bytes.buffer;
    const projected = redactInlineMedia({
      canonical: [canonical, canonical],
      uris: [uri, uri],
      bytes: [bytes, bytes],
      buffers: [buffer, buffer],
    });
    expect(projected, 'ALIAS_MEDIA').toEqual({
      canonical: [
        { kind: 'base64', base64Length: data.length },
        { kind: 'base64', base64Length: data.length },
      ],
      uris: ['[base64 data URI omitted]', '[base64 data URI omitted]'],
      bytes: ['[binary buffer omitted]', '[binary buffer omitted]'],
      buffers: ['[binary buffer omitted]', '[binary buffer omitted]'],
    });
    expect(JSON.stringify(projected)).not.toContain(data);
    expect(canonical.data).toBe(data);
    expect(bytes).toEqual(new Uint8Array([11, 22, 33]));
  });

  it('ALIAS_CREDENTIAL keeps key, scheme, embedded-token and argv redaction on every alias', () => {
    const credential = {
      api_key: 'synthetic-opaque-value',
      pin: 7391,
      Authorization: 'Bearer syntheticBearerValue',
      mixed: 'xoxb-1234567890-glpat-abcdefghijklmnop',
      author: 'Ada',
      tokenizer: 'plain',
      pinned: true,
    };
    const argv = ['--token', 'synthetic-flag-value', '-p', '2222', '-p', '8080:80'];
    const expected = {
      api_key: '[redacted]',
      pin: '[redacted]',
      Authorization: 'Bearer [redacted]',
      mixed: '[redacted]',
      author: 'Ada',
      tokenizer: 'plain',
      pinned: true,
    };
    const projected = redactSecretShapedValue({
      objects: [credential, credential],
      argv: [argv, argv],
    });
    expect(projected, 'ALIAS_CREDENTIAL').toEqual({
      objects: [expected, expected],
      argv: [
        ['--token', '[redacted]', '-p', '2222', '-p', '8080:80'],
        ['--token', '[redacted]', '-p', '2222', '-p', '8080:80'],
      ],
    });
    const text = JSON.stringify(projected);
    for (const canary of [
      'synthetic-opaque-value',
      '7391',
      'syntheticBearerValue',
      'abcdefghijklmnop',
      'synthetic-flag-value',
    ]) {
      expect(text).not.toContain(canary);
    }
    expect(credential.api_key).toBe('synthetic-opaque-value');
    expect(argv[1]).toBe('synthetic-flag-value');
  });

  it('ALIAS_SECRET_KEY_FALLBACK unwinds a hidden structured value before its clean sibling', () => {
    const shared = { label: 'clean' };
    expect(
      redactSecretShapedValue({ password: shared, public: shared }),
      'ALIAS_SECRET_KEY_FALLBACK',
    ).toEqual({ password: '[redacted]', public: { label: 'clean' } });
    expect(shared).toEqual({ label: 'clean' });
  });

  it('ALIAS_MODEL_IDENTITY preserves the original model value and expands clean summary branches', async () => {
    const shared = {
      label: 'alice',
      note: 'Bearer SYNTHETIC_PRIVATE',
      media: 'data:image/png;base64,U1lOVEhFVElD',
    };
    const source = { left: shared, right: shared };
    const expectedText = JSON.stringify({
      left: { label: 'alice', note: 'Bearer [redacted]', media: '[base64 data URI omitted]' },
      right: { label: 'alice', note: 'Bearer [redacted]', media: '[base64 data URI omitted]' },
    });
    expect(expectedText.length).toBeLessThan(500);
    const bounded = await boundForModel(source, { maxBytes: 10_000, maxLines: 20 }, {});
    expect(bounded.value, 'ALIAS_MODEL_IDENTITY').toBe(source);
    expect(source.left).toBe(source.right);
    expect(source.left.note).toBe('Bearer SYNTHETIC_PRIVATE');
    expect(bounded.truncated).toBe(false);
    expect(bounded.summary, 'ALIAS_MODEL_SUMMARY').toBe(expectedText);
  });

  it('ALIAS_SPILL expands both clean branches in the actual sanitized spill', async () => {
    const shared = {
      label: 'bob',
      media: 'data:image/png;base64,U1lOVEhFVElD',
    };
    const source = { left: shared, right: shared };
    const spill = vi.fn((text: string) =>
      Promise.resolve({ ref: 'spill://alias', byteLength: text.length }),
    );
    const bounded = await boundForModel(
      source,
      { maxBytes: 20, maxLines: 2 },
      { outputStore: { spill } },
    );
    expect(bounded.truncated).toBe(true);
    expect(spill, 'ALIAS_SPILL').toHaveBeenCalledOnce();
    expect(spill.mock.calls[0]?.[0], 'ALIAS_SPILL').toBe(
      JSON.stringify({
        left: { label: 'bob', media: '[base64 data URI omitted]' },
        right: { label: 'bob', media: '[base64 data URI omitted]' },
      }),
    );
    expect(String(bounded.value)).toContain('spill://alias');
    expect(source.left).toBe(source.right);
    expect(source.right.media).toBe('data:image/png;base64,U1lOVEhFVElD');
  });
});
