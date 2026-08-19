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

  it('over-redaction is the safe direction — a benign `token: <long>` is swept up (documented tradeoff)', () => {
    // A DISPLAY-field false positive is acceptable (the model's copy is untouched). This pins the deliberate
    // over-redaction so a future "tighten precision" change is a conscious test edit, not a silent secret leak.
    expect(redactSecretShapedText('token abcdefghijklmnop')).toContain('[redacted]');
  });

  it('is ReDoS-safe on a value-ENGAGING input AND fully redacts it (timing + correctness)', () => {
    // Drives BOTH the scheme-token run (200k) and a long quoted value (50k) — the machinery a quadratic pattern
    // blows up on. The correctness assertions catch a quantifier-narrowing regression that would leak the tail
    // (a pure timing bound would pass such a regression — it runs FASTER, not slower).
    const evil = `Authorization: Bearer ${'a'.repeat(200_000)} my_secret="${'x'.repeat(50_000)}"`;
    const started = performance.now();
    const out = redactSecretShapedText(evil);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out).not.toContain('a'.repeat(100)); // the bearer token tail is gone
    expect(out).not.toContain('x'.repeat(100)); // the long quoted value tail is gone
  });
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

  it('keeps the auth SCHEME when the shape scrub already fired', () => {
    // `Bearer` is not the secret, and which scheme a call used is exactly what a stored row is for. The
    // wholesale key redaction is the fallback for what the shape scrub structurally cannot see.
    expect(redactSecretShapedValue({ Authorization: 'Bearer tok_abcdef123456' })).toEqual({
      Authorization: 'Bearer [redacted]',
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
