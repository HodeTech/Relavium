import { scrubSecrets } from '@relavium/llm/scrub-secrets';
import type { AbortSignalLike } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  boundForModel,
  redactInlineMedia,
  redactSecretShapedText,
  redactSecretShapedValue,
  utf8ByteLength,
} from './bounding.js';
import type { ToolHost, ToolResultLimits } from './types.js';

const BIG: ToolResultLimits = { maxBytes: 50_000, maxLines: 2000 };
const TINY: ToolResultLimits = { maxBytes: 20, maxLines: 3 };

describe.each([redactInlineMedia, redactSecretShapedValue])(
  'own public data projection %s',
  (project) => {
    it.each(['public-value', { label: 'public-value' }])(
      'OWN_PUBLIC_KEY preserves an own __proto__ data value %j without changing the prototype',
      (value) => {
        const input = {
          ['__proto__']: value,
          constructor: 'public-constructor',
          prototype: 'public-prototype',
        };
        const output = project(input);
        expect(JSON.stringify(output), 'OWN_PUBLIC_KEY').toBe(JSON.stringify(input));
        expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(output, '__proto__')).toMatchObject({
          value,
          enumerable: true,
        });
        expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
      },
    );
  },
);

describe('utf8ByteLength', () => {
  it('counts ASCII, 2-byte, 3-byte, and surrogate-pair (4-byte) code points', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2); // U+00E9
    expect(utf8ByteLength('€')).toBe(3); // U+20AC
    expect(utf8ByteLength('😀')).toBe(4); // U+1F600 surrogate pair
    expect(utf8ByteLength('')).toBe(0);
  });

  it('counts a LONE high surrogate as 3 bytes without skipping the next char (L-1)', () => {
    expect(utf8ByteLength('\ud83d€')).toBe(6); // lone high (3) + € (3), not 4-with-skip
    expect(utf8ByteLength('\ud83d')).toBe(3); // lone high at end of string
    expect(utf8ByteLength('\udc00')).toBe(3); // lone low surrogate
  });
});

describe('boundForModel', () => {
  const host = (overrides?: Partial<ToolHost>): ToolHost => ({ ...overrides });

  it.each([
    {
      name: 'quoted credential',
      text: `password="SYNTHETIC_VISIBLE_HEAD_${'Q'.repeat(20 * 1024)}"; public-tail`,
      summary: '[redacted]; public-tail',
    },
    {
      name: 'multiline quoted credential',
      text: `password="SYNTHETIC_VISIBLE_HEAD_${'Q'.repeat(10 * 1024)}\n${'Q'.repeat(10 * 1024)}"; public-tail`,
      summary: '[redacted]; public-tail',
    },
    {
      name: 'URL userinfo',
      text: `https://user:SYNTHETIC_VISIBLE_HEAD_${'Q'.repeat(20 * 1024)}@service.invalid/path`,
      summary: 'https://[redacted]@service.invalid/path',
    },
  ])(
    'SUMMARY_REDACTION_ORDER recognizes a complete long $name before clipping',
    async ({ text, summary }) => {
      const result = await boundForModel(text, BIG, host());
      expect(result.summary, 'SUMMARY_REDACTION_ORDER').toBe(summary);
      expect(result.summary.length).toBeLessThanOrEqual(501);
      expect(result.value).toBe(text);
      expect(result.truncated).toBe(false);
    },
  );

  it('passes a within-limits result through untouched', async () => {
    const result = { ok: true, n: 1 };
    const bounded = await boundForModel(result, BIG, host());
    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(result);
    expect(bounded.summary).toContain('ok');
  });

  it('summary collapses whitespace and caps at 500 chars + an ellipsis marker', async () => {
    const bounded = await boundForModel('a   b\n\n  c'.padEnd(2000, ' x'), BIG, host());
    expect(bounded.summary.length).toBeLessThanOrEqual(501); // SUMMARY_MAX (500) + '…'
    expect(bounded.summary).not.toMatch(/\s\s/); // whitespace runs collapsed to single spaces
    expect(bounded.summary.endsWith('…')).toBe(true); // capped → ellipsis marker, never the raw full text
  });

  it('truncates an over-byte result and spills via the output store', async () => {
    const spill = vi.fn((text: string) =>
      Promise.resolve({ ref: 'spill://abc', byteLength: text.length }),
    );
    const text = 'x'.repeat(500);
    const bounded = await boundForModel(text, TINY, host({ outputStore: { spill } }));
    expect(bounded.truncated).toBe(true);
    expect(spill).toHaveBeenCalledOnce();
    expect(String(bounded.value)).toContain('spill://abc');
    expect(String(bounded.value)).toContain('truncated');
  });

  it('truncates over the LINE ceiling too', async () => {
    const spill = vi.fn(() => Promise.resolve({ ref: 'spill://lines', byteLength: 1 }));
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const bounded = await boundForModel(
      text,
      { maxBytes: 50_000, maxLines: 3 },
      host({ outputStore: { spill } }),
    );
    expect(bounded.truncated).toBe(true);
    expect(spill).toHaveBeenCalledOnce();
  });

  it('marks "no output store" when none is wired', async () => {
    const bounded = await boundForModel('y'.repeat(500), TINY, host());
    expect(bounded.truncated).toBe(true);
    expect(String(bounded.value)).toContain('no output store');
  });

  it('renders a non-string result as compact JSON and a string result verbatim', async () => {
    const obj = await boundForModel({ a: 1 }, BIG, host());
    expect(obj.summary).toContain('"a"');
    const str = await boundForModel('hello world', BIG, host());
    expect(str.value).toBe('hello world');
  });

  it('treats undefined as empty (never truncated)', async () => {
    const bounded = await boundForModel(undefined, TINY, host());
    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBeUndefined();
  });

  it('renders a circular result without throwing (the cycle-safe redaction walk breaks the cycle)', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const bounded = await boundForModel(circular, BIG, host());
    expect(bounded.truncated).toBe(false);
    // The redaction walk replaces the back-reference with a marker, so the summary serialises (no throw).
    expect(bounded.summary).toContain('cyclic');
  });

  it('renders a genuinely unserializable result (a bare function) as the fallback', async () => {
    const bounded = await boundForModel(() => 1, BIG, host());
    expect(bounded.summary).toBe('[unserializable]');
  });

  it('enforces the LINE ceiling in the preview, not just the spill trigger (H4)', async () => {
    const spill = vi.fn(() => Promise.resolve({ ref: 'spill://lines', byteLength: 1 }));
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'); // small bytes, many lines
    const bounded = await boundForModel(
      text,
      { maxBytes: 50_000, maxLines: 5 },
      host({ outputStore: { spill } }),
    );
    expect(bounded.truncated).toBe(true);
    // The model-facing preview must be line-bounded — NOT the full 200-line text returned verbatim.
    const previewLines = String(bounded.value).split('\n').length;
    expect(previewLines).toBeLessThan(200);
    expect(String(bounded.value)).not.toContain('line 150');
  });

  it('byte-bounds a multibyte preview without splitting a code point (L4)', async () => {
    const text = '😀'.repeat(2000); // 4 bytes each → 8000 bytes
    const bounded = await boundForModel(text, { maxBytes: 200, maxLines: 2000 }, host());
    expect(bounded.truncated).toBe(true);
    // No lone surrogate: every UTF-16 unit in the preview pairs up (emoji stay whole).
    const preview = String(bounded.value);
    for (let i = 0; i < preview.length; i++) {
      const code = preview.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = preview.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false); // never a lone low surrogate
      }
    }
  });

  it('degrades a non-abort spill failure to a preview-only result (tool already succeeded) (M2)', async () => {
    const spill = vi.fn(() => Promise.reject(new Error('disk full')));
    const bounded = await boundForModel('z'.repeat(500), TINY, host({ outputStore: { spill } }));
    expect(bounded.truncated).toBe(true);
    expect(String(bounded.value)).toContain('spill failed');
  });

  it('rethrows an abort that occurs during spill (cancel precedence) (M2)', async () => {
    const signal: AbortSignalLike = {
      aborted: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const spill = vi.fn(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    await expect(
      boundForModel('z'.repeat(500), TINY, host({ outputStore: { spill } }), signal),
    ).rejects.toThrow(/aborted/);
  });

  it('redacts inline media base64 from the summary (I3 — a read_media result never leaks bytes to the event)', async () => {
    // A read_media-shaped result: a media part carrying an in-flight base64 source. The model-facing value
    // keeps the bytes (it rides the seam), but the SUMMARY (→ agent:tool_result.outputSummary, a durable
    // run-event boundary) must carry NO base64 — the emit-time deInlineMedia choke point cannot catch a
    // base64 substring inside a flat string, so the redaction lives here.
    const data = 'aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSByZWFsIGltYWdlIGJ1dCBsb25nIGVub3VnaA==';
    const result = { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data } };
    const bounded = await boundForModel(result, BIG, host());
    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(result); // model-facing value keeps the bytes (sent via the seam)
    expect(bounded.summary).not.toContain(data); // but the event summary is byte-free
    expect(bounded.summary).not.toContain('aGVsbG8'); // not even a leading fragment
    expect(bounded.summary).toContain('media'); // a byte-free descriptor instead
  });

  it('never hands base64 to the spill store / preview for an over-cap media-bearing result (I3)', async () => {
    const data = 'QQ'.repeat(5000); // a large base64 blob; the redacted descriptor still exceeds TINY's cap
    const result = { type: 'media', mimeType: 'audio/mpeg', source: { kind: 'base64', data } };
    let spilledText = 'unset';
    const spill = vi.fn((text: string) => {
      spilledText = text;
      return Promise.resolve({ ref: 'spill://x', byteLength: 1 });
    });
    const bounded = await boundForModel(result, TINY, host({ outputStore: { spill } }));
    // The text path is redacted, so whatever is summarized / spilled / previewed carries NO base64.
    expect(spilledText).not.toContain('QQQQ');
    expect(String(bounded.value)).not.toContain('QQQQ');
    expect(bounded.summary).not.toContain('QQQQ');
  });

  it('redacts a base64 data: URI string from the summary (the event), keeping the model-facing value', async () => {
    // The model-facing `value` rides the seam (in-flight, de-inlined on egress); only the SUMMARY is a
    // durable run-event field, so only it must be byte-free.
    const bounded = await boundForModel('data:image/png;base64,aGVsbG8=', BIG, host());
    expect(bounded.summary).not.toContain('aGVsbG8');
    expect(bounded.summary).toContain('omitted');
  });

  it('redacts base64 from EVERY element of an array-of-media result (the redaction walk recurses arrays)', async () => {
    const a = 'aGVsbG8gZmlyc3QgbWVkaWEgcGFydCBwYXlsb2Fk';
    const b = 'd29ybGQgc2Vjb25kIG1lZGlhIHBhcnQgcGF5bG9hZA==';
    const result = [
      { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: a } },
      { type: 'media', mimeType: 'audio/mpeg', source: { kind: 'base64', data: b } },
    ];
    const bounded = await boundForModel(result, BIG, host());
    expect(bounded.summary).not.toContain(a);
    expect(bounded.summary).not.toContain(b);
    expect(bounded.value).toBe(result); // model-facing value keeps the bytes
  });

  it('redacts a raw binary buffer (Uint8Array) from the summary — never JSON the decimal byte values (I3)', async () => {
    // "HELLO" as raw bytes; without redaction JSON.stringify yields {"0":72,"1":69,…} — a decimal byte leak.
    const result = { thumb: new Uint8Array([72, 69, 76, 76, 79]) };
    const bounded = await boundForModel(result, BIG, host());
    expect(bounded.summary).not.toMatch(/"0":72|72,69,76/);
    expect(bounded.summary).toContain('binary buffer omitted');
  });

  it('leaves a Date / Map result rendered natively (not collapsed to {} by the redaction walk)', async () => {
    const date = await boundForModel({ at: new Date('2026-06-19T00:00:00.000Z') }, BIG, host());
    expect(date.summary).toContain('2026-06-19'); // Date → ISO string via JSON.stringify, not {}
  });

  it('scrubs a secret-shaped value from the summary (outputSummary) but keeps the model-facing value', async () => {
    // A read_clipboard / egress-body / .env-style result carrying a live token must not ride outputSummary
    // (→ agent:tool_result.outputSummary → the --json stream). The model-facing value keeps the real bytes.
    const result = `export API_KEY=sk-${'abcdef0123456789abcdef'} and Authorization: Bearer tok${'_live_9f8e7d6c5b4a'}`;
    const bounded = await boundForModel(result, BIG, host());
    expect(bounded.summary).not.toContain('sk-' + 'abcdef0123456789abcdef');
    expect(bounded.summary).not.toContain('tok_live_9f8e7d6c5b4a');
    expect(bounded.summary).toContain('[redacted]');
    expect(bounded.value).toBe(result); // the model still sees the real content
  });

  it('scrubs the summary even when the result is TRUNCATED — the preview (model-facing) keeps the bytes', async () => {
    const secret = 'sk-' + 'abcdef0123456789abcdef';
    const spill = vi.fn(() => Promise.resolve({ ref: 'run://spill/1', byteLength: 2048 }));
    const bounded = await boundForModel(
      `${secret} ${'z'.repeat(2000)}`,
      TINY,
      host({ outputStore: { spill } }),
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.summary).not.toContain(secret); // outputSummary is scrubbed (derived from the full text)
  });
});

