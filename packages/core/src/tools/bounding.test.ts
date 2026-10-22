import { scrubSecrets } from '@relavium/llm/scrub-secrets';
import type { AbortSignalLike } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  boundForModel,
  redactInlineMedia,
  redactSecretShapedText,
  projectSecretShapedValue,
  redactSecretShapedValue,
  utf8ByteLength,
} from './bounding.js';
import { fixedPointOf, toFixedPoint } from './fixed-point.js';
import type { ToolHost, ToolResultLimits } from './types.js';

// Observe the projection's bounded fixed point, retaining its actual implementation, so one case can
// make it fail and see which value the projection fails closed with.
vi.mock('./fixed-point.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixed-point.js')>();
  return {
    ...actual,
    fixedPointOf: vi.fn(actual.fixedPointOf),
    toFixedPoint: vi.fn(actual.toFixedPoint),
  };
});

/**
 * Eight-MiB cases take well under a second. Their bound is this case deadline, far below the minutes a
 * quadratic scan would need, rather than a wall-clock assertion that a loaded runner can trip. It is
 * also the largest case budget the secrets causal-control phases admit (`CAUSAL_TIMEOUT_BUDGET`).
 */
const ADMITTED_SIZE_CASE_TIMEOUT_MS = 15_000;

// The observation must not keep every admitted-size input and projection alive for the whole file.
afterEach(() => {
  vi.mocked(fixedPointOf).mockClear();
  vi.mocked(toFixedPoint).mockClear();
});

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
    expect(bounded.summary).toBe('');
  });

  it('summarizes a result that has no JSON form as unserializable, without rejecting', async () => {
    const throwing = Object.defineProperty({}, 'body', {
      enumerable: true,
      get() {
        throw new Error('getter fails');
      },
    });
    for (const result of [{ n: 10n }, throwing]) {
      const bounded = await boundForModel(result, BIG, host());
      expect(bounded.summary).toBe('[unserializable]');
    }
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

  it(
    'bounds admitted-size failed finite header preparation',
    () => {
      const fragment = 'wordx-\tapi-\nkey ';
      const input = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
      const output = redactSecretShapedText(input);
      expect(output.length, 'SECRETS_B2_HEADER_PREPARATION').toBe(input.length);
      expect(output === input, 'SECRETS_B2_HEADER_PREPARATION').toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

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

  it(
    'bounds admitted-size repeated invalid JWT starts without losing later valid spans',
    () => {
      const fragment = `eyJ${'A'.repeat(61)}\n`;
      const publicPrefix = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
      // No dot, or a huge second run with no second dot: both full JWT attempts would scan to EOF.
      for (const suffix of ['', `.${'B'.repeat(128)}`]) {
        const input = `${publicPrefix}${suffix}; sk-proj-${'C'.repeat(32)}\t${'D'.repeat(32)}; public=A`;
        const expected = `${publicPrefix}${suffix}; [redacted]; public=A`;
        const output = redactSecretShapedText(input);
        expect(output.length, 'SECRETS_B2_BOUNDED_PROBE').toBe(expected.length);
        expect(output === expected, 'SECRETS_B2_BOUNDED_PROBE').toBe(true);
      }
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it(
    'bounds admitted-size raw hyphen-separated invalid JWT starts and masks a later whole key',
    () => {
      const fragment = 'eyJAAAAAAAAAA-';
      const publicPrefix = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
      const input = `${publicPrefix}sk-proj-${'C'.repeat(32)}-${'D'.repeat(32)}; public=A`;
      const expected = `${publicPrefix}[redacted]; public=A`;
      const output = redactSecretShapedText(input);
      expect(output.length, 'SECRETS_B2_RAW_BOUNDED_PROBE').toBe(expected.length);
      expect(output === expected, 'SECRETS_B2_RAW_BOUNDED_PROBE').toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it(
    'preserves dense admitted-size public boundaries with bounded preparation',
    () => {
      for (const fragment of ['a\n', 'a ']) {
        const input = `${fragment.repeat(4 * 1024 * 1024 - 1)}\n`;
        expect(redactSecretShapedText(input) === input, 'SECRETS_B2_BOUNDED_PROBE').toBe(true);
      }
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

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
    // one of them as it is: an already-masked password, a bracketed-host prefix, a raw delimiter.
    for (const [input, masked] of [
      ['https://app:[REDACTED]@h.example/', 'https://[REDACTED]@h.example/'],
      ['https://[::1]:8443?u:TOKENTOKEN@h.example/', 'https://[REDACTED]@h.example/'],
      ['https://user:pa,ssword@host.example/', 'https://[REDACTED]@host.example/'],
      ['https://user:pa"ssword@host.example/', 'https://[REDACTED]@host.example/'],
      ["https://user:pa'ssword@host.example/", 'https://[REDACTED]@host.example/'],
      ['https://user:pa}ssword@host.example/', 'https://[REDACTED]@host.example/'],
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

  it(
    'masks an admitted-size dotted userinfo prefix without exhausting the RegExp stack',
    () => {
      const labels = 'a.'.repeat(Math.floor((8 * 1024 * 1024 - 256 - 64) / 2));
      const input = `upstream said https://${labels}a?x=1@h.example failed`;
      let output = '';
      expect(() => {
        output = redactSecretShapedText(input);
      }, 'SECRETS_B2_CORE_USERINFO_HOST_LENGTH').not.toThrow();
      expect(
        output === 'upstream said https://[redacted]@h.example failed',
        'SECRETS_B2_CORE_USERINFO_HOST_LENGTH',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );
});

describe('PR95 review round 4: ambiguous authorities, URL schemes after labels and split edges', () => {
  it('masks a secret query value that holds a raw @ after a single-label host', () => {
    for (const [input, expected, tail] of [
      ['mysql://db?user=root&password=Adm1n@2024!secure', 'mysql://[redacted]', '2024!secure'],
      ['https://svc?access_token=ya29@abcdefXYZ', 'https://[redacted]', 'abcdefXYZ'],
    ] as const) {
      const output = redactSecretShapedText(input);
      expect(output, 'SECRETS_B4_CORE_AUTHORITY_REST').toBe(expected);
      expect(output.includes(tail), 'SECRETS_B4_CORE_AUTHORITY_REST').toBe(false);
    }
    // A raw ?/# in a password does not hide the host it connects to.
    for (const [input, expected] of [
      ['https://alice:pa?ss@provider.invalid/v1', 'https://[redacted]@provider.invalid/v1'],
      ['https://u:p?w@[::1]:8443/x', 'https://[redacted]@[::1]:8443/x'],
      ['https://u:p?w@localhost:3000/x', 'https://[redacted]@localhost:3000/x'],
    ] as const) {
      expect(redactSecretShapedText(input), 'SECRETS_B4_CORE_AUTHORITY_REST').toBe(expected);
    }
  });

  it(
    'masks an admitted-size query value inside an ambiguous userinfo',
    () => {
      const labels = 'a.'.repeat(Math.floor((8 * 1024 * 1024 - 256 - 64) / 2));
      const input = `upstream said https://user:pw?x=1@${labels}a failed`;
      let output = '';
      expect(() => {
        output = redactSecretShapedText(input);
      }, 'SECRETS_B5_CORE_QUERY_EXTENT').not.toThrow();
      expect(
        output === 'upstream said https://[redacted] failed',
        'SECRETS_B5_CORE_QUERY_EXTENT',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('masks the userinfo of a URL behind a scheme label, split or not, and a token glued to a URL', () => {
    for (const [input, expected] of [
      [
        'invalid token postgres://app:hunter2secret@db\n',
        'invalid token [redacted]://[redacted]@db\n',
      ],
      ['invalid token postgres://app:pa#ss@db\n', 'invalid token [redacted]://[redacted]@db\n'],
      ['token postgresql://app:hunter2secret@db', 'token [redacted]://[redacted]@db'],
      ['token abcdefghijkl\n', 'token [redacted]\n'],
      ['Bearer abcdefgh12345678/https://x.example', 'Bearer [redacted]://x.example'],
      ['Bearer abcDEF123456xyzhttps://h.example', 'Bearer [redacted]://h.example'],
      ['token\tabcdefgh12345678/https://x', 'token [redacted]://x'],
      [
        'Authorization: Bearer abcDEF123456xyzhttps://u:p@h.example',
        '[redacted] [redacted]://[redacted]@h.example',
      ],
    ] as const) {
      expect(redactSecretShapedText(input), 'SECRETS_B5_CORE_SCHEME_ORDER').toBe(expected);
    }
  });

  it.each(['\n', '\t'])('masks URL userinfo split at either of its edges (%j)', (separator) => {
    for (const input of [
      `https://user:hunter2secret${separator}@host.example/x`,
      `https://${separator}user:hunter2secret@host.example/x`,
    ]) {
      expect(redactSecretShapedText(input), 'SECRETS_B4_CORE_SPLIT_EDGE').toBe(
        'https://[redacted]@host.example/x',
      );
    }
  });

  it('reaches a fixed point', () => {
    // The opaque value removes the authority's last `@`, so the second pass reads a new userinfo.
    for (const [input, expected] of [
      ['g://s.hos#mHPGEAXXQ8@?q==a@b.exam/user:3eYPUzfxo', 'g://[redacted]@?q=[redacted]'],
      ['[redacted]', '[redacted]'],
    ] as const) {
      const output = redactSecretShapedText(input);
      expect(output, 'SECRETS_B4_CORE_FIXED_POINT').toBe(expected);
      expect(redactSecretShapedText(output), 'SECRETS_B4_CORE_FIXED_POINT').toBe(output);
    }
  });
});

describe('PR95 review round 5: an ambiguous userinfo masked with exactly the values later rules read', () => {
  const pem = [
    'https://a?b:c@-----BEGIN RSA PRIVATE KEY-----',
    'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const projects = (marker: string, pairs: readonly (readonly [string, string, string])[]) => {
    for (const [input, expected, secret] of pairs) {
      const output = redactSecretShapedText(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(secret), marker).toBe(false);
      expect(redactSecretShapedText(output), marker).toBe(output);
    }
  };

  it('masks an ambiguous userinfo with the query values its later rules would mask whole', () => {
    projects('SECRETS_B5_CORE_QUERY_EXTENT', [
      ['mysql://db?user=root&password=Adm1n@2024.prod', 'mysql://[redacted]', '2024.prod'],
      ['https://gateway?password=P@ss.word1', 'https://[redacted]', 'ss.word1'],
      ['https://svc?client_secret=abcdefgh@def.example', 'https://[redacted]', 'def.example'],
      ['https://svc?x.client_secret=abcdefgh@def.example', 'https://[redacted]', 'def.example'],
      [
        'postgres://db?sslmode=require&password=Adm1n@x/Secret2024',
        'postgres://[redacted]',
        'Secret2024',
      ],
      [
        'see https://svc?token=abcdefghij@foo.example/x for details',
        'see https://[redacted] for details',
        'foo.example',
      ],
      ['https://user:pw?token=abcdefgh@host', 'https://[redacted]', 'host'],
      [`https://svc?sig=${'A'.repeat(24)}@tail.example`, 'https://[redacted]', 'tail.example'],
      [
        'https://proxy?redirect_target=a@http://user:secretpw@host.example/',
        'https://[redacted]',
        'secretpw',
      ],
      ['https://svc:pw?x=1@ftp://user:pw2secret@h.example/', 'https://[redacted]', 'pw2secret'],
    ]);
    // A value no later rule masks leaves the userinfo mask where it was.
    for (const [input, expected] of [
      ['https://us?er=1:TOKEN@h.example/', 'https://[redacted]@h.example/'],
      ['https://alice:pa?ss@provider.invalid/v1', 'https://[redacted]@provider.invalid/v1'],
    ] as const) {
      expect(redactSecretShapedText(input), 'SECRETS_B5_CORE_QUERY_EXTENT').toBe(expected);
    }
  });

  it('keeps the context of a later credential after an ambiguous authority', () => {
    projects('SECRETS_B5_CORE_LATER_CONTEXT', [
      [
        'url: postgres://app:pa#ss@db.internal\npassword: hunter2hunter2\n',
        'url: postgres://[redacted]@db.internal\n[redacted]\n',
        'hunter2hunter2',
      ],
      [
        'url: postgres://app:pa#ss@db.internal\n\ttoken: hunter2hunter2\n',
        'url: postgres://[redacted]@db.internal\n\t[redacted]\n',
        'hunter2hunter2',
      ],
      [
        'https://user:pa?ss@minio?sig=Zm9vYmFy/YmF6cXV4cXV1eHh4eHh4eHh4eHh4',
        'https://[redacted]@minio?sig=[redacted]',
        'YmF6cXV4',
      ],
      [
        'https://a?b:c@Bearer abcdefgh12345678',
        'https://[redacted]@Bearer [redacted]',
        'abcdefgh12345678',
      ],
      [pem, 'https://[redacted]@[redacted]', 'MIIBOgIBAAJBAKj34'],
      [
        'DATABASE_URL=mysql://db?user=root&password=Adm1n@2024\nREPLICA_URL=postgres://app:hunter2secret@replica/x',
        'DATABASE_URL=mysql://[redacted]\nREPLICA_URL=postgres://[redacted]@replica/x',
        'hunter2secret',
      ],
      [
        'https://gateway?password=P@ssw0rd123\nBearer hunter2secretvalue',
        'https://[redacted]\nBearer [redacted]',
        'hunter2secretvalue',
      ],
      [
        'https://gateway?password=P@ssw0rd123\tx-api-key: hunter2secretvalue',
        'https://[redacted]\t[redacted]',
        'hunter2secretvalue',
      ],
      [
        'mysql://db?user=root&password=Adm1n@2024;Bearer hunter2secretvalue',
        'mysql://[redacted];Bearer [redacted]',
        'hunter2secretvalue',
      ],
    ]);
  });

  it.each(['\n', '\t'])(
    'masks URL userinfo whose scheme is split by an LF or TAB (%j)',
    (separator) => {
      for (const [input, expected] of [
        [
          `https:/${separator}/user:hunter2secret@host.example/x`,
          `https:/${separator}/[redacted]@host.example/x`,
        ],
        [
          `https${separator}://user:hunter2secret@host.example`,
          `https${separator}://[redacted]@host.example`,
        ],
        [
          `ssh:${separator}//deploy:hunter2secret@h.example`,
          `ssh:${separator}//[redacted]@h.example`,
        ],
      ] as const) {
        expect(redactSecretShapedText(input), 'SECRETS_B5_CORE_SPLIT_SCHEME').toBe(expected);
      }
    },
  );

  it(
    'masks a token glued to a URL at admitted size',
    () => {
      const input = `Bearer ${'a'.repeat(8 * 1024 * 1024 - 64)}://h.example`;
      let output = '';
      expect(() => {
        output = redactSecretShapedText(input);
      }, 'SECRETS_B5_CORE_SCHEME_ORDER').not.toThrow();
      expect(output === 'Bearer [redacted]://h.example', 'SECRETS_B5_CORE_SCHEME_ORDER').toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );
});

describe('PR95 review round 6: one merged pass of every core rule', () => {
  const pem = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const projects = (marker: string, pairs: readonly (readonly [string, string, string])[]) => {
    for (const [input, expected, secret] of pairs) {
      const output = redactSecretShapedText(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(secret), marker).toBe(false);
      expect(redactSecretShapedText(output), marker).toBe(output);
    }
  };

  it('keeps every credential and its context when core masks overlap', () => {
    projects('SECRETS_B6_CORE_MERGE', [
      [
        'https://a?b:c&password=xy@Bearer abcdefgh12345678',
        'https://[redacted] [redacted]',
        'abcdefgh12345678',
      ],
      [
        'https://svc?password=abcd@c/Bearer abcdefgh12345678',
        'https://[redacted] [redacted]',
        'abcdefgh12345678',
      ],
      [`https://a?b:c&password=xy@${pem}`, 'https://[redacted]', 'MIIBOgIBAAJBAKj34'],
      [
        `https://u:pw?x=${'a'.repeat(24)}@h;Bearer abcdefgh12345678`,
        'https://[redacted] [redacted]',
        'abcdefgh12345678',
      ],
      [
        'postgres://app:pw?application_name=reporting-service-01@db;password="S3cr3tValue99"',
        'postgres://[redacted]',
        'S3cr3tValue99',
      ],
      [
        'mysql://db?user=root&password=Adm1n@2024.prod/Bearer hunter2secretvalue',
        'mysql://[redacted] [redacted]',
        'hunter2secretvalue',
      ],
      [`redis://db#client_secret=G5oK47GKkhEp@2024.prod/${pem}`, 'redis://[redacted]', 'MIIBOg'],
    ]);
  });

  it.each(['\n', '\t', 'word\t', 'DATABASE_URL:\n'])(
    'masks an ambiguous userinfo with its query values behind %j',
    (prefix) => {
      projects('SECRETS_B6_CORE_MERGE', [
        [`${prefix}https://gateway?password=P@ssw0rd123`, `${prefix}https://[redacted]`, 'ssw0rd'],
        [
          `${prefix}mysql://db?user=root&password=Adm1n@2024.prod`,
          `${prefix}mysql://[redacted]`,
          '2024.prod',
        ],
        [
          `${prefix}see https://svc?token=abcdefghij@foo.example/x for details`,
          `${prefix}see https://[redacted] for details`,
          'foo.example',
        ],
        [
          `${prefix}https://svc?sig=${'A'.repeat(24)}@tail.example`,
          `${prefix}https://[redacted]`,
          'tail.example',
        ],
      ]);
    },
  );

  it('masks an ambiguous userinfo whose scheme is split by an LF', () => {
    projects('SECRETS_B6_CORE_MERGE', [
      ['https:/\n/svc?password=Secret@tail99', 'https:/\n/[redacted]', 'tail99'],
      ['https://\nsvc?password=Secret@tail99', 'https://[redacted]', 'tail99'],
    ]);
  });

  it("reads a key inside another key's value", () => {
    projects('SECRETS_B6_CORE_NESTED_KEY', [
      ['token=abcdef>password: hunter2hunter2', '[redacted]', 'hunter2hunter2'],
      [
        'https://user:pw?token=K9wR2v@db/x>password: hunter2hunter2',
        'https://[redacted]',
        'hunter2hunter2',
      ],
      [
        'postgres://u:p?password=K9wR2v@db/path[api_key: SECRETVALUE99',
        'postgres://[redacted]',
        'SECRETVALUE99',
      ],
      [
        '{"msg":"http://app:pw?a=1&x=OGePIzn69aW2APSxEBy7@def.example\\nx-api-key: R2FIHKWkS0J2kZ0L35"}',
        '{"msg":"http://[redacted]"}',
        'R2FIHKWkS0J2kZ0L35',
      ],
      ['x-api-key: "abc password="hunter2 secret value"', '[redacted]', 'secret value'],
    ]);
  });

  it("reads a scheme label inside another label's token", () => {
    projects('SECRETS_B6_CORE_NESTED_LABEL', [
      ['Bearer abcdefgh/Bearer hunter2secretvalue', 'Bearer [redacted] [redacted]', 'hunter2'],
      ['token abcdefgh12/Basic hunter2secretvalue==', 'token [redacted] [redacted]', 'hunter2'],
    ]);
  });

  it('reads a value through the masks before it, line breaks included', () => {
    projects('SECRETS_B6_CORE_VALUE_THROUGH_MASK', [
      [
        '{"a":"x-api-key": "QL9uUu2jzxnM\txoxb-QWZDhKp63WKU\naccess_token="Qi3YmmwU37GH Qqu6LcyxbzW8"',
        '{"a":"[redacted]',
        'QL9uUu2jzxnM',
      ],
      [
        `x-api-key: "v@${pem}client_secret="Q9w8EwQDxFP2 QmeNGkQBxtfm"`,
        '[redacted]',
        'Q9w8EwQDxFP2',
      ],
      [
        'token: "abc sk-proj-abcdefghij\nklmnopqrstuv" password: "secret value 1"',
        '[redacted] [redacted]',
        'secret value',
      ],
    ]);
  });

  it('joins a split header label right after a credential or a PEM block', () => {
    projects('SECRETS_B6_CORE_MASK_BOUNDARY', [
      [
        'url: AKIA\nQRTBLS2XNANSABCDx-api-\tkey": "QzJsBjkrL2GS?access_token="QeKrgCE47mCW QW2Y8jaZkAPA"',
        'url: [redacted]',
        'QzJsBjkrL2GS',
      ],
      [`${pem}authori\nzation: QFzQnbCdq2TL`, '[redacted]', 'QFzQnbCdq2TL'],
      ['AKIAQNNKD8CEOFHOABCDauthori\nzation:QNauurwS3vLp', '[redacted]', 'QNauurwS3vLp'],
    ]);
  });

  it('reads a scheme label or a credential glued to the end of another credential', () => {
    projects('SECRETS_B6_CORE_MASK_BOUNDARY', [
      [
        'x\n\tclient_secret=QRYyV2UYKhnz!AKIAQPJ53XE28CC4A\nBCDtoken QNZd4i2J6YY5',
        'x\n\t[redacted] [redacted]',
        'QNZd4i2J6YY5',
      ],
      ['AKIAQPJ53XE28CC4ABCDtoken QNZd4i2J6YY5', '[redacted]token [redacted]', 'QNZd4i2J6YY5'],
      [
        'client_secret=QRYyV2UYKhnz!AKIAQPJ53XE28CC4ABCDtoken QNZd4i2J6YY5',
        '[redacted] [redacted]',
        'QNZd4i2J6YY5',
      ],
      ['AKIAQPJ53XE28CC4ABCDsk-proj-abcdefghijklmnopqrstuv', '[redacted][redacted]', 'ghijklmnop'],
      [
        'AKIAQPJ53XE28CC4A\nBCDsk-proj-abcdefghijklmnopqrstuv',
        '[redacted][redacted]',
        'ghijklmnop',
      ],
    ]);
  });

  it('keeps the host of a URL whose userinfo names a secret', () => {
    const userinfo = (value: unknown) => expect(value, 'SECRETS_B6_CORE_USERINFO_ZONE');
    for (const [input, expected] of [
      [
        'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/org/repo.git',
        'https://[redacted]@github.com/org/repo.git',
      ],
      [
        'https://token:abcdef@h.example/x?password=hunter2hunter2',
        'https://[redacted]@h.example/x?[redacted]',
      ],
      [`https://a&sig=${'X'.repeat(28)}:pw@h.example/`, 'https://[redacted]@h.example/'],
      // Before a raw ?/#, a `user:password` owns its text; the query after it stays readable.
      ['https://token:pa?ss@h.example/repo', 'https://[redacted]@h.example/repo'],
      ['https://token:abc?x=1@host/path?y=2', 'https://[redacted]@host/path?y=2'],
    ] as const) {
      userinfo(redactSecretShapedText(input)).toBe(expected);
    }
  });

  it('reads every key of an ambiguous userinfo that names no user', () => {
    projects('SECRETS_B6_CORE_USERINFO_COLON', [
      ['https://password=Secret1?x@t123456', 'https://[redacted]', 't123456'],
      [`https://a&sig=${'X'.repeat(28)}?y@tail99`, 'https://[redacted]', 'tail99'],
      ['https://svc?a=1;password=P@ssw0rd123', 'https://[redacted]', 'ssw0rd123'],
      ['https://svc?password:P@ssw0rd99', 'https://[redacted]', 'ssw0rd99'],
      ['https://svc?x!password=Secr@t123456', 'https://[redacted]', 't123456'],
      ['https://svc?a=b+password=Secr@t123456', 'https://[redacted]', 't123456'],
      [`https://svc?${'n'.repeat(70)}.password=Secr@t123456`, 'https://[redacted]', 't123456'],
    ]);
  });

  it('projects a split URL into the summary and the journal value alike', async () => {
    const result = await boundForModel('see\nhttps://gateway?password=P@ssw0rd123 now', BIG, {});
    expect(result.summary, 'SECRETS_B6_CORE_MERGE').toBe('see https://[redacted] now');
    expect(
      redactSecretShapedValue({ url: 'x\thttps://gateway?password=P@ssw0rd123' }),
      'SECRETS_B6_CORE_MERGE',
    ).toEqual({ url: 'x\thttps://[redacted]' });
  });

  it(
    'keeps many query assignments in an ambiguous userinfo linear at admitted size',
    () => {
      const size = 8 * 1024 * 1024 - 256;
      const run = (prefix: string, unit: string, suffix: string) =>
        prefix +
        unit.repeat(Math.floor((size - prefix.length - suffix.length) / unit.length)) +
        suffix;
      for (const [input, expected] of [
        [run('https://x', '?password=', '@h'), 'https://[redacted]'],
        [run('https://x', '?a=', '@h'), 'https://[redacted]'],
        [run('https://svc?', '#password=x', '@h'), 'https://[redacted]'],
        [run('see https://svc', '?token=a@b', ''), 'see https://[redacted]'],
        [run('redis://app:pw', '?client_secret=x', '@db'), 'redis://[redacted]'],
      ] as const) {
        let output = '';
        expect(() => {
          output = redactSecretShapedText(input);
        }, 'SECRETS_B6_CORE_MERGE').not.toThrow();
        expect(output === expected, 'SECRETS_B6_CORE_MERGE').toBe(true);
      }
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it(
    'keeps nested values, labels and open PEM blocks linear at admitted size',
    () => {
      const size = 8 * 1024 * 1024 - 256;
      const count = (unit: string) => Math.floor(size / unit.length);
      const keys = 'token=ab>'.repeat(count('token=ab>'));
      expect(redactSecretShapedText(keys) === '[redacted]', 'SECRETS_B6_CORE_NESTED_KEY').toBe(
        true,
      );
      const labels = count('Bearer abcdefgh/');
      expect(
        redactSecretShapedText('Bearer abcdefgh/'.repeat(labels)) ===
          `Bearer${' [redacted]'.repeat(labels)}`,
        'SECRETS_B6_CORE_NESTED_LABEL',
      ).toBe(true);
      // Only the BEGIN marker whose body reaches the far END within the body bound opens a block; the
      // markers before it stay, and each of them reuses one END search instead of scanning to it again.
      const marker = '-----BEGIN PRIVATE KEY-----\n';
      const open = marker.repeat(count(marker) - 1);
      const first =
        Math.ceil((open.length - 20_000 - (marker.length - 1)) / marker.length) * marker.length;
      expect(
        redactSecretShapedText(`password=hunter2secret ${open}-----END PRIVATE KEY-----`) ===
          `[redacted] ${open.slice(0, first)}[redacted]`,
        'SECRETS_B6_CORE_MERGE',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('masks a PEM block whose body reaches exactly the body bound', () => {
    const begin = '-----BEGIN PRIVATE KEY-----';
    const end = '-----END PRIVATE KEY-----';
    const bounded = (value: unknown) => expect(value, 'SECRETS_B6_CORE_MERGE');
    bounded(redactSecretShapedText(`${begin}${'A'.repeat(20_000)}${end}`)).toBe('[redacted]');
    const longer = `${begin}${'A'.repeat(20_001)}${end}`;
    bounded(redactSecretShapedText(longer) === longer).toBe(true);
  });

  it('fails closed with its own mask when the projection does not settle', () => {
    vi.mocked(toFixedPoint).mockImplementationOnce((_pass, _text, failed) => failed);
    expect(redactSecretShapedText('public text'), 'SECRETS_B6_CORE_FAIL_CLOSED').toBe('[redacted]');
  });
});

describe('PR95 review round 7: userinfo ownership, admitted quoted values, glued credentials', () => {
  const projects = (marker: string, pairs: readonly (readonly [string, string, string])[]) => {
    for (const [input, expected, secret] of pairs) {
      const output = redactSecretShapedText(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(secret), marker).toBe(false);
      expect(redactSecretShapedText(output), marker).toBe(output);
    }
  };

  it("owns no text past a split userinfo's first LF or TAB", () => {
    projects('SECRETS_B7_CORE_SPLIT_ZONE', [
      [
        'see https://\nDATABASE_PASSWORD=P@ssw0rd123 now',
        'see https://[redacted] now',
        'ssw0rd123',
      ],
      ['x https://\tSERVICE_TOKEN_VALUE=Adm1n@2024x', 'x https://[redacted]', '2024x'],
      [
        'DATABASE_URL=https://db.internal.example.com\nDB_PASSWORD=P@ssw0rd123\n',
        'DATABASE_URL=https://[redacted]\n',
        'ssw0rd123',
      ],
      [
        'REDIS_URL=redis://cache.internal:6379\nREDIS_PASSWORD=r3d1s@Passw0rd\n',
        'REDIS_URL=redis://[redacted]\n',
        'Passw0rd',
      ],
      // A username-shaped key on the next line is no username of this URL.
      ['see https://\nDB_PASSWORD:P@ssw0rd123 now', 'see https://[redacted] now', 'ssw0rd123'],
      ['x https://\tSERVICE_TOKEN:Adm1n@2024x', 'x https://[redacted]', '2024x'],
      // A mask past the userinfo's @ stops at the next line, which is read on its own.
      [
        'DATABASE_URL=https://db.internal.example.com\nDB_PASSWORD=P@ssw0rd123\nNEXT=1',
        'DATABASE_URL=https://[redacted]\nNEXT=1',
        'ssw0rd123',
      ],
      // Read on its own line, the key masks its whole value, a host-shaped tail included.
      [
        'see https://\nDB_PASSWORD=P@host.example now',
        'see https://\n[redacted] now',
        'host.example',
      ],
    ]);
  });

  it("reads a key in a userinfo's password or parameter position", () => {
    projects('SECRETS_B7_CORE_USERNAME_ZONE', [
      [
        'jdbc:sqlserver://db.example:1433;databaseName=app;user=sa;password=P@ssw0rd2024;encrypt=true',
        'jdbc:sqlserver://[redacted];encrypt=true',
        'ssw0rd2024',
      ],
      ['https://svc;a=1;password=P@ssw0rd123', 'https://[redacted]', 'ssw0rd123'],
      ['mysql://h.example;password=Secr3tValue@x', 'mysql://[redacted]', 'Secr3tValue'],
      [
        '{"content":"REDIS_URL=redis://cache.internal:6379\\nREDIS_PASSWORD=r3d1s@Passw0rd\\n"}',
        '{"content":"REDIS_URL=redis://[redacted]"}',
        'Passw0rd',
      ],
      // Its value runs to the key rule's own delimiter, through the host, path and query.
      [
        'https://user:password=Secr3tValue1@host.example/v1/a',
        'https://[redacted]',
        'host.example',
      ],
      [
        'GET https://svc:secret=Qz7abc@api.example.com/v1/items/123?expand=all&page=2 200',
        'GET https://[redacted]&page=2 200',
        'api.example.com',
      ],
      ['sqlserver://;password=Adm1n@2024.prod/app', 'sqlserver://;[redacted]', '2024.prod'],
      [
        '"custom\t://user:db.password=Qz5SjmRYV4@Qz7uzLd396yJU1\neyJQz4kX2Nk3X2tw9s.Qz6CteaZX56zE1JL09cObAqM06.Qz0wvWBdMRLWj7  x',
        '"custom\t://[redacted]\n[redacted]  x',
        'Qz7uzLd396yJU1',
      ],
    ]);
    // From a raw ?/# on, a key reads as a query parameter whose value runs to its own end too, and a
    // colon after a raw ?/# or before any username marks no user.
    projects('SECRETS_B7_CORE_USERNAME_ZONE', [
      ['https://password=abcdefgh?x:y@host.example/path', 'https://[redacted]', 'abcdefgh'],
      ['https://:password=abcdefghij?x@host.example/p', 'https://[redacted]', 'abcdefghij'],
    ]);
    // Only a value some rule reads runs to its own end: a short value under another name is masked
    // through the userinfo's last '@', and its text after that '@' reads as the host.
    expect(
      redactSecretShapedText('https://svc?a=1&code=Adm1n@2024prod'),
      'SECRETS_B7_CORE_USERNAME_ZONE',
    ).toBe('https://[redacted]@2024prod');
    // Such a value is a recognized credential: calls that differ only in its host or path share a
    // journal projection, while a URL whose userinfo holds no key keeps them apart.
    const identity = (url: string) => projectSecretShapedValue({ url, method: 'POST' }).value;
    expect(
      identity('https://user:password=Secr3tValue1@host.example/v1/a'),
      'SECRETS_B7_CORE_USERNAME_ZONE',
    ).toEqual(identity('https://user:password=Secr3tValue1@other.example/v2/delete/7'));
    expect(
      identity('https://user:Secr3tValue1@host.example/v1/a'),
      'SECRETS_B7_CORE_USERNAME_ZONE',
    ).not.toEqual(identity('https://user:Secr3tValue1@host.example/v1/b'));
  });

  it('keeps the host when only the username names a secret, split after its colon or not', () => {
    const host = (value: unknown) => expect(value, 'SECRETS_B7_CORE_USERNAME_ZONE');
    host(
      redactSecretShapedText(
        'https://x-access-token:\nghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r',
      ),
    ).toBe('https://[redacted]@github.com/o/r');
    // Split inside the username, the key after the break is read and masks the host: fail-closed.
    host(
      redactSecretShapedText(
        'https://x-access-\ntoken:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r',
      ),
    ).toBe('https://[redacted]');
  });

  it(
    'projects exactly admitted-size quoted values without exhausting the RegExp stack',
    () => {
      const size = 8 * 1024 * 1024;
      const exact = (prefix: string, suffix: string) =>
        `${prefix}${'a'.repeat(size - prefix.length - suffix.length)}${suffix}`;
      for (const [input, expected] of [
        // An unclosed value is read as an unquoted run from after its quote; here that run reaches the
        // end of the text.
        [exact('token="', ''), '[redacted]'],
        [exact('password="', '"'), '[redacted]'],
        [exact("password='", "'"), '[redacted]'],
        [exact('{"access_token":"', '"}'), '{"[redacted]}'],
        // One JSON level down, closed and unclosed.
        [exact('{"b":"{\\"token\\":\\"', '\\"}"}'), '{"b":"{\\"[redacted]}"}'],
        [exact('{"b":"token=\\"', '"}'), '{"b":"[redacted]"}'],
      ] as const) {
        expect(input.length, 'SECRETS_B7_CORE_QUOTED_SCAN').toBe(size);
        let output = '';
        expect(() => {
          output = redactSecretShapedText(input);
        }, 'SECRETS_B7_CORE_QUOTED_SCAN').not.toThrow();
        expect(output === expected, 'SECRETS_B7_CORE_QUOTED_SCAN').toBe(true);
      }
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it("keeps quoted values on one line and pins the key rule's names and delimiters", () => {
    const keys = (value: unknown) => expect(value, 'SECRETS_B7_CORE_KEY_PIECES');
    for (const input of [
      'passwd=hunter2hunter2',
      'access_key=hunter2hunter2',
      'access-key: hunter2hunter2',
      'private_key=hunter2hunter2',
      'private-key: hunter2hunter2',
      'api_key_id=abcdef123456',
    ]) {
      keys(redactSecretShapedText(input)).toBe('[redacted]');
    }
    keys(redactSecretShapedText('password=hunter2hunter2&next=public')).toBe(
      '[redacted]&next=public',
    );
    keys(redactSecretShapedText('token=abcdefgh,next')).toBe('[redacted],next');
    keys(redactSecretShapedText("token=abcdefgh'tail")).toBe("[redacted]'tail");
    // A quoted value closes on its line. One that does not, even past an escaped line break, is read
    // as an unquoted run from after its quote, to that line's end at most: its quote may instead close
    // a string the key sits in.
    for (const kept of [
      'password="abc\ndef" tail',
      "password='abc\rdef' tail",
      'password="abc\ndef tail',
      'password="abc\\\ndef tail',
    ]) {
      keys(redactSecretShapedText(kept)).toBe(kept);
    }
    keys(redactSecretShapedText('password="abcdef\nghi" tail')).toBe('[redacted]\nghi" tail');
    keys(redactSecretShapedText('password="abcdef\\\nghi tail')).toBe('[redacted]\nghi tail');
    // A key must start within its word's first 33 characters.
    const listed = `x${'y'.repeat(40)}token=listed`;
    keys(redactSecretShapedText(listed)).toBe(listed);
  });

  it('recognizes a credential glued to another one pass later and redacts a run that never settles', async () => {
    const two = 'AKIAAAAAAAAAAAAAAAAAASIABBBBBBBBBBBBBBBB';
    projects('SECRETS_B8_CORE_GLUED', [
      [`${two} public tail`, '[redacted][redacted] public tail', 'BBBBBBBB'],
      // Four glued ids need four passes: the text does not settle and fails closed.
      [`${two}AKIACCCCCCCCCCCCCCCCASIADDDDDDDDDDDDDDDD public tail`, '[redacted]', 'DDDDDDDD'],
      [
        'AKIAABCDEFGHIJKLMNOPghp_AAAAAAAAAAAA\nBBBBBBBBBBBBBBBB done',
        '[redacted][redacted] done',
        'BBBBBBBB',
      ],
      [
        'AKIAABCDEFGHIJKLMNOPsk-proj-AAAAAAAAAAAAAAAA\nBBBBBBBBBBBB done',
        '[redacted][redacted] done',
        'BBBBBBBB',
      ],
      // A glued credential is read at the mask's boundary, so it neither cuts a wider credential
      // that starts inside it nor swallows a key name or a scheme label after it.
      [
        'AKIAIOSFODNN7EXAMPLExoxb-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM',
        '[redacted]xoxb-[redacted]',
        'SflKxwRJSMeKKF2QT4fwpM',
      ],
      [
        'AKIAIOSFODNN7EXAMPLExoxb-sk-proj-abcdefghij_klmnopqrstuv',
        '[redacted]xoxb-[redacted]',
        'klmnopqrstuv',
      ],
      [
        'AKIAIOSFODNN7EXAMPLEnpm_abcdefghij0123456789token=SuperSecret99',
        '[redacted][redacted]',
        'SuperSecret99',
      ],
      [
        'AKIAABCDEFGHIJKLMNOPsk-AKIAABCDEFGHIJKLMNOPBearer abcdefghijklmnop',
        '[redacted]sk-[redacted]Bearer [redacted]',
        'abcdefghijklmnop',
      ],
    ]);
    const summary = await boundForModel(
      'AKIAABCDEFGHIJKLMNOPsk-proj-AAAAAAAAAAAAAAAA\tBBBBBBBBBBBB done',
      BIG,
      {},
    );
    expect(summary.summary, 'SECRETS_B8_CORE_GLUED').toBe('[redacted][redacted] done');
  });

  it("summarizes with the projection's fixed point before one-line normalization", async () => {
    const result = await boundForModel(
      'g://s.hos#mHPGE\nAXXQ8@?q==a@b.exam/user:3eYPUzfxo',
      BIG,
      {},
    );
    expect(result.summary, 'SECRETS_B7_CORE_SUMMARY').toBe('g://[redacted]@?q=[redacted]');
  });

  it('reads a value through earlier masks of every kind, in text order', () => {
    projects('SECRETS_B6_CORE_VALUE_THROUGH_MASK', [
      ['token=xyz?sig=AAAAAAAAAAAAAAAAAAAAAAAA;BBB#TAILSECRET', '[redacted]', 'TAILSECRET'],
      [
        'password=https://svc?sig=AAAAAAAAAAAAAAAAAAAAAAAAAAA&x=1@hostsecretTail',
        '[redacted]',
        'secretTail',
      ],
      [
        'password=-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----TAIL https://u:p@h',
        '[redacted] https://[redacted]@h',
        'TAIL',
      ],
    ]);
  });

  it('keeps a scheme label and its space when its token is also a standalone credential', () => {
    projects('SECRETS_B6_CORE_MERGE', [
      ['Bearer sk-abcdefghijklmnopqrstuvwx', 'Bearer [redacted]', 'abcdefghij'],
      [
        'Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwx',
        '[redacted] [redacted]',
        'abcdefghij',
      ],
      ['token sk-abcdefghijklmnopqrstuvwx', 'token [redacted]', 'abcdefghij'],
    ]);
  });

  it('reports whether a journal projection settled', () => {
    const journal = (value: unknown) => expect(value, 'SECRETS_B7_CORE_JOURNAL_SETTLED');
    const ids = 'AKIAAAAAAAAAAAAAAAAAASIABBBBBBBBBBBBBBBB';
    journal(
      projectSecretShapedValue({ path: 'test/fixtures/keys.txt', content: `${ids}\nscan(x)\n` }),
    ).toEqual({
      value: { path: 'test/fixtures/keys.txt', content: '[redacted][redacted]\nscan(x)\n' },
      settled: true,
    });
    // Four glued ids need four passes, and a key whose short value names the next key one per key.
    for (const content of [`${ids}${ids}\nscan(x)\n`, 'token:token =token ://?-=Q']) {
      journal(projectSecretShapedValue({ path: 'p', content })).toEqual({
        value: { path: 'p', content: '[redacted]' },
        settled: false,
      });
    }
    vi.mocked(fixedPointOf).mockImplementationOnce(() => undefined);
    journal(projectSecretShapedValue('drifting text')).toEqual({
      value: '[redacted]',
      settled: false,
    });
  });
});

describe('PR95 review round 8: structured summaries, escaped and unclosed quotes, continuation labels', () => {
  const projects = (marker: string, pairs: readonly (readonly [string, string, string])[]) => {
    for (const [input, expected, secret] of pairs) {
      const output = redactSecretShapedText(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(secret), marker).toBe(false);
      expect(redactSecretShapedText(output), marker).toBe(output);
    }
  };

  it('summarizes a structured result from its JSON once credential members are masked', async () => {
    for (const [result, secrets] of [
      [
        { content: 'DB_PASSWORD="hunter2hunter2"\nNODE_ENV=production\n', mimeType: 'text/plain' },
        ['hunter2hunter2'],
      ],
      [
        {
          content:
            '{\n  "database": {"password": "Qz9correcthorse"}, "client_secret": "Qz5clientsecretval"}',
        },
        ['Qz9correcthorse', 'Qz5clientsecretval'],
      ],
      [
        {
          status: 200,
          headers: {},
          body: '{"access_token":"2YotnFZFEjr1zCsicMWpAA","refresh_token":"tGzv3JOkF0XG5Qx2TlKWIA"}',
        },
        ['2YotnFZFEjr1zCsicMWpAA', 'tGzv3JOkF0XG5Qx2TlKWIA'],
      ],
      [
        {
          exitCode: 0,
          stdout: 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"\n',
          stderr: '',
        },
        ['wJalrXUtnFEMIK7MDENG'],
      ],
      // The walk also masks what no text rule reads: a secret-named key's whole value and the
      // element after a credential flag.
      [{ token: { value: 'Qz7nestedSecret' } }, ['Qz7nestedSecret']],
      [{ argv: ['--password', 'Qz7flagSecret'] }, ['Qz7flagSecret']],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.value, 'SECRETS_B8_CORE_SUMMARY_WALK').toBe(result);
      for (const secret of secrets) {
        expect(bounded.summary.includes(secret), 'SECRETS_B8_CORE_SUMMARY_WALK').toBe(false);
      }
    }
    const summary = await boundForModel(
      { content: 'DB_PASSWORD="hunter2hunter2"\nNODE_ENV=production\n' },
      BIG,
      {},
    );
    expect(summary.summary, 'SECRETS_B8_CORE_SUMMARY_WALK').toBe(
      '{"content":"[redacted]\\nNODE_ENV=production\\n"}',
    );
  });

  it('reads a quoted value one JSON string down', () => {
    projects('SECRETS_B8_CORE_ESCAPED_QUOTE', [
      [
        '{"body":"{\\"password\\":\\"hunter2hunter2\\",\\"user\\":\\"bob\\"}"}',
        '{"body":"{\\"[redacted],\\"user\\":\\"bob\\"}"}',
        'hunter2hunter2',
      ],
      [
        '{"stdout":"export TOKEN=\\"Qz7abc12345\\" && run"}',
        '{"stdout":"export [redacted] && run"}',
        'Qz7abc12345',
      ],
      [
        '{"h":"{\\"x-api-key\\":\\"Bearer Qz7abcdefghijkl\\"}"}',
        '{"h":"{\\"[redacted]}"}',
        'Qz7abcdefghijkl',
      ],
      // An escaped tab or line break may stand between the separator and the escaped quote.
      ['{"cfg":"password:\\t\\"hunter2Secr3t\\""}', '{"cfg":"[redacted]"}', 'hunter2Secr3t'],
      ['{"cfg":"password:\\n  \\"hunter2Secr3t\\""}', '{"cfg":"[redacted]"}', 'hunter2Secr3t'],
      // A raw tab may stand among them, an escaped CR LF is one line break, and an escaped apostrophe
      // opens such a value too; so does a raw one, which JSON leaves unescaped.
      ['{"cfg":"password:\\n\t\\"hunter2Secr3t\\""}', '{"cfg":"[redacted]"}', 'hunter2Secr3t'],
      ['{"cfg":"password:\\r\\n\\"hunter2Secr3t\\""}', '{"cfg":"[redacted]"}', 'hunter2Secr3t'],
      ['{"cfg":"password:\\n  \\\'hunter2Secr3t\\\'"}', '{"cfg":"[redacted]"}', 'hunter2Secr3t'],
      ['{"yaml":"password:\\t\'Adm1nPassw0rd\'"}', '{"yaml":"[redacted]"}', 'Adm1nPassw0rd'],
      ['{"yaml":"password:\\n  \'Adm1nPassw0rd\'"}', '{"yaml":"[redacted]"}', 'Adm1nPassw0rd'],
      // An opaque value runs to its delimiter, the backslash before a quote included.
      [
        '{"m":"{\\"u\\":\\"https://h.example/cb?sig=AbCdEfGhIjKlMnOpQrStUvW\\"}"}',
        '{"m":"{\\"u\\":\\"https://h.example/cb?sig=[redacted]"}"}',
        'AbCdEfGhIjKlMnOpQrStUvW',
      ],
      // A quote escaped one level further down stays inside the value.
      [
        '{"cmd":"export TOKEN=\\"Qz\\\\\\"SecretTail\\" end"}',
        '{"cmd":"export [redacted] end"}',
        'SecretTail',
      ],
      // An escaped backslash escapes only the character right after it.
      [
        '{"cmd":"export TOKEN=\\"Qz7abcdef\\\\x\\" public"}',
        '{"cmd":"export [redacted] public"}',
        'Qz7abcdef',
      ],
    ]);
  });

  it('reads a quoted value that does not close on its line as an unquoted run', () => {
    const runs = [
      ['{"password":"hunter2hunter2', '{"[redacted]', 'hunter2hunter2'],
      ['password: "hunter2hunter2\nnext line', '[redacted]\nnext line', 'hunter2hunter2'],
      ["DB_PASSWORD='hunter2hunter2\nNEXT=1", '[redacted]\nNEXT=1', 'hunter2hunter2'],
      ['api_key="Qz7abcdefghij\\', '[redacted]', 'Qz7abcdefghij'],
      // The run ends at the delimiters of an unquoted value and at its line's end, which a CR, a
      // backslash before one or a lone backslash also is.
      ['password="Qz7abcdef public tail', '[redacted] public tail', 'Qz7abcdef'],
      ['password="Qz7abcdef,next', '[redacted],next', 'Qz7abcdef'],
      ['password="Qz7abcdef;next', '[redacted];next', 'Qz7abcdef'],
      ['password="Qz7abcdef&x=1', '[redacted]&x=1', 'Qz7abcdef'],
      ['password="Qz7abcdef\'x', "[redacted]'x", 'Qz7abcdef'],
      ['password="Qz7abcdef\tpublic', '[redacted]\tpublic', 'Qz7abcdef'],
      ['password="Qz7abc\ndef\nghi tail', '[redacted]\ndef\nghi tail', 'Qz7abc'],
      ['password="Qz7abc\ndef\\', '[redacted]\ndef\\', 'Qz7abc'],
      ['password="Qz7abc\rdef tail', '[redacted]\rdef tail', 'Qz7abc'],
      ['password="Qz7abc\\\rdef tail', '[redacted]\rdef tail', 'Qz7abc'],
      ['password="Qz7abcdef\\\nmore" tail', '[redacted]\nmore" tail', 'Qz7abcdef'],
      ['password="Qz7abcdef\\\rmore" tail', '[redacted]\rmore" tail', 'Qz7abcdef'],
      // A value that closes on a later line is read the same way, and a run of such values settles in
      // one pass.
      ['password="Qz7abcdef\nmore" tail', '[redacted]\nmore" tail', 'Qz7abcdef'],
      [
        'A_TOKEN="Qz7aaa1\nB_TOKEN=\'Qz7bbb2\nC_TOKEN="Qz7ccc3\nD_TOKEN="Qz7ddd4"',
        '[redacted]\n[redacted]\n[redacted]\n[redacted]',
        'Qz7bbb2',
      ],
      // One JSON level down only an escaped quote closes the value; the raw quote or raw line break
      // that ends the string around it, like an escaped line break, ends its run.
      [
        '{"a":"password=\\"Qz7abcdefgh","b":"public"}',
        '{"a":"[redacted]","b":"public"}',
        'Qz7abcdefgh',
      ],
      ['{"a":"password=\\"Qz7abcdef ghi","b":"x"}', '{"a":"[redacted] ghi","b":"x"}', 'Qz7abcdef'],
      [
        '{"a":"password=\\"Qz7abcdefgh\\nline two","b":"public"}',
        '{"a":"[redacted]\\nline two","b":"public"}',
        'Qz7abcdefgh',
      ],
      [
        '{"a":"password=\\"Qz7abcdefgh\\rline two","b":"public"}',
        '{"a":"[redacted]\\rline two","b":"public"}',
        'Qz7abcdefgh',
      ],
      [
        '{"a":"password=\\"Qz7abc\\nQz7def\\" tail"}',
        '{"a":"[redacted]\\nQz7def\\" tail"}',
        'Qz7abc',
      ],
      [
        '{"a":"password=\\"Qz7abcdefgh\n{"b":"say \\"hi\\""}',
        '{"a":"[redacted]\n{"b":"say \\"hi\\""}',
        'Qz7abcdefgh',
      ],
      [
        'echo password=\\"Qz7abc\\\nline two \\\nline three\nend',
        'echo [redacted]\nline two \\\nline three\nend',
        'Qz7abc',
      ],
      [
        '{"a":"A_TOKEN=\\"Qz7aaa1\\n B_TOKEN=\\"Qz7bbb2\\n C_TOKEN=\\"Qz7ccc3\\n D_TOKEN=\\"Qz7ddd4\\""}',
        '{"a":"[redacted]\\n [redacted]\\n [redacted]\\n [redacted]"}',
        'Qz7aaa1',
      ],
      // A raw quote of the other kind does not end it: an apostrophe is text in a JSON string.
      [
        '{"a":"token=\\\'Qz7secret","b":"public one"}',
        '{"a":"[redacted]","b":"public one"}',
        'Qz7secret',
      ],
      // A value whose line break another mask of the pass takes (a scheme label's token, a nested
      // key's value) closes as the next pass reads it, and is masked whole.
      ['DB_PASSWORD="Bearer\nabcdefghij Zq7Wk3Xp9Rm2" tail', '[redacted] tail', 'Zq7Wk3Xp9Rm2'],
      [
        'Authorization: "Bearer\r\nabcdefghij Zq7Wk3Xp9Rm2" tail',
        '[redacted] tail',
        'Zq7Wk3Xp9Rm2',
      ],
      ['password="abcdef Bearer\nabcdefghij Zq7Wk3Xp9Rm2" tail', '[redacted] tail', 'Zq7Wk3Xp9Rm2'],
      ['token:"Kx96Wv Qze6S0YzVYHq Bearer\nQVI3ml-K"', '[redacted]', 'Qze6S0YzVYHq'],
      [
        'client_secret="token:\nabcdefghijkl Zq7Wk3Xp9Rm2Vn5Ty8Lb" end',
        '[redacted] end',
        'Zq7Wk3Xp9Rm2Vn5Ty8Lb',
      ],
      // A quote that closes another value is that value's: no value it opens is read through the
      // other masks.
      ["token='abc password='xyz] public", '[redacted]xyz] public', 'abc'],
      // So does one whose escaped closing quote an opaque value's mask unescapes, behind an odd or
      // an even run of backslashes.
      [
        'password="say \\"Zq7Wk3Xp9Rm2Vn5Ty8Lb?sig=AAAAAAAAAAAAAAAAAAAAAAAA\\"',
        '[redacted]',
        'Zq7Wk3Xp9Rm2Vn5Ty8Lb',
      ],
      [
        'password="my Zq9SECRETvalue7Xk?sig=AbCdEfGhIjKlMnOpQrStUvWx\\\\" next',
        '[redacted] next',
        'Zq9SECRETvalue7Xk',
      ],
    ] as const;
    projects('SECRETS_B8_CORE_UNCLOSED_QUOTE', runs);
    for (const [input, expected] of runs) {
      expect(projectSecretShapedValue({ a: input }), 'SECRETS_B8_CORE_UNCLOSED_QUOTE').toEqual({
        value: { a: expected },
        settled: true,
      });
    }
    // Its quote may instead close a string the key sits in, so the text after the run stays, and calls
    // that differ only there keep distinct projections. A run under six characters is no value.
    const script = 'read -p "Enter password: " PW\necho "connecting to $HOST"\n';
    for (const kept of [
      script,
      '{\n  "label": "Password:",\n  "hint": "at least 8 chars"\n}',
      'print("token: " + t)\nprint("done")',
      'fix(auth): stop logging "token=" query values in the billing service',
      "grep -rn 'api_key=' config/prod.yaml",
      `psql "password="$PW -c 'DROP TABLE orders_a'`,
      '{"msg":"stop logging \\"token=\\" values in billing"}',
      'A_TOKEN="Qz7a1\nx=\\\\"y',
    ]) {
      expect(redactSecretShapedText(kept), 'SECRETS_B8_CORE_UNCLOSED_QUOTE').toBe(kept);
    }
    for (const [one, other] of [
      [script, script.replace('PW\n', 'PW; rm -rf ./build\n')],
      [
        'fix(auth): stop logging "token=" query values in the billing service',
        'fix(auth): stop logging "token=" query values in the payments service',
      ],
      [
        `psql "password="$PW -c 'DROP TABLE orders_a'`,
        `psql "password="$PW -c 'DROP TABLE orders_b'`,
      ],
      [
        '{"msg":"stop logging \\"token=\\" values in billing"}',
        '{"msg":"stop logging \\"token=\\" values in payments"}',
      ],
      [
        '{"cmd":"export TOKEN=\\"Qz7abcdef; echo done"}',
        '{"cmd":"export TOKEN=\\"Qz7abcdef; rm -rf x"}',
      ],
    ]) {
      expect(
        projectSecretShapedValue({ content: one }).value,
        'SECRETS_B8_CORE_UNCLOSED_QUOTE',
      ).not.toEqual(projectSecretShapedValue({ content: other }).value);
    }
  });

  it('reads a label at a line start inside a split continuation', () => {
    projects('SECRETS_B8_CORE_CONTINUATION_LABEL', [
      [
        'sk-proj-AbCdEfGhIjKlMnOpQrSt\nauthori\tzation: Qz7SecretValue99',
        '[redacted]',
        'Qz7SecretValue99',
      ],
      ['glpat-AbCdEfGhIjKlMnOpQrSt\napi-k\tey: Qz7SecretValue99', '[redacted]', 'Qz7SecretValue99'],
    ]);
  });

  it('masks two and three private-key blocks in one text', () => {
    const block = (kind: string, body: string) =>
      `-----BEGIN ${kind} PRIVATE KEY-----\n${body}\n-----END ${kind} PRIVATE KEY-----`;
    projects('SECRETS_B8_CORE_PEM_BLOCKS', [
      [
        `a ${block('RSA', 'AAA')}\nb ${block('EC', 'BBBSECRET')} c`,
        'a [redacted]\nb [redacted] c',
        'BBBSECRET',
      ],
      [
        `${block('RSA', 'X1SECRET')} ${block('EC', 'X2SECRET')} ${block('OPENSSH', 'X3SECRET')}`,
        '[redacted] [redacted] [redacted]',
        'X3SECRET',
      ],
    ]);
  });

  it("keeps a label's own whitespace before a split credential", () => {
    expect(
      redactSecretShapedText('Bearer  sk-\nabcdefghijklmnopqrstuvwx done'),
      'SECRETS_B8_CORE_FILL',
    ).toBe('Bearer  [redacted] done');
  });
  it('summarizes a value that closes on a later line whole', async () => {
    for (const [result, summary, secret] of [
      [
        'token=\'abc password="first-half\nSECOND-HALF-SECRET" done',
        '[redacted] done',
        'SECOND-HALF',
      ],
      ['password="password="password="\nQ7mZ4pW9xK"', '[redacted]', 'Q7mZ4pW9xK'],
      ['secret: \'line1\nline2 token="it\'s"', '[redacted]', 'line2'],
      [{ content: 'password="hunter2 value\nmore text"' }, '{"content":"[redacted]"}', 'hunter2'],
      [
        { stdout: 'password="first-half\r\nSECOND-HALF" done' },
        '{"stdout":"[redacted] done"}',
        'SECOND-HALF',
      ],
      [['password="hunter2 value\nmore text"'], '["[redacted]"]', 'more text'],
      // A masked value after it can take the quote that would close it.
      ["token='\ntoken=''Qz7secret'", '[redacted]', 'Qz7secret'],
      ['password="\npassword=""Qz7secret"', '[redacted]', 'Qz7secret'],
      // When masked values take every later quote, the summary masks through the last of them.
      ["token='\ntoken=''Qz7secret token='", '[redacted]', 'Qz7secret'],
      // A structured result is read in its JSON, where the value one JSON string down runs on over the
      // escaped line break to the end of the text.
      [
        { stdout: 'token=\'abc password="first-half\nSECOND-HALF-SECRET" done' },
        '{"stdout":"[redacted]',
        'SECOND-HALF',
      ],
      ['{"log":"password=\\"Qz7secret\\nmore\\" ok"}', '{"log":"[redacted] ok"}', 'Qz7secret'],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.summary, 'SECRETS_B8_CORE_SUMMARY_CLOSER').toBe(summary);
      expect(bounded.summary.includes(secret), 'SECRETS_B8_CORE_SUMMARY_CLOSER').toBe(false);
    }
    // A value that reaches the end of the text unclosed is masked to that end. The nearest quote that
    // closes the value ends its mask, so public text after it stays; a raw line break behind a backslash
    // ends a value one JSON string down, and a quote behind three backslashes closes no value, one
    // JSON string down too, where one behind five closes it. Each value is decided after its own line:
    // a quote there that a nested value's mask leaves unescaped closes nothing.
    for (const [result, summary] of [
      ['token="Qz7abcdef ghi jkl', '[redacted]'],
      ['password="Qz7abc\ndefSECRET\\\\" tail', '[redacted] tail'],
      ['password="Qz7abc\ndefSECRET\\\\\\\\" tail', '[redacted] tail'],
      ['token="Qz7first\ntoken="Qz7second\nend', '[redacted] end'],
      ['{"cmd":"export TOKEN=\\"Qz7abcdef; echo done"}', '{"cmd":"export [redacted]"}'],
      ['token:"token=\\\'token=h\\\\\\r\\"\n"', '[redacted]'],
      ['password=\\"Qz7abcdefgh\\nx \\\\\\" y', '[redacted]\\nx \\\\\\" y'],
      ['password=\\"Qz7abcdefgh\\nx \\\\\\\\\\" y', '[redacted] y'],
      ['password="Qz7abc\ndef" public "kept"', '[redacted] public "kept"'],
      ['echo password=\\"Qz7abc\\\nline two \\" end', 'echo [redacted] line two \\" end'],
      ['password="Qz7abcdefgh\nmore \\\\\\" text', '[redacted] more \\\\\\" text'],
    ] as const) {
      expect((await boundForModel(result, BIG, {})).summary, 'SECRETS_B8_CORE_SUMMARY_CLOSER').toBe(
        summary,
      );
    }
    // The journal projection reads such a value only to its first line's end: its quote may close a
    // string around it.
    expect(
      redactSecretShapedText('password="first-half\nSECOND-HALF" done'),
      'SECRETS_B8_CORE_SUMMARY_CLOSER',
    ).toBe('[redacted]\nSECOND-HALF" done');
  });

  it("reads a structured result's values across its line breaks and members", async () => {
    // The text rules read the JSON as one text: a JSON-escaped line break is no delimiter, and a PEM
    // block or a quoted value that runs on into later members keeps its key and markers.
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAuY5wq3Zx9bQk1s8hR2pV7tX0aLmN4cQe',
      'Kq1sW9eR4tY7uI0oP2aS5dF8gH1jK3lZ',
      '-----END RSA PRIVATE KEY-----',
    ];
    const signed =
      'curl -sS https://bucket.s3.example/obj?X-Amz-Signature=0123456789abcdef0123456789abcdef';
    for (const [result, summary, secret] of [
      [
        {
          lines: [
            'APP_NAME=demo',
            `PRIVATE_KEY="${pem[0]}`,
            pem[1],
            pem[2],
            `${pem[3]}"`,
            'PORT=8080',
          ],
        },
        '{"lines":["APP_NAME=demo","[redacted]","PORT=8080"]}',
        'MIIEowIBAAKCAQEA',
      ],
      [
        { lines: [`password=${pem[0]}`, pem[1], pem[3]] },
        '{"lines":["[redacted]"]}',
        'MIIEowIBAAKCAQEA',
      ],
      [
        { lines: ["export DB_PASSWORD='first", "hunter2secretpw'", 'echo ok'] },
        '{"lines":["export [redacted]","echo ok"]}',
        'hunter2secretpw',
      ],
      [{ stdout: "?token='\nhunter2secretpw\\'" }, '{"stdout":"?[redacted]"}', 'hunter2secretpw'],
      ...['\n', '\r\n', '\r', '\t'].map(
        (separator) =>
          [
            { stdout: `DB_PASSWORD=hunter2hunter2${separator}Q9zXw7TokenValue` },
            '{"stdout":"[redacted]"}',
            'Q9zXw7',
          ] as const,
      ),
      ...['\n', '\r\n', '\t'].map(
        (separator) =>
          [
            { stdout: `${signed}${separator}0123456789abcdefSECRETCONTINUATION -o out` },
            '{"stdout":"curl -sS https://bucket.s3.example/obj?X-Amz-Signature=[redacted] -o out"}',
            'SECRETCONTINUATION',
          ] as const,
      ),
      [
        {
          content: [
            {
              type: 'text',
              text: 'private_key=MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nSECONDLINEu8XJk2Wq4tRmYv0yZp3\nTHIRDLINEaBcDeFgHiJk',
            },
          ],
        },
        '{"content":[{"type":"text","text":"[redacted]"}]}',
        'SECONDLINE',
      ],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.summary, 'SECRETS_B8_CORE_SUMMARY_JSON').toBe(summary);
      expect(bounded.summary.includes(secret), 'SECRETS_B8_CORE_SUMMARY_JSON').toBe(false);
    }
  });

  it('shows a summary that does not settle as its own mask', async () => {
    // Four glued ids need four passes, so neither summary pass settles.
    const run = 'AKIAAAAAAAAAAAAAAAAAASIABBBBBBBBBBBBBBBB'.repeat(2);
    for (const [result, summary] of [
      [run, '[redacted]'],
      [{ stdout: run }, '[redacted]'],
    ] as const) {
      expect(
        (await boundForModel(result, BIG, {})).summary,
        'SECRETS_B8_CORE_SUMMARY_UNSETTLED',
      ).toBe(summary);
    }
  });

  it(
    'summarizes a many-part result within the case deadline',
    async () => {
      // An MCP result near the 4 MiB http/sse message bound: every member is walked once, and its JSON
      // is read as one text.
      const parts = [{ type: 'text', text: 'token=Qz7manyPartSecret' }];
      for (let index = 0; index < 150_000; index += 1) {
        parts.push({ type: 'text', text: `part ${index}` });
      }
      const { summary } = await boundForModel({ content: parts }, BIG, {});
      expect(summary.includes('Qz7manyPartSecret'), 'SECRETS_B8_CORE_SUMMARY_PARTS').toBe(false);
      expect(
        summary.startsWith('{"content":[{"type":"text","text":"[redacted]"},'),
        'SECRETS_B8_CORE_SUMMARY_PARTS',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('reports a journal projection whose member names collide as unsettled', () => {
    const colliding = {
      'sk-AAAAAAAAAAAAAAAAAAAA': 'rm -rf build',
      'sk-BBBBBBBBBBBBBBBBBBBB': 'echo done',
    };
    expect(projectSecretShapedValue(colliding), 'SECRETS_B8_CORE_KEY_COLLISION').toEqual({
      value: { '[redacted]': 'echo done' },
      settled: false,
    });
    expect(
      projectSecretShapedValue({
        nested: { 'https://u:pw1@h/x': 'one', 'https://u:pw2@h/x': 'two' },
      }).settled,
      'SECRETS_B8_CORE_KEY_COLLISION',
    ).toBe(false);
    // The report reaches objects inside arrays too.
    for (const value of [{ list: [colliding] }, { argv: ['run', colliding] }]) {
      expect(projectSecretShapedValue(value).settled, 'SECRETS_B8_CORE_KEY_COLLISION').toBe(false);
    }
    // Names that stay distinct settle, and the display projection still shows one member.
    expect(
      projectSecretShapedValue({ 'password=a': 1, 'password=b': 2 }).settled,
      'SECRETS_B8_CORE_KEY_COLLISION',
    ).toBe(true);
    expect(redactSecretShapedValue(colliding), 'SECRETS_B8_CORE_KEY_COLLISION').toEqual({
      '[redacted]': 'echo done',
    });
  });
});

describe('PR95 review round 8, sixth pre-review: escapes under nested masks, PEM markers, escaped separators', () => {
  it('closes a quoted value at the later of its readings with and without the masks', async () => {
    // A mask can take the backslash that escapes a later quote. A quoted value closes at the later of two
    // readings: with the masks before and inside it filled, as the next pass reads them, and with each
    // mask keeping the backslashes it ends with, as the text has them. A nested key's value that takes
    // the backslash before a later quote therefore does not close the value early, in the journal
    // projection, whose line break a scheme token takes, and in the summary alike; after an even run of
    // backslashes the quote is unescaped in both readings and closes the value.
    const a26 = 'a'.repeat(26);
    for (const [input, expected] of [
      ['password="Bearer\nabcdefgh token=xyzxyz\\"secretpart" more', '[redacted] more'],
      [
        'password="a Bearer\nabcdefgh9 DB_PASSWORD=x9y8z7\\"Sup3rS3cretTail" next',
        '[redacted] next',
      ],
      ['password="Bearer\nabcdefgh token=xyzxyz\\\\"tail more" end', '[redacted]tail more" end'],
      ['password="Bearer\nabcdefgh token=xyzxyz\\\\\\"secret tail" end', '[redacted] end'],
      // A value that closes only where a nested key's mask unescapes its last quote is masked whole.
      ['"token":"Qz7abcdefghijkl,Qz7mnopqrstuv&\\ttoken:password:\\t\\"', '"[redacted]'],
      // An opaque value's mask runs to the escaped quote and takes its backslash; a quote it unescapes
      // closes the value only when no later quote does, behind a URL userinfo in it or not.
      [`password="?sig=${a26}https://u:p@h\\"Qz7SecretTail" public`, '[redacted] public'],
      [
        `password="token\nabcdefgh9 ?sig=${a26}https://u:p@h\\"Qz7SecretTail" public`,
        '[redacted] public',
      ],
      [`password="x ?sig=${a26}\\"Qz7SecretTail" public`, '[redacted] public'],
      // The earlier rules' masks stay filled in both readings: a quote inside a private-key block
      // closes nothing.
      [
        'password="Bearer\nabcdefgh -----BEGIN RSA PRIVATE KEY----- x"y -----END RSA PRIVATE KEY----- tail" more',
        '[redacted] more',
      ],
    ] as const) {
      expect(redactSecretShapedText(input), 'SECRETS_B8_CORE_CLOSER_ESCAPE').toBe(expected);
      expect(projectSecretShapedValue({ a: input }), 'SECRETS_B8_CORE_CLOSER_ESCAPE').toEqual({
        value: { a: expected },
        settled: true,
      });
    }
    // A summary masks a value that stops at a line break through the later of the two readings' closers.
    for (const [input, expected] of [
      ['export PASSWORD="line1\nDB_TOKEN=abcdef\\"Secr3tTail" done', 'export [redacted] done'],
      [
        'export PASSWORD="line1\nDB_TOKEN=abcdef\\"Secr3tTail" done "kept"',
        'export [redacted] done "kept"',
      ],
      ['password="Qz7abc\nDB_TOKEN=abcdef\\"', '[redacted]'],
      ['password="Qz7abc\nDB_TOKEN=abcdef\\"SECRETtail" done', '[redacted] done'],
      ['password="Qz7abc\nDB_TOKEN=abcdef\\\\"tail" done', '[redacted]tail" done'],
      ['password="Qz7abc\nDB_TOKEN=abcdef\\\\\\"SECRET tail" done', '[redacted] done'],
      [`password="Qz7abc\nx ?sig=${a26}\\"Qz7SecretTail" public`, '[redacted] public'],
      [`password="Qz7abc\nx ?sig=${a26}\\"`, '[redacted]'],
      // The second reading falls back to the last quote that could close the value, like the first.
      ['password="Qz7\ntoken="abcdef" token=zzzzzz\\" token="ghijkl" tail', '[redacted] tail'],
      // Each value is decided at its own end, whatever order the values were found in.
      ['passwd="\ntoken:"\n" tail', '[redacted] tail'],
      ['passwd="token=\\\'\\rtoken=ef\\\\n\\"\ntoken=bcdef\\"', '[redacted]'],
    ] as const) {
      expect((await boundForModel(input, BIG, {})).summary, 'SECRETS_B8_CORE_CLOSER_ESCAPE').toBe(
        expected,
      );
    }
  });

  it("reads a structured summary's members before the walk masks them whole", async () => {
    const begin = '-----BEGIN RSA PRIVATE KEY-----';
    const end = '-----END RSA PRIVATE KEY-----';
    // The text rules read the result's JSON once before the walk's whole masks, which that same pass
    // applies, so a private-key block that runs into or out of a credential member or flag argument is
    // masked across members, whatever the masked value holds.
    for (const [result, summary, secret] of [
      [
        { private_key: `${begin}\nMIIEAAAAfirst`, rest: `MIIEBBBBsecondbodyline\n${end}` },
        '{"[redacted]}',
        'MIIEBBBB',
      ],
      [
        { a: `${begin}\nMIIEpAIBAAKCAQEAbodylineone`, private_key: `bodylinetwo\n${end}` },
        '{"a":"[redacted]}',
        'bodylineone',
      ],
      [
        ['--private-key', begin, 'MIIEpAIBAAKCAQEAsecretbodyline1', 'abcdefsecretbodyline2', end],
        '["--private-key","[redacted]""]',
        'secretbodyline',
      ],
      [
        [`--private-key=${begin}`, 'MIIEpAIBAAKCAQEAsecretbodyline1', end],
        '["--[redacted]"]',
        'MIIE',
      ],
      [
        {
          a: `${begin}\nAAAbody1`,
          private_key: `body1tail\n${end}\n-----BEGIN EC PRIVATE KEY-----\nbody2head`,
          c: 'BBBbody2\n-----END EC PRIVATE KEY-----',
          d: 'public',
        },
        '{"a":"[redacted]","d":"public"}',
        'BBBbody2',
      ],
      [
        {
          a: `${begin}\nAAAfirstbody`,
          private_key: `bbb\n${end}\n${begin}\nccc\n${end}`,
          z: 'public',
        },
        '{"a":"[redacted],"z":"public"}',
        'AAAfirstbody',
      ],
      [
        { private_key: `${begin}\nAAA\n${end}\n${begin}\nBBBhead`, rest: `CCCbody\n${end}` },
        '{"[redacted]}',
        'CCCbody',
      ],
      [
        { items: [{ private_key: `${begin}\nMIIEnested`, rest: `NESTEDbody\n${end}` }] },
        '{"items":[{"[redacted]}]}',
        'NESTEDbody',
      ],
      // A credential member that holds a whole block of its own, an object, or a scheme label.
      [
        {
          stdout: `${begin}\nMIIEpAIBAAKCAQEAQZXSECRETBODYLINE1abc\n[output truncated]`,
          private_key: `${begin}\nMIIBOwIBAAJBAKj34\n${end}`,
        },
        '{"stdout":"[redacted]}',
        'QZXSECRETBODYLINE1',
      ],
      [
        {
          credentials: { type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----' },
          body: 'MIIEvQQZXSECRET\n-----END PRIVATE KEY-----\n',
        },
        '{"credentials":"[redacted]"}',
        'QZXSECRET',
      ],
      [
        { token: `Bearer x ${begin}`, rest: `MIIEvQQZXSECRET\n${end}` },
        '{"[redacted]}',
        'QZXSECRET',
      ],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.summary, 'SECRETS_B8_CORE_SUMMARY_PEM').toBe(summary);
      expect(bounded.summary.includes(secret), 'SECRETS_B8_CORE_SUMMARY_PEM').toBe(false);
    }
    expect(
      (
        await boundForModel(
          { private_key: `${begin}\nMIIEwhole\n${end}`, b: `see ${end} there` },
          BIG,
          {},
        )
      ).summary,
      'SECRETS_B8_CORE_SUMMARY_PEM',
    ).toBe(`{"[redacted],"b":"see ${end} there"}`);
    // The journal and the display projections keep their whole mask.
    expect(
      projectSecretShapedValue({ private_key: `${begin}\nMIIEAAAA`, rest: 'x' }).value,
      'SECRETS_B8_CORE_SUMMARY_PEM',
    ).toEqual({ private_key: '[redacted]', rest: 'x' });
    expect(
      redactSecretShapedValue(['--private-key', begin]),
      'SECRETS_B8_CORE_SUMMARY_PEM',
    ).toEqual(['--private-key', '[redacted]']);
  });

  it("reads a structured summary's JSON-escaped line breaks and tabs", async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    // JSON writes a line break or a tab in a member as two characters, which the summary reads as that
    // separator for a credential or a scheme label after it and for a credential split by it.
    for (const [result, summary, secret] of [
      [
        { stdout: 'keys:\nsk-proj-abcdefghijklmnopqrstuvwxyz', stderr: '', exitCode: 0 },
        '{"stdout":"keys:\\n[redacted]","stderr":"","exitCode":0}',
        'sk-proj-abc',
      ],
      [
        { stdout: 'ACCESSKEY\tAKIAIOSFODNN7EXAMPLE\tActive\n' },
        '{"stdout":"ACCESSKEY\\t[redacted]\\tActive\\n"}',
        'AKIAIOSFODNN7',
      ],
      [
        { stdout: 'one sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa\r\nsk-proj-bbbbbbbbbbbbbbbbbbbbbbbb' },
        '{"stdout":"one [redacted]\\r\\n[redacted]"}',
        'bbbbbbbb',
      ],
      [{ stdout: 'AKIAABCDEFGH\nIJKLMNOP' }, '{"stdout":"[redacted]"}', 'IJKLMNOP'],
      [
        { stdout: 'progress 50%\rsk-proj-abcdefghijklmnopqrstuvwxyz' },
        '{"stdout":"progress 50%\\r[redacted]"}',
        'sk-proj-abc',
      ],
      [
        { stdout: 'Bearer\nabcdefghijklmnop' },
        '{"stdout":"Bearer [redacted]"}',
        'abcdefghijklmnop',
      ],
      [
        { content: [{ type: 'text', text: `Token issued:\n${jwt}` }] },
        '{"content":[{"type":"text","text":"Token issued:\\n[redacted]"}]}',
        'eyJhbGciOiJIUzI1NiJ9',
      ],
      // The backslash before the letter may end a longer run: a backslash before a line break, or a JSON
      // text inside a member.
      [
        { stdout: 'x\\\nsk-proj-abcdefghijklmnopqrstuvwxyz' },
        '{"stdout":"x\\\\\\n[redacted]"}',
        'sk-proj-abc',
      ],
      [
        { stdout: '{"msg":"line1\\nsk-proj-abcdefghijklmnopqrstuvwxyz"}' },
        '{"stdout":"{\\"msg\\":\\"line1\\\\n[redacted]\\"}"}',
        'sk-proj-abc',
      ],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.summary, 'SECRETS_B8_CORE_SUMMARY_ESCAPES').toBe(summary);
      expect(bounded.summary.includes(secret), 'SECRETS_B8_CORE_SUMMARY_ESCAPES').toBe(false);
    }
    // A path's backslashes before a letter add no mask without a credential after them.
    expect(
      (await boundForModel({ stdout: 'C:\\new\\token path\\nothing here' }, BIG, {})).summary,
      'SECRETS_B8_CORE_SUMMARY_ESCAPES',
    ).toBe('{"stdout":"C:\\\\new\\\\token path\\\\nothing here"}');
    // The journal projection, which is compared rather than shown, reads no escape.
    expect(
      (await boundForModel({ msg: 'Use\nToken handling' }, BIG, {})).summary,
      'SECRETS_B8_CORE_SUMMARY_ESCAPES',
    ).toBe('{"msg":"Use\\nToken [redacted]"}');
    expect(
      redactSecretShapedText('{"msg":"Use\\nToken handling"}'),
      'SECRETS_B8_CORE_SUMMARY_ESCAPES',
    ).toBe('{"msg":"Use\\nToken handling"}');
  });
});

describe('PR95 review round 9: closing views, unwalked members, wrapped markers and linear views', () => {
  it('closes a quoted value in the views the key rule read it in before its rules merged', async () => {
    // A value whose line break a scheme label's token takes closes as the next pass reads it. It is also
    // read without the key rule's own masks, so another key's value that takes its closing quote, or ends
    // at its opening one, does not keep it open; and where it is first read, with the scheme labels'
    // tokens filled too, so a token that takes its line break lets it close at its real quote.
    for (const [input, expected] of [
      ['password="correct horse battery Bearer\nxyzxyzxy token="q" more', '[redacted] more'],
      ['token\\":"x password="Bearer\nabcdefghij Wsecret12 Wsecret34" tail', '[redacted] tail'],
      ["password:\\t'x api_key='Bearer\nabcdefghij Wsecret12 Wsecret34' tail", '[redacted] tail'],
      [
        'api_key=password="password="Bearer\nabcdefghij Wsecret12 Wsecret34" tail',
        '[redacted] tail',
      ],
      ['{"secret": "hunter2 QZXsecondsecret Bearer\npassword": "x"}', '{"[redacted]}'],
      ['token\\\':"secret="\'QZXJ7WKM2V Bearer\nabcdefgh"', '[redacted]'],
      ['accesskey\\"="token:"Token\rabcd1234\\QZXJ7WKM2V"', '[redacted]'],
      [
        'authorization="g://&a=m3z1VvzzvmzZZ@gcom/v1/a\\"\\QZXJ7WKM2V BASIC\nqv8x~V6t"',
        '[redacted]',
      ],
      // A filled scheme token only moves a closing that a reading already reaches: a value that no
      // reading closes is decided once the next key's value, which opens at its first quote, is known.
      ['Authorization: "Bearer\nAuthorization: ""Zq7Wk3Xp9Rm2"', '[redacted]'],
      ['password="Bearer\npassword=""Zq7Wk3Xp9Rm2"', '[redacted]'],
      // So does one behind an opaque value whose mask ends with a backslash, where the scheme views are read.
      [
        `x ?sig=${'a'.repeat(26)}\\" Authorization: "Bearer\nAuthorization: ""Zq7Wk3Xp9Rm2"`,
        'x ?sig=[redacted]" [redacted]',
      ],
    ] as const) {
      expect(redactSecretShapedText(input), 'SECRETS_B9_CORE_CLOSING_VIEWS').toBe(expected);
      expect(projectSecretShapedValue({ a: input }), 'SECRETS_B9_CORE_CLOSING_VIEWS').toEqual({
        value: { a: expected },
        settled: true,
      });
      expect((await boundForModel(input, BIG, {})).summary, 'SECRETS_B9_CORE_CLOSING_VIEWS').toBe(
        expected,
      );
    }
  });

  it('masks a summary value through a later closer when one of its readings stops at a line break', async () => {
    // One reading closes the value at a quote an opaque value's mask unescapes, the other stops at the
    // line break before its real closer; the summary masks through that closer.
    for (const input of [
      'password="see ?sig=https://u:p@cdn.example/abc\\" Wsecret12\nmore"',
      'password="?sig=https://u:p@cdn.example/abc\\"Wq0zkx\n"',
      "passwd='?g=ttps://u:p@h.example/\\n\\'PLANT9\n'",
    ]) {
      expect((await boundForModel(input, BIG, {})).summary, 'SECRETS_B9_CORE_SUMMARY_STOPPED').toBe(
        '[redacted]',
      );
    }
  });

  it("reads a structured summary's quoted value across a member masked whole", async () => {
    for (const [result, summary, secret] of [
      [
        { argv: ['mysql', "--password='correct", 'horse', "battery'", '-h', 'db'] },
        '{"argv":["mysql","--[redacted]","-h","db"]}',
        'battery',
      ],
      [
        { argv: ['mysql', "--password='correcthorse", "battery'", '-h', 'db'] },
        '{"argv":["mysql","--[redacted]","-h","db"]}',
        'battery',
      ],
      [
        { note: 'x', pin: "password='abc", b: "Wdef12' tail" },
        '{"note":"x","pin":"[redacted]" tail"}',
        'Wdef12',
      ],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.summary, 'SECRETS_B9_CORE_SUMMARY_MEMBERS').toBe(summary);
      expect(bounded.summary.includes(secret), 'SECRETS_B9_CORE_SUMMARY_MEMBERS').toBe(false);
    }
  });

  it('reads a private-key marker that a line break, a tab or a doubled space splits in a summary', async () => {
    for (const [input, summary] of [
      [
        'PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0QZXSECRET\n-----END PRIVATE\nKEY-----',
        '[redacted]',
      ],
      [
        'token=-----BEGIN RSA PRIVATE KEY-----\nMIIEbodyQZXSECRET\n-----END\nPRIVATE KEY-----',
        '[redacted]',
      ],
      [
        'secret=-----BEGIN\tPRIVATE KEY-----\nMIIEbodyQZXSECRET\n-----END PRIVATE KEY-----',
        '[redacted]',
      ],
      [
        'PRIVATE_KEY=-----BEGIN RSA PRIVATE  KEY-----\nMIIEbodyQZXSECRET\n-----END RSA PRIVATE KEY-----',
        '[redacted]',
      ],
      [
        '-----BEGIN PRIVATE\nKEY-----\nMIIEbodyQZXSECRET\n-----END PRIVATE KEY-----apikey:"',
        '[redacted]',
      ],
      [
        'pem: -----BEGIN RSA PRIVATE  KEY-----\nMIIEbodyQZXSECRET\n-----END RSA PRIVATE  KEY----- done',
        'pem: [redacted] done',
      ],
    ] as const) {
      expect((await boundForModel(input, BIG, {})).summary, 'SECRETS_B9_CORE_WRAPPED_MARKERS').toBe(
        summary,
      );
    }
    // The journal projection, which is compared rather than shown, reads such a marker as before.
    const wrapped =
      'pem: -----BEGIN RSA PRIVATE  KEY-----\nMIIEbody\n-----END RSA PRIVATE  KEY----- done';
    expect(redactSecretShapedText(wrapped), 'SECRETS_B9_CORE_WRAPPED_MARKERS').toBe(wrapped);
  });

  it("keeps the walk's masks in place for a result whose own text holds a placeholder", async () => {
    // The summary marks each value the walk masks whole with a private-use placeholder; a result that
    // already holds one is summarized from the walk's masks alone, and its own text stays as it is.
    const result = { password: 'Qz7secretvalue', note: 'x\uE0000\uE001y' };
    expect(
      (await boundForModel(result, BIG, {})).summary,
      'SECRETS_B9_CORE_SUMMARY_PLACEHOLDER',
    ).toBe('{"[redacted],"note":"x\uE0000\uE001y"}');
  });

  it("reads an opaque parameter in a URL username behind that username's zone", () => {
    expect(
      redactSecretShapedText(`https://ab&tok=${'A'.repeat(26)}:pw@host.example/x?q=1`),
      'SECRETS_B9_CORE_OPAQUE_NAMES',
    ).toBe('https://[redacted]@host.example/x?q=1');
  });

  // Each view of a quoted value is built once per pass, and a run of backslashes that many masks end in
  // is read once. One shape per case, so that each keeps the case deadline under coverage instrumentation.
  for (const [shape, input, summary] of [
    [
      'nested keys share a run of backslashes',
      `password="x\n${'token='.repeat(1_000_000)}${'\\'.repeat(1_000_000)} end`,
      '[redacted]',
    ],
    [
      'many values stop at a line break',
      `${'password="abcdefgh\n'.repeat(400_000)}token=abcdef\\ end`,
      '[redacted]',
    ],
    [
      'many values precede a mask that ends in a backslash',
      `${'"password": "abc", '.repeat(400_000)}\\"https://h.example/x?sig=${'a'.repeat(30)}\\" end`,
      '"[redacted], "[redacted],',
    ],
  ] as const) {
    it(
      `keeps every projection linear where ${shape}`,
      async () => {
        expect(redactSecretShapedText(input).endsWith(' end'), 'SECRETS_B9_CORE_LINEAR_VIEWS').toBe(
          true,
        );
        expect(
          projectSecretShapedValue({ content: input }).settled,
          'SECRETS_B9_CORE_LINEAR_VIEWS',
        ).toBe(true);
        expect(
          (await boundForModel(input, BIG, {})).summary.startsWith(summary),
          'SECRETS_B9_CORE_LINEAR_VIEWS',
        ).toBe(true);
      },
      ADMITTED_SIZE_CASE_TIMEOUT_MS,
    );
  }

  it(
    "keeps a structured summary linear where a value's later closer is far away",
    async () => {
      const structured = {
        stdout: `password="first\nsecond" ${'log line ok\n'.repeat(600_000)}echo "token=abcdef12"\n`,
      };
      expect(
        (await boundForModel(structured, BIG, {})).summary.startsWith(
          '{"stdout":"[redacted] log line ok',
        ),
        'SECRETS_B9_CORE_LINEAR_VIEWS',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );
});

describe('PR95 review round 10: a value whose escaped quote an earlier mask took, in a summary', () => {
  it("opens a value whose escaped quote ends an earlier mask's backslashes in a summary", async () => {
    // A structured result's JSON escapes each line break, so a query value at the end of a line runs on
    // through the next line's key and takes the backslash of its value's escaped quote; the summary opens
    // that value where the query value's mask keeps its trailing backslashes.
    const env =
      'DATABASE_URL=postgres://db.example.com/app?sslmode=require\nPOSTGRES_PASSWORD="S3cr3tValue2024"\n';
    for (const [result, summary, secret] of [
      [
        { exitCode: 0, stdout: env, stderr: '', durationMs: 12 },
        '{"exitCode":0,"stdout":"DATABASE_URL=postgres://db.example.com/app?sslmode=[redacted]\\n","stderr":"","durationMs":12}',
        'S3cr3tValue2024',
      ],
      [
        { content: [{ type: 'text', text: env }] },
        '{"content":[{"type":"text","text":"DATABASE_URL=postgres://db.example.com/app?sslmode=[redacted]\\n"}]}',
        'S3cr3tValue2024',
      ],
      [
        { stdout: env.replaceAll('\n', '\r\n') },
        '{"stdout":"DATABASE_URL=postgres://db.example.com/app?sslmode=[redacted]\\r\\n"}',
        'S3cr3tValue2024',
      ],
      [
        {
          stdout:
            'MONGO_URL=mongodb://h/db?retryWrites=true&w=majority\nMONGO_PASSWORD="M0ngoSecretPass"\n',
        },
        '{"stdout":"MONGO_URL=mongodb://h/db?retryWrites=true&w=[redacted]\\n"}',
        'M0ngoSecretPass',
      ],
      [
        { stdout: 'GET /x?ssl_cert_reqs=required\tREDIS_PASSWORD="R3disSecretPass"' },
        '{"stdout":"GET /x?ssl_cert_reqs=[redacted]"}',
        'R3disSecretPass',
      ],
    ] as const) {
      const bounded = await boundForModel(result, BIG, {});
      expect(bounded.summary, 'SECRETS_B10_CORE_SUMMARY_KEPT_OPENING').toBe(summary);
      expect(bounded.summary.includes(secret), 'SECRETS_B10_CORE_SUMMARY_KEPT_OPENING').toBe(false);
    }
    // The journal projection, which is compared rather than shown, keeps its reading so that its digests do
    // not change: the same JSON as a text argument still shows the value, a residual deferred-tasks.md records.
    expect(
      redactSecretShapedText(JSON.stringify({ stdout: env })),
      'SECRETS_B10_CORE_SUMMARY_KEPT_OPENING',
    ).toBe(
      '{"stdout":"DATABASE_URL=postgres://db.example.com/app?sslmode=[redacted]"S3cr3tValue2024\\"\\n"}',
    );
  });
});
