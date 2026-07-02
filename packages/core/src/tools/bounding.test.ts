import type { AbortSignalLike } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  boundForModel,
  redactSecretShapedText,
  redactSecretShapedValue,
  utf8ByteLength,
} from './bounding.js';
import type { ToolHost, ToolResultLimits } from './types.js';

const BIG: ToolResultLimits = { maxBytes: 50_000, maxLines: 2000 };
const TINY: ToolResultLimits = { maxBytes: 20, maxLines: 3 };

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
});

describe('redactSecretShapedText', () => {
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
    expect(redactSecretShapedText('ghp' + '_0123456789abcdef0123456789abcdefABCD')).toBe('[redacted]');
  });

  it('leaves ordinary text (and short non-secret values) intact', () => {
    expect(redactSecretShapedText('the quick brown fox')).toBe('the quick brown fox');
    expect(redactSecretShapedText('count = 42')).toBe('count = 42'); // not a secret-ish key
  });

  it('is ReDoS-safe on a long adversarial input (completes fast, no catastrophic backtracking)', () => {
    const evil = `${'a'.repeat(50_000)} password=`; // key with no value → no runaway
    const started = performance.now();
    redactSecretShapedText(evil);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('redactSecretShapedValue', () => {
  it('scrubs string values at any nesting, keeping object keys (header names) intact', () => {
    const input = {
      url: 'https://api.example.com/x?api_key=sk-' + 'secret9876543210',
      headers: { Authorization: 'Bearer tok_abcdef123456', 'X-Trace': 'keep-me' },
      body: 'client_secret=shhhhhhhhhh',
    };
    const out = redactSecretShapedValue(input) as typeof input;
    expect(out.headers.Authorization).toBe('Bearer [redacted]');
    expect(out.headers['X-Trace']).toBe('keep-me'); // non-secret header value untouched
    expect(Object.keys(out.headers)).toEqual(['Authorization', 'X-Trace']); // header NAMES preserved
    expect(out.body).toBe('[redacted]');
    expect(out.url).not.toContain('sk-' + 'secret9876543210');
  });

  it('is cycle-safe', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => redactSecretShapedValue(cyclic)).not.toThrow();
  });
});