describe('redactSecretShapedText', () => {
  it.each([
    { prefix: 'Bearer ', minimum: 8, expected: 'Bearer [redacted]' },
    { prefix: 'Basic ', minimum: 8, expected: 'Basic [redacted]' },
    { prefix: 'Token ', minimum: 8, expected: 'Token [redacted]' },
    { prefix: 'password=', minimum: 6, expected: '[redacted]' },
    { prefix: 'sk-', minimum: 16, expected: '[redacted]' },
    { prefix: 'sk_live_', minimum: 16, expected: '[redacted]' },
    { prefix: 'ghp_', minimum: 20, expected: '[redacted]' },
    { prefix: 'github_pat_', minimum: 20, expected: '[redacted]' },
    { prefix: 'glpat-', minimum: 16, expected: '[redacted]' },
    { prefix: 'xoxb-', minimum: 10, expected: '[redacted]' },
    { prefix: 'AIza', minimum: 30, expected: '[redacted]' },
    { prefix: 'ya29.', minimum: 20, expected: '[redacted]' },
    { prefix: 'hf_', minimum: 20, expected: '[redacted]' },
    { prefix: 'npm_', minimum: 20, expected: '[redacted]' },
  ])(
    'CREDENTIAL_FLOOR preserves the $minimum-character floor for $prefix',
    ({ prefix, minimum, expected }) => {
      for (const length of [minimum - 1, minimum, minimum + 1]) {
        const raw = prefix + 'A'.repeat(length);
        expect(redactSecretShapedText(raw), 'CREDENTIAL_FLOOR').toBe(
          length < minimum ? raw : expected,
        );
      }
    },
  );

  it('JWT_FLOORS preserves all three segment minimums', () => {
    const floors = [10, 10, 6];
    for (const [index, minimum] of floors.entries()) {
      for (const length of [minimum - 1, minimum]) {
        const segments = floors.map((floor, i) => 'A'.repeat(i === index ? length : floor));
        const raw = `eyJ${segments.join('.')}`;
        expect(redactSecretShapedText(raw), 'JWT_FLOORS').toBe(
          length < minimum ? raw : '[redacted]',
        );
      }
    }
  });

  it.each(['bearer', 'unquoted', 'openai-shaped', 'jwt-shaped', 'escaped-quoted'] as const)(
    'ADMITTED_CREDENTIAL_WHOLE masks the whole admitted-scale %s value without a RegExp stack failure',
    (kind) => {
      const large = 'A'.repeat(7_500_000);
      const values = {
        bearer: `Bearer ${large}`,
        unquoted: `password=${large}`,
        'openai-shaped': `sk-${large}`,
        'jwt-shaped': `eyJ${large}.BBBBBBBBBBBB.CCCCCCCCCCCC`,
        'escaped-quoted': `password="${'\\"'.repeat(3_750_000)}"`,
      };
      const raw = values[kind];
      expect(() => redactSecretShapedText(raw), 'ADMITTED_CREDENTIAL_WHOLE').not.toThrow();
      expect(redactSecretShapedText(raw), 'ADMITTED_CREDENTIAL_WHOLE').toBe(
        kind === 'bearer' ? 'Bearer [redacted]' : '[redacted]',
      );
    },
  );

  it('redacts Authorization schemes, secret=value pairs, and known token shapes', () => {
    // `Authorization: Bearer <tok>` is caught by BOTH the scheme pattern and the `authorization=value` pattern;
    // the over-redaction is the safe direction — assert the token is gone, not an exact shape.
    const authScrubbed = redactSecretShapedText('Authorization: Bearer abcdef123456789');
    expect(authScrubbed).not.toContain('abcdef123456789');
    expect(authScrubbed).toContain('[redacted]');
    expect(redactSecretShapedText('db_password=hunter2secret')).toBe('[redacted]');
    const apiKey = redactSecretShapedText('MY_API_KEY = "sk-' + 'XYZ12345abcdef"');
    expect(apiKey).not.toContain('sk-' + 'XYZ12345abcdef');
    expect(apiKey).toContain('[redacted]');
    expect(redactSecretShapedText('token AKIA' + 'IOSFODNN7EXAMPLE here')).toContain('[redacted]');
    expect(redactSecretShapedText('ghp' + '_0123456789abcdef0123456789abcdefABCD')).toBe(
      '[redacted]',
    );
  });

  it('redacts the JSON `"key":"value"` shape — an OAuth / egress response body', () => {
    for (const s of [
      '{"access_token":"a1b2c3d4e5f6g7h8"}',
      '{"client_secret":"shhhhhhhhhh"}',
      '{ "api_key": "sk-' + 'value-here-1234" }',
    ]) {
      expect(redactSecretShapedText(s)).toContain('[redacted]');
    }
    expect(redactSecretShapedText('{"access_token":"a1b2c3d4e5f6g7h8"}')).not.toContain(
      'a1b2c3d4e5f6g7h8',
    );
  });

  it('redacts a QUOTED multi-word passphrase WHOLE — no interior-space tail leak', () => {
    // The value must be consumed through the closing quote, not stopped at the first space.
    const out = redactSecretShapedText('{"password":"hunter2 dragon rider"}');
    expect(out).not.toContain('dragon');
    expect(out).not.toContain('rider');
  });

  it.each([24, 512, 513, 600, 32 * 1024])(
    'OPAQUE_QUERY_WHOLE redacts all %i characters while preserving the next parameter and public text',
    (length) => {
      const prefix = `${'x'.repeat(20 * 1024)}\nhttps://public.invalid/?opaque=`;
      for (const suffix of ['A', 'B']) {
        expect(
          redactSecretShapedText(
            `${prefix}${'Q'.repeat(length - 1)}${suffix}&limit=10\npublic-tail`,
          ),
          'OPAQUE_QUERY_WHOLE',
        ).toBe(`${prefix}[redacted]&limit=10\npublic-tail`);
      }
      expect(redactSecretShapedText('?opaque=short&limit=10')).toBe('?opaque=short&limit=10');
    },
  );

  it('QUERY_FRAGMENT_BOUNDARY does not count or redact a public fragment as part of an opaque query value', () => {
    const fragment = '#public@example.invalid';
    expect(
      redactSecretShapedText(`?opaque=${'Q'.repeat(23)}${fragment}`),
      'QUERY_FRAGMENT_BOUNDARY',
    ).toBe(`?opaque=${'Q'.repeat(23)}${fragment}`);
    expect(
      redactSecretShapedText(`?opaque=${'Q'.repeat(600)}${fragment}`),
      'QUERY_FRAGMENT_BOUNDARY',
    ).toBe(`?opaque=[redacted]${fragment}`);
  });

  it('ADMITTED_QUERY_WHOLE masks a multi-megabyte admitted-scale value without a RegExp stack failure', () => {
    const text = `?opaque=${'Q'.repeat(7_500_000)}#public-fragment`;
    expect(() => redactSecretShapedText(text), 'ADMITTED_QUERY_WHOLE').not.toThrow();
    expect(redactSecretShapedText(text), 'ADMITTED_QUERY_WHOLE').toBe(
      '?opaque=[redacted]#public-fragment',
    );
  });

  it.each([
    'ordinary"SYNTHETIC_QUOTED_TAIL',
    'ordinary\\"SYNTHETIC_QUOTED_TAIL',
    'ordinary\\\\"SYNTHETIC_QUOTED_TAIL',
    'ordinary\\',
    "ordinary'single quote and space",
  ])('ESCAPED_SECRET_WHOLE consumes the complete JSON password %j', (password) => {
    const text = JSON.stringify({ password, payee: 'alice@example.invalid' });
    expect(redactSecretShapedText(text), 'ESCAPED_SECRET_WHOLE').toBe(
      '{"[redacted],"payee":"alice@example.invalid"}',
    );
    expect(JSON.parse(text)).toEqual({ password, payee: 'alice@example.invalid' });
  });

  it('redacts escaped single quotes and resumes after the real closing quote', () => {
    expect(redactSecretShapedText("password='ordinary\\'SECRET_TAIL'; count=42")).toBe(
      '[redacted]; count=42',
    );
    expect(redactSecretShapedText('password="backslash\\\\"; count=42')).toBe(
      '[redacted]; count=42',
    );
  });

  it('redacts a PEM private-key block (space-separated markers the key-pattern cannot see)', () => {
    const pem = [
      '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1r' + 'ZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAA',
      'MIIEvQIBADAN' + 'BgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
      '-----END ' + 'OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecretShapedText(`key material:\n${pem}\ndone`);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('MIIEvQ' + 'IBADAN');
    expect(out).not.toContain('b3Blbn' + 'NzaC1r');
  });

  it('redacts every standalone token PREFIX shape (locks the extended alternation against a typo)', () => {
    const tokens = [
      'sk-' + 'abcdef0123456789ABCDEF',
      'sk' + '_live_abcdef0123456789ABCD',
      'AKIA' + 'IOSFODNN7EXAMPLE',
      'ASIA' + 'IOSFODNN7EXAMPLE',
      'ghp' + '_0123456789abcdef0123456789abcdefABCD',
      'github' + '_pat_0123456789abcdefABCDEF_more',
      'glpat' + '-0123456789abcdefABCD',
      'xoxb' + '-0123456789-abcdefABCDEF',
      'AIza' + 'SyA0123456789abcdefABCDEF0123456789',
      'ya29' + '.a0AbCdEf0123456789_-abcdef',
      'hf' + '_0123456789abcdefABCDEFGHIJ',
      'npm' + '_0123456789abcdefABCDEFGHIJ',
      'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4',
    ];
    for (const tok of tokens) {
      expect(redactSecretShapedText(`value ${tok} end`)).not.toContain(tok);
    }
  });

  it('fully covers ADJACENT / EMBEDDED multi-credential runs (no raw token survives — regression pin)', () => {
    // The single-alternation matcher must cover a run of back-to-back / nested credential shapes as ONE
    // leftmost-longest span. A per-family MULTI-PASS split leaves a trailing shape EXPOSED here: an earlier
    // pass inserts `[redacted]` (a `[`), truncating a later family's greedy match. These two inputs are the
    // exact witnesses that split form leaked — they must redact whole (no raw substring left behind).
    const jwtWithInnerSk =
      'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig-sk-ABCDEFGHIJKLMNOPqr';
    expect(redactSecretShapedText(jwtWithInnerSk)).toBe('[redacted]');
    const slackWithInnerGlpat = 'xoxb' + '-0000000000-glpat-' + 'A'.repeat(16);
    const out = redactSecretShapedText(slackWithInnerGlpat);
    expect(out).toBe('[redacted]');
    expect(out).not.toContain('glpat-'); // no fragment of the embedded token survives
  });

  it('leaves ordinary text (and short non-secret values) intact', () => {
    expect(redactSecretShapedText('the quick brown fox')).toBe('the quick brown fox');
    expect(redactSecretShapedText('count = 42')).toBe('count = 42'); // not a secret-ish key
  });

  it('scrubs every non-URL credential family after a long public prefix and preserves the full tail', () => {
    // No URL delimiter occurs in these values. Skipping impossible userinfo matches must not bypass
    // another credential family or truncate the journal input to the display projection's 16 KiB.
    // An ordinary space distinguishes public prose from the LF/TAB token-continuation policy.
    const prefix = `${'a'.repeat(32 * 1024)}\n`;
    const cases = [
      [`?opaque=${'Q'.repeat(24)}`, '?opaque=[redacted]'],
      ['-----BEGIN PRIVATE KEY-----opaque-----END PRIVATE KEY-----', '[redacted]'],
      ['Bearer abcdefghijklmnop', 'Bearer [redacted]'],
      ['password="ordinary opaque value"', '[redacted]'],
      [`sk-${'A'.repeat(16)}`, '[redacted]'],
    ];
    for (const [credential, expected] of cases) {
      for (const tail of ['public-tail-A', 'public-tail-B']) {
        expect(redactSecretShapedText(`${prefix}${credential}\n ${tail}`)).toBe(
          `${prefix}${expected}\n ${tail}`,
        );
      }
    }
  });

  it('over-redaction is the safe direction — a benign `token: <long>` is swept up (documented tradeoff)', () => {
    // A DISPLAY-field false positive is acceptable (the model's copy is untouched). This pins the deliberate
    // over-redaction so a future "tighten precision" change is a conscious test edit, not a silent secret leak.
    expect(redactSecretShapedText('token abcdefghijklmnop')).toContain('[redacted]');
  });

  it(
    'is ReDoS-safe on a value-ENGAGING input AND fully redacts it (timing + correctness)',
    { timeout: 15_000 },
    () => {
      // Drives BOTH the scheme-token run (200k) and a long quoted value (50k) — the machinery a quadratic
      // pattern blows up on. The correctness assertions catch a quantifier-narrowing regression that would
      // leak the tail (a timing bound alone would PASS such a regression — it runs faster, not slower).
      //
      // **A GENEROUS ceiling, and the number is the whole argument.** Two tighter instruments were tried
      // here and both were wrong. `< 500ms` was a machine-speed assertion: 33ms on a developer machine,
      // 610ms on a loaded shared runner, and neither number says anything about backtracking. A growth
      // RATIO across two input sizes is the textbook answer and reads beautifully in isolation — 1.98 for
      // this function, 3.97 for a known quadratic one — but under whole-monorepo contention the per-round
      // ratios scattered from 0.98 to 10.17, because each measurement is milliseconds and one descheduled
      // window decides it.
      //
      // What actually threatens this code is CATASTROPHIC backtracking, not a merely-quadratic scan: a
      // quadratic pattern on 250KB is slow, an exponential one does not return at all. Measured — replacing
      // one bounded class with a nested quantifier made this input run past 120 seconds. So the bound is set
      // where it separates those two worlds: ~8x the slowest honest observation, and orders of magnitude
      // below any real regression. The explicit test timeout is here for the same reason — the assertion
      // should report the failure, not the runner.
      const evil = `Authorization: Bearer ${'a'.repeat(200_000)} my_secret="${'x'.repeat(50_000)}"`;
      const started = performance.now();
      const out = redactSecretShapedText(evil);
      const elapsed = performance.now() - started;
      expect(elapsed, `${elapsed.toFixed(0)}ms`).toBeLessThan(5_000);
      expect(out).not.toContain('a'.repeat(100)); // the bearer token tail is gone
      expect(out).not.toContain('x'.repeat(100)); // the long quoted value tail is gone
    },
  );
});

describe('redactSecretShapedValue', () => {
  it('scrubs string values at any nesting, keeping normal object keys (header names) intact', () => {
    const input = {
      url: 'https://api.example.com/x?api_key=sk-' + 'secret9876543210',
      headers: { Authorization: 'Bearer tok_abcdef123456', 'X-Trace': 'keep-me' },
      body: 'client_secret=shhhhhhhhhh',
    };
    // `redactSecretShapedValue` returns `unknown`; assert the whole shape with `toEqual` — no unsafe cast. This
    // also pins that a non-secret header NAME (`Authorization`, `X-Trace`) survives the key scrub untouched.
    expect(redactSecretShapedValue(input)).toEqual({
      url: 'https://api.example.com/x?[redacted]',
      headers: { Authorization: 'Bearer [redacted]', 'X-Trace': 'keep-me' },
      body: '[redacted]',
    });
  });

  it('scrubs a secret-SHAPED object key too (not just values)', () => {
    const secretKey = 'glpat-' + 'A'.repeat(20); // a GitLab-PAT-shaped KEY, built split (Leakwatch policy)
    expect(redactSecretShapedValue({ [secretKey]: 'v', normalKey: 'keep' })).toEqual({
      '[redacted]': 'v',
      normalKey: 'keep',
    });
  });

  it('is cycle-safe', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => redactSecretShapedValue(cyclic)).not.toThrow();
  });
});

describe('redactSecretShapedText — URL userinfo (ADR-0080 §11)', () => {
  it.each([';', '|'])(
    'USERINFO_BOUNDARY retains the next scheme after a public host and %s separator',
    (separator) => {
      expect(
        redactSecretShapedText(
          `https://u:p@one.invalid${separator}custom://u:second-password@two.invalid/path`,
        ),
        'USERINFO_BOUNDARY',
      ).toBe(`https://[redacted]@one.invalid${separator}custom://[redacted]@two.invalid/path`);
    },
  );
  it.each(['A', 'B'])(
    'USERINFO_WHOLE masks through the last @ without retaining the credential tail %s',
    (suffix) => {
      expect(
        redactSecretShapedText(
          `https://a:p@SYNTHETIC_USERINFO_TAIL_${suffix}@api.invalid:8443/x?q=public@example.invalid#public@example.invalid`,
        ),
        'USERINFO_WHOLE',
      ).toBe(
        'https://[redacted]@api.invalid:8443/x?q=public@example.invalid#public@example.invalid',
      );
      expect(redactSecretShapedText(`custom://a::@api.invalid/x`)).toBe(
        'custom://[redacted]@api.invalid/x',
      );
    },
  );

  it('keeps short vanity userinfo and public query/fragment @ while masking a whole long authority', () => {
    for (const text of [
      'https://vanity@api.invalid/x',
      'https://api.invalid?public=alice@example.invalid',
      'https://api.invalid#contact=alice@example.invalid',
    ])
      expect(redactSecretShapedText(text)).toBe(text);
    // A host fragment with no assignment may be a malformed password: masked, failing closed.
    expect(redactSecretShapedText('https://api.invalid#alice@example.invalid')).toBe(
      'https://[redacted]@example.invalid',
    );
    expect(redactSecretShapedText(`https://${'u'.repeat(600)}@api.invalid/x`)).toBe(
      'https://[redacted]@api.invalid/x',
    );
    expect(redactSecretShapedText('https://u:p@[::1]:8443/x')).toBe(
      'https://[redacted]@[::1]:8443/x',
    );
  });

  it('strips `user:pass@` from a URL while KEEPING the host', () => {
    // The shape every other pattern here misses: no `key=value`, no well-known prefix. A review recovered a
    // stored `run_effects` digest from guessed plaintext through exactly this gap — and since ADR-0080 the
    // same projection feeds a DURABLE, never-swept digest, so the exposure is a permanent offline oracle
    // rather than a line in an ephemeral stream. The host is kept deliberately: it is the diagnostic half.
    expect(redactSecretShapedText('https://admin:S3cr3tPassw0rd@internal.example.com/api')).toBe(
      'https://[redacted]@internal.example.com/api',
    );
    expect(redactSecretShapedText('postgres://user:hunter2@db.example.com:5432/app')).toBe(
      'postgres://[redacted]@db.example.com:5432/app',
    );
    expect(redactSecretShapedText('redis://:onlyapassword@cache.internal:6379')).toBe(
      'redis://[redacted]@cache.internal:6379',
    );
  });

  it('does NOT run past a JSON delimiter — over-redaction collapses two calls into one digest', () => {
    // THE destructive case, and the reason the classes are delimiter-bounded. Compact JSON has no
    // whitespace, so an unbounded password class swallows `host:port","payee":"…` up to the next `@`. A
    // review proved the consequence: two payment requests differing only in payee produced the SAME
    // `args_digest`, so a resumed run's `prepare` returned `replay` and handed the model the OTHER payee's
    // receipt for a payment that never happened. That is verbatim what §4 says must not occur.
    const alice = '{"endpoint":"https://api.pay.io:8080","payee":"alice@corp.com","amount":100}';
    const mallory =
      '{"endpoint":"https://api.pay.io:8080","payee":"mallory@corp.com","amount":100}';

    expect(redactSecretShapedText(alice)).toBe(alice);
    expect(redactSecretShapedText(mallory)).toBe(mallory);
    expect(redactSecretShapedText(alice)).not.toBe(redactSecretShapedText(mallory));
  });

  it('catches the COLON-LESS form — `scheme://TOKEN@host`', () => {
    // The shape the first rule structurally cannot see: it requires a `:` with a non-empty right side. A
    // webhook with an embedded bearer and a Stripe-style key-as-username (empty password) are both this.
    expect(redactSecretShapedText('https://s3cr3tT0kenABCDEFGH@internal.example/hook')).toBe(
      'https://[redacted]@internal.example/hook',
    );
    expect(redactSecretShapedText('https://sk_live_ABCDEFGHIJKLMNOP:@api.stripe.com/v1/x')).toBe(
      'https://[redacted]@api.stripe.com/v1/x',
    );
  });

  it('still finds both userinfo forms after a long public prefix', () => {
    // An ordinary space distinguishes public prose from the LF/TAB token-continuation policy.
    const prefix = `${'a'.repeat(32 * 1024)}\n`;
    for (const userinfo of ['user:opaque-password', 'opaque-token-value-without-colon']) {
      expect(redactSecretShapedText(`${prefix}custom+scheme://${userinfo}@host.example/tail`)).toBe(
        `${prefix}custom+scheme://[redacted]@host.example/tail`,
      );
    }
  });

  it('leaves a credential-free URL untouched — the negative control', () => {
    // Without this the rule above passes for an implementation that mangled every URL, which would destroy
    // the diagnostic value of the row for the overwhelmingly common case.
    for (const url of [
      'https://api.example.com/v1/things?limit=10',
      'https://example.com/path@fragment',
      'mailto:someone@example.com',
    ]) {
      expect(redactSecretShapedText(url)).toBe(url);
    }
  });
});

describe('redactSecretShapedValue — the KEY decides, whatever the value looks like (ADR-0080 §11)', () => {
  // Every case here was enumerated by a review that recovered the plaintext from a stored
  // `run_effects.args_digest`. The digest is permanent and never swept, so each of these was a lasting
  // offline oracle on a `history.db` the spec itself says may be unencrypted at rest.
  const SECRET = 'hunter2-l0w-entropy';

  const leaks: readonly { what: string; input: Record<string, unknown> }[] = [
    { what: 'a NESTED secret key', input: { auth: { api_key: SECRET } } },
    { what: 'a nested header name', input: { headers: { 'X-Api-Key': SECRET } } },
    { what: 'a top-level password', input: { password: SECRET } },
    {
      what: 'the value FOLLOWING a secret-ish flag in an arg vector',
      input: { args: ['deploy', '--token', SECRET] },
    },
    { what: 'a NUMERIC secret', input: { pin: 493021 } },
    { what: 'a credential object', input: { credentials: { user: 'u', pass: SECRET } } },
  ];

  for (const { what, input } of leaks) {
    it(`redacts ${what}`, () => {
      expect(JSON.stringify(redactSecretShapedValue(input))).not.toContain(SECRET);
      expect(JSON.stringify(redactSecretShapedValue(input))).not.toContain('493021');
    });
  }

  it('matches a keyword only as a WHOLE WORD — `author` is not `auth`', () => {
    // The first version reused the text rule's `[\w-]{0,32}<keyword>[\w-]{0,16}` wrapper, which matches a
    // keyword anywhere inside a name. A review caught `author`, `authors`, `pinned`, `opinion`, `spinner`
    // and `tokenizer` all being replaced with `[redacted]`. That is worse than losing diagnostics: the
    // DIGEST is computed over this projection, so two calls differing only in a falsely-redacted field
    // become byte-identical inputs, and §4's replay then answers one with the other's recorded result.
    const preserved = {
      author: 'Jane Doe',
      authors: ['Jane', 'Sam'],
      pinned: true,
      opinion: 'nice',
      spinner: 'dots',
      tokenizer: 'bpe',
      key: 'a-map-key', // bare `key` is far too common to redact — it counts only next to a qualifier
      keys: ['a', 'b'],
    };
    expect(redactSecretShapedValue(preserved)).toEqual(preserved);
  });

  it('…and still catches every real credential name, in all three casing conventions', () => {
    for (const name of [
      'api_key',
      'apiKey',
      'X-Api-Key',
      'password',
      'auth',
      'authToken',
      'client_secret',
      'access_token',
      'credentials',
      'private_key',
      'sessionKey',
    ]) {
      expect(JSON.stringify(redactSecretShapedValue({ [name]: 'hunter2' }))).not.toContain(
        'hunter2',
      );
    }
  });

  it('a `-p` VALUE that is a port survives; a password does not', () => {
    // `-p` is the password flag for `mysql`/`psql` AND the port flag for `ssh` and `docker run`. Dropping it
    // leaks the first; keeping it blindly destroyed the second — a review caught `ssh -p 2222` and
    // `docker run -p 8080:80` being replaced. The value's shape is what tells them apart.
    expect(redactSecretShapedValue({ argv: ['ssh', '-p', '2222', 'user@host'] })).toEqual({
      argv: ['ssh', '-p', '2222', 'user@host'],
    });
    expect(redactSecretShapedValue({ argv: ['docker', 'run', '-p', '8080:80', 'nginx'] })).toEqual({
      argv: ['docker', 'run', '-p', '8080:80', 'nginx'],
    });
    expect(redactSecretShapedValue({ argv: ['mysql', '-p', 'hunter2dragon'] })).toEqual({
      argv: ['mysql', '-p', '[redacted]'],
    });
  });

  it.each(['--token', '--password', '--api-key', '--client-secret'])(
    'STRUCTURAL_ARGV_WHOLE treats %s as credential authority for both argument spellings',
    (flag) => {
      const value = `sk-${'Q'.repeat(16)};${'x'.repeat(20 * 1024)}SYNTHETIC_TAIL`;
      expect(redactSecretShapedValue({ args: [flag, value, '--count=4'] })).toEqual({
        args: [flag, '[redacted]', '--count=4'],
      });
      expect(redactSecretShapedValue({ args: [`${flag}=${value}`, '--count=4'] })).toEqual({
        args: [`${flag}=[redacted]`, '--count=4'],
      });
      expect(redactSecretShapedValue({ args: [flag, '1234', `${flag}=1234`] })).toEqual({
        args: [flag, '[redacted]', `${flag}=[redacted]`],
      });
    },
  );

  it('STRUCTURAL_ARGV_PORT preserves the ambiguous -p port exception without widening it', () => {
    expect(redactSecretShapedValue({ args: ['-p=8080:80', '-p', '2222', '--port=3333'] })).toEqual({
      args: ['-p=8080:80', '-p', '2222', '--port=3333'],
    });
  });

  it('leaves ordinary structured args alone — the negative control', () => {
    // Without this the rule above is satisfied by redacting everything, which would strip the stored row of
    // the diagnostic value that is its whole remaining purpose.
    const benign = {
      url: 'https://api.example.com/v1/things',
      method: 'POST',
      limit: 10,
      tags: ['alpha', 'beta'],
      nested: { name: 'report', count: 3 },
      // …and an ordinary arg vector: a flag that names nothing secret leaves its value alone.
      argv: ['deploy', '--env', 'staging', '--verbose'],
    };
    expect(redactSecretShapedValue(benign)).toEqual(benign);
  });

  it('keeps only the bounded auth scheme under a recognized credential key', () => {
    // The scheme is public diagnostic information; a partial inner match cannot prove that the rest
    // of a structurally identified credential is public.
    expect(redactSecretShapedValue({ Authorization: 'Bearer tok_abcdef123456' })).toEqual({
      Authorization: 'Bearer [redacted]',
    });
  });

  it.each(['X-Api-Key', 'password', 'authToken', 'client_secret', 'sessionKey', 'credentials'])(
    'STRUCTURAL_SECRET_WHOLE masks the entire %s value despite an inner shape match',
    (key) => {
      for (const prefix of ['', 'x'.repeat(20 * 1024)]) {
        for (const recognized of [
          `sk-${'Q'.repeat(16)}`,
          'Bearer QQQQQQQQQQQQQQQQ',
          'password="synthetic inner secret"',
          'https://user:synthetic-password@service.invalid',
        ]) {
          const value = `${prefix}ordinary:${recognized};${'x'.repeat(20 * 1024)}SYNTHETIC_TAIL`;
          expect(redactSecretShapedValue({ [key]: value }), 'STRUCTURAL_SECRET_WHOLE').toEqual({
            [key]: '[redacted]',
          });
        }
      }
    },
  );

  it.each([
    ['bEaReR', 'Bearer'],
    ['bAsIc', 'Basic'],
    ['tOkEn', 'Token'],
  ])('STRUCTURAL_SECRET_SCHEME retains only canonical %s diagnostics', (input, canonical) => {
    const value = `${input}\tQQQQQQQQQQQQQQQQ;${'x'.repeat(20 * 1024)}SYNTHETIC_TAIL`;
    expect(redactSecretShapedValue({ Authorization: value })).toEqual({
      Authorization: `${canonical} [redacted]`,
    });
  });

  it('STRUCTURAL_SECRET_OPAQUE does not inspect a recognized secret container', () => {
    const inspect = vi.fn(() => {
      throw new Error('secret contents are outside the projection');
    });
    const nested = Object.defineProperty({}, 'value', { enumerable: true, get: inspect });
    expect(
      () => redactSecretShapedValue({ credentials: nested }),
      'STRUCTURAL_SECRET_OPAQUE',
    ).not.toThrow();
    expect(redactSecretShapedValue({ credentials: nested })).toEqual({ credentials: '[redacted]' });
    expect(inspect).not.toHaveBeenCalled();
    expect(redactSecretShapedValue({ password: null, token: undefined, pin: 123456 })).toEqual({
      password: null,
      token: undefined,
      pin: '[redacted]',
    });
  });

  it('redacts a long opaque value in a URL query under an unrecognised parameter name', () => {
    // A pre-signed URL or a webhook `?t=<token>`: the parameter name means nothing to the keyword rule, and
    // the value has no well-known prefix. The NAME is kept — it is the diagnostic half.
    const signed = 'https://files.example.com/o/x?X-Amz-Signature=' + 'a'.repeat(64);
    const out = redactSecretShapedText(signed);
    expect(out).not.toContain('a'.repeat(64));
    expect(out).toContain('X-Amz-Signature=');
  });

  it('leaves a SHORT query value alone — the negative control for the rule above', () => {
    expect(redactSecretShapedText('https://api.example.com/v1/things?limit=10&q=cats')).toBe(
      'https://api.example.com/v1/things?limit=10&q=cats',
    );
  });
});

function expectCredentialProjection(value: unknown) {
  return expect(value, 'SECRETS_B2_CORE_PROJECTION');
}

describe('PR95 B2 finite split-credential projections', () => {
  const bodies = ['proj-', 'svcacct-', 'ant-', ''].map(
    (prefix) => `sk-${prefix}${'A'.repeat(24)}_${'B'.repeat(24)}`,
  );

  it.each(bodies)('masks the complete modern provider shape %s', async (credential) => {
    expectCredentialProjection(redactSecretShapedText(`public: ${credential}; tail=A`)).toBe(
      'public: [redacted]; tail=A',
    );
    const bounded = await boundForModel(`public: ${credential}; tail=A`, BIG, {});
    expectCredentialProjection(bounded.summary).toBe('public: [redacted]; tail=A');
  });

  it('masks every LF/TAB split without losing the surrounding public identity', async () => {
    for (const credential of bodies) {
      for (const separator of ['\n', '\t']) {
        for (let index = 1; index < credential.length; index += 1) {
          const split = credential.slice(0, index) + separator + credential.slice(index);
          for (const tail of ['A', 'B']) {
            const input = `provider rejected ${split}; public=${tail}`;
            expectCredentialProjection(redactSecretShapedText(input)).toBe(
              `provider rejected [redacted]; public=${tail}`,
            );
            expectCredentialProjection((await boundForModel(input, BIG, {})).summary).toBe(
              `provider rejected [redacted]; public=${tail}`,
            );
          }
        }
      }
    }
  });

  it.each(['\n', '\t'])(
    'masks split schemes, finite header names and URL userinfo (%j)',
    (separator) => {
      for (const input of [
        `Authorization: Be${separator}arer opaque-credential-Z29; public=A`,
        `X-Api-${separator}Key: opaque-credential-Z29; public=A`,
        `https://alice:opaque${separator}password@provider.invalid/v1; public=A`,
      ]) {
        const output = redactSecretShapedText(input);
        expectCredentialProjection(output).not.toContain('opaque');
        expectCredentialProjection(output).not.toContain('password@');
        expectCredentialProjection(output).toContain('; public=A');
      }
    },
  );

  it.each(['?', '#'])(
    'masks raw %s within password userinfo and preserves contact queries',
    (separator) => {
      expectCredentialProjection(
        redactSecretShapedText(`https://alice:pa${separator}ss@provider.invalid/v1`),
      ).toBe('https://[redacted]@provider.invalid/v1');
      for (const host of ['provider.invalid', 'provider.invalid:8443', '[::1]:8443']) {
        const publicUrl = `https://${host}${separator}contact=alice@example.invalid`;
        expectCredentialProjection(redactSecretShapedText(publicUrl)).toBe(publicUrl);
      }
    },
  );

  it('keeps credential-free LF/TAB content byte-for-byte distinct', () => {
    for (const input of [
      'provider\nretry\tlater A',
      'provider\nretry\tlater B',
      'x-trace-id:\nordinary',
      'not_a_sk-short',
    ]) {
      expectCredentialProjection(redactSecretShapedText(input)).toBe(input);
    }
  });
});

describe('PR95 B2 projection boundaries and admitted-scale controls', () => {
  it.each([
    ['x-', '\n', '\t'],
    ['x-', '\t', '\n'],
    ['x-goog-', '\n', '\t'],
    ['x-goog-', '\t', '\n'],
  ])(
    'recovers the original finite header boundary after embedded %s (%j)',
    async (prefix, boundary, split) => {
      for (const publicTail of ['A', 'B']) {
        const input = `word${prefix}${boundary}api-${split}key: opaque-Z29; public=${publicTail}`;
        const expected = `word${prefix}${boundary}[redacted]; public=${publicTail}`;
        expect(redactSecretShapedText(input), 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY').toBe(expected);
        expect(
          redactSecretShapedValue({ body: input }),
          'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY',
        ).toEqual({
          body: expected,
        });
        expect(
          (await boundForModel(input, BIG, {})).summary,
          'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY',
        ).toBe(expected.replace(/\s+/g, ' '));
        const embedded = `word${prefix}api-${split}key: opaque-Z29; public=${publicTail}`;
        expect(redactSecretShapedText(embedded), 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY').toBe(
          embedded,
        );
      }
    },
  );

  it('bounds admitted-size failed finite header preparation', () => {
    const fragment = 'wordx-\tapi-\nkey ';
    const input = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
    const started = performance.now();
    const output = redactSecretShapedText(input);
    expect(output.length, 'SECRETS_B2_HEADER_PREPARATION').toBe(input.length);
    expect(output === input, 'SECRETS_B2_HEADER_PREPARATION').toBe(true);
    expect(performance.now() - started, 'SECRETS_B2_HEADER_PREPARATION').toBeLessThan(5_000);
  });

  it.each([
    ['sk-proj-', '\n'],
    ['sk-proj-', '\t'],
    ['AIza', '\n'],
    ['AIza', '\t'],
  ])(
    'keeps the original boundary after an embedded greedy prefix %s (%j)',
    async (prefix, separator) => {
      const publicPrefix = `word${prefix}${'A'.repeat(32)}${separator}`;
      for (const publicTail of ['A', 'B']) {
        const input = `${publicPrefix}${prefix}${'B'.repeat(32)}${separator}${'C'.repeat(32)}; public=${publicTail}`;
        const expected = `${publicPrefix}[redacted]; public=${publicTail}`;
        expect(redactSecretShapedText(input), 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe(expected);
        expect(redactSecretShapedValue({ body: input }), 'SECRETS_B2_ORIGINAL_BOUNDARY').toEqual({
          body: expected,
        });
        expect((await boundForModel(input, BIG, {})).summary, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe(
          expected.replace(/\s+/g, ' '),
        );
      }
    },
  );

  it('preserves canonical family acceptance through bounded joined probes', () => {
    const credentials = [
      `sk-${'A'.repeat(16)}`,
      `sk_live_${'A'.repeat(16)}`,
      `sk_test_${'A'.repeat(16)}`,
      ...['AKIA', 'ASIA', 'ABIA'].map((prefix) => `${prefix}${'A'.repeat(16)}`),
      ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'hf_', 'npm_'].map(
        (prefix) => `${prefix}${'A'.repeat(20)}`,
      ),
      `glpat-${'A'.repeat(16)}`,
      ...['xoxb-', 'xoxa-', 'xoxp-', 'xoxr-', 'xoxs-'].map(
        (prefix) => `${prefix}${'A'.repeat(10)}`,
      ),
      `AIza${'A'.repeat(30)}`,
      `ya29.${'A'.repeat(20)}`,
      `eyJ${'A'.repeat(10)}.${'B'.repeat(10)}.${'C'.repeat(6)}`,
    ];
    for (const credential of credentials) {
      expect(redactSecretShapedText(`${credential}; public=A`), 'SECRETS_B2_BOUNDED_PROBE').toBe(
        '[redacted]; public=A',
      );
      for (const padding of [0, 63, 64, 65, 128]) {
        const raw = `${credential}${'D'.repeat(padding)}; public=A`;
        for (const separator of ['\n', '\t']) {
          const split = raw.slice(0, 1) + separator + raw.slice(1);
          // The raw canonical projection is the preservation oracle, not a second grammar.
          expect(redactSecretShapedText(split), 'SECRETS_B2_BOUNDED_PROBE').toBe(
            redactSecretShapedText(raw),
          );
        }
      }
    }
    for (const length of [63, 64, 65, 128]) {
      const jwt = `eyJ${'A'.repeat(length)}\n.${'B'.repeat(length)}\t.${'C'.repeat(length)}-sk-${'D'.repeat(32)}\nTAIL`;
      expect(redactSecretShapedText(`${jwt}; public=A`), 'SECRETS_B2_BOUNDED_PROBE').toBe(
        '[redacted]; public=A',
      );
    }
  });

  it('bounds admitted-size repeated invalid JWT starts without losing later valid spans', () => {
    const fragment = `eyJ${'A'.repeat(61)}\n`;
    const publicPrefix = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
    const started = performance.now();
    // No dot, or a huge second run with no second dot: both full JWT attempts would scan to EOF.
    for (const suffix of ['', `.${'B'.repeat(128)}`]) {
      const input = `${publicPrefix}${suffix}; sk-proj-${'C'.repeat(32)}\t${'D'.repeat(32)}; public=A`;
      const expected = `${publicPrefix}${suffix}; [redacted]; public=A`;
      const output = redactSecretShapedText(input);
      expect(output.length, 'SECRETS_B2_BOUNDED_PROBE').toBe(expected.length);
      expect(output === expected, 'SECRETS_B2_BOUNDED_PROBE').toBe(true);
    }
    expect(performance.now() - started, 'SECRETS_B2_BOUNDED_PROBE').toBeLessThan(5_000);
  });

  it('bounds admitted-size raw hyphen-separated invalid JWT starts and masks a later whole key', () => {
    const fragment = 'eyJAAAAAAAAAA-';
    const publicPrefix = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
    const input = `${publicPrefix}sk-proj-${'C'.repeat(32)}-${'D'.repeat(32)}; public=A`;
    const expected = `${publicPrefix}[redacted]; public=A`;
    const started = performance.now();
    const output = redactSecretShapedText(input);
    expect(output.length, 'SECRETS_B2_RAW_BOUNDED_PROBE').toBe(expected.length);
    expect(output === expected, 'SECRETS_B2_RAW_BOUNDED_PROBE').toBe(true);
    expect(performance.now() - started, 'SECRETS_B2_RAW_BOUNDED_PROBE').toBeLessThan(5_000);
  });

  it('preserves dense admitted-size public boundaries with bounded preparation', () => {
    const started = performance.now();
    for (const fragment of ['a\n', 'a ']) {
      const input = `${fragment.repeat(4 * 1024 * 1024 - 1)}\n`;
      expect(redactSecretShapedText(input) === input, 'SECRETS_B2_BOUNDED_PROBE').toBe(true);
    }
    expect(performance.now() - started, 'SECRETS_B2_BOUNDED_PROBE').toBeLessThan(5_000);
  });

  it('retains prefix evidence inside a header and preserves the same public tail after multiple masks', () => {
    const credential = `sk-proj-${'A'.repeat(24)}\n${'B'.repeat(24)}`;
    const result = redactSecretShapedText(
      `Bearer ${credential}; https://u:pa\tss@host.invalid/a; public=B`,
    );
    expectCredentialProjection(result).not.toContain('AAAA');
    expectCredentialProjection(result).not.toContain('BBBB');
    expectCredentialProjection(result).toContain('host.invalid/a; public=B');
  });

  it('keeps the original left boundary when LF/TAB occurs elsewhere or immediately before a key', () => {
    const embedded = `wordsk-proj-${'A'.repeat(32)};\nordinary`;
    expectCredentialProjection(redactSecretShapedText(embedded)).toBe(embedded);
    const splitEmbedded = `wordsk-proj-${'A'.repeat(32)}\n${'B'.repeat(32)}; public=A`;
    expectCredentialProjection(redactSecretShapedText(splitEmbedded)).toBe(splitEmbedded);
    expectCredentialProjection(
      redactSecretShapedText(`rejected\nsk-proj-AAA\t${'B'.repeat(32)}; public=A`),
    ).toBe('rejected\n[redacted]; public=A');
  });

  it.each(['?', '#'])(
    'preserves public %s tails after userinfo and masks raw password assignments',
    (separator) => {
      expectCredentialProjection(
        redactSecretShapedText(
          `https://u:password@host.invalid${separator}contact=a@example.invalid`,
        ),
      ).toBe(`https://[redacted]@host.invalid${separator}contact=a@example.invalid`);
      expectCredentialProjection(
        redactSecretShapedText(`https://u:pa${separator}ss=value@host.invalid/v1`),
      ).toBe('https://[redacted]@host.invalid/v1');
    },
  );

  it('projects an 8 MiB split credential and public payload without clipping or RegExp stack growth', () => {
    const body = 'A'.repeat(8 * 1024 * 1024 - 256);
    const projected = redactSecretShapedText(`sk-proj-${body}\nBBBBBBBB; public=A`);
    // Fail with bounded metadata if a causal removal exposes this entire large credential.
    expectCredentialProjection(projected.length).toBe('[redacted]; public=A'.length);
    expectCredentialProjection(projected).toBe('[redacted]; public=A');
    const publicText = `${body}\n public-tail-B`;
    expectCredentialProjection(redactSecretShapedText(publicText)).toBe(publicText);
  });
});

describe('PR95 raw ?/# userinfo in the journal projection', () => {
  const userinfoContact = (value: unknown) => expect(value, 'SECRETS_B2_CORE_USERINFO_CONTACT');

  it.each([
    ['https://us?er:TOKEN@h.example/', 'https://[redacted]@h.example/'],
    ['https://us?er=1:TOKEN@h.example/', 'https://[redacted]@h.example/'],
  ])('masks userinfo whose raw ?/# follows no host-shaped prefix: %s', (input, expected) => {
    userinfoContact(redactSecretShapedText(input)).toBe(expected);
  });

  it.each([
    ['https://my.user:1234?TOKEN@h.example/', 'https://[redacted]@h.example/'],
    ['https://provider.example#section@x.example', 'https://[redacted]@x.example'],
  ])('masks a host-shaped prefix that no assignment follows: %s', (input, expected) => {
    userinfoContact(redactSecretShapedText(input)).toBe(expected);
  });

  it.each(['?', '#'])('retains public %s contact text after a host-shaped prefix', (separator) => {
    for (const host of [
      'provider.invalid',
      'provider.invalid:8443',
      'provider.invalid.',
      '10.0.0.1',
      'localhost:3000',
    ]) {
      const input = `connect https://${host}${separator}contact=alice@example.invalid failed`;
      expect(redactSecretShapedText(input)).toBe(input);
    }
  });

  it('keeps its documented differences from the LLM backstop', () => {
    // Core retains a colonless userinfo under 16 characters; the LLM diagnostic backstop masks it.
    expect(redactSecretShapedText('http://#TOKEN@h.example')).toBe('http://#TOKEN@h.example');
    expect(scrubSecrets('http://#TOKEN@h.example')).toBe('http://[REDACTED]@h.example');
    // Core's authority also ends at `"`, `'`, `,`, `}` and `]`, so it leaves userinfo containing
    // one of them as it is: an already-masked password, a bracketed-host prefix, a raw comma.
    for (const [input, masked] of [
      ['https://app:[REDACTED]@h.example/', 'https://[REDACTED]@h.example/'],
      ['https://[::1]:8443?u:TOKENTOKEN@h.example/', 'https://[REDACTED]@h.example/'],
      ['https://user:pa,ssword@host.example/', 'https://[REDACTED]@host.example/'],
    ] as const) {
      expect(redactSecretShapedText(input), input).toBe(input);
      expect(scrubSecrets(input), input).toBe(masked);
    }
  });

  it('agrees with the LLM backstop on every raw ?/# decision outside those differences', () => {
    for (const input of [
      'https://alice:pa?ss@provider.invalid/v1',
      'https://alice:pa#ss@provider.invalid/v1',
      'https://alice:pa?ss=value@provider.invalid/v1',
      'https://us?er:TOKEN@h.example/',
      'https://us?er=1:TOKEN@h.example/',
      'https://my.user:1234?TOKEN@h.example/',
      'https://provider.example#section@x.example',
      'https://provider.invalid?contact=alice@example.invalid',
      'https://provider.invalid:8443#contact=alice@example.invalid',
      'https://localhost:3000?contact=alice@example.invalid',
      'https://10.0.0.1#contact=alice@example.invalid',
      'https://john.doe:s3cret?x=1@h.example/',
      'https://localhostuser:pw?a=b@h.example/',
      'https://user:pw.evil.com?x=1@h.example/',
      'https://h.example:123456?x=1@h.example/',
      'https://h.example:65535?contact=alice@example.invalid',
    ]) {
      expect(redactSecretShapedText(input) === input, input).toBe(scrubSecrets(input) === input);
    }
  });

  it.each([
    'https://john.doe:s3cret?x=1@h.example/',
    'https://localhostuser:pw?a=b@h.example/',
    'https://user:pw.evil.com?x=1@h.example/',
    'https://h.example:123456?x=1@h.example/',
  ])('masks userinfo whose prefix only resembles a host: %s', (input) => {
    expect(redactSecretShapedText(input), 'SECRETS_B2_CORE_USERINFO_CONTACT').toBe(
      'https://[redacted]@h.example/',
    );
  });

  it('bounds the host-shaped prefix at exactly 260 characters, case-insensitively', () => {
    const host = (length: number) => `${'a'.repeat(length - 2)}.b`;
    const retained = `connect https://${host(260)}?contact=alice@example.invalid failed`;
    expect(redactSecretShapedText(retained), 'SECRETS_B2_CORE_USERINFO_HOST_LENGTH').toBe(retained);
    expect(
      redactSecretShapedText(`https://${host(261)}?contact=alice@example.invalid`),
      'SECRETS_B2_CORE_USERINFO_HOST_LENGTH',
    ).toBe('https://[redacted]@example.invalid');
    const upper = 'connect https://PROVIDER.INVALID:8443?contact=alice@example.invalid failed';
    expect(redactSecretShapedText(upper)).toBe(upper);
  });

  it('masks an admitted-size dotted userinfo prefix without exhausting the RegExp stack', () => {
    const labels = 'a.'.repeat(Math.floor((8 * 1024 * 1024 - 256 - 64) / 2));
    const input = `upstream said https://${labels}a?x=1@h failed`;
    let output = '';
    expect(() => {
      output = redactSecretShapedText(input);
    }, 'SECRETS_B2_CORE_USERINFO_HOST_LENGTH').not.toThrow();
    expect(
      output === 'upstream said https://[redacted]@h failed',
      'SECRETS_B2_CORE_USERINFO_HOST_LENGTH',
    ).toBe(true);
  }, 15_000);
});
