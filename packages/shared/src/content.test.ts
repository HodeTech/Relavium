import { describe, expect, it } from 'vitest';

import {
  containsInlineMediaBytes,
  ContentPartSchema,
  decodedBase64ByteLength,
  DurableContentPartSchema,
  DurableMediaPartSchema,
  DurableMediaSourceSchema,
  INLINE_MEDIA_CEILING,
  MEDIA_MESSAGE_CAPS,
  MEDIA_URL_SOURCE_ENABLED,
  MediaPartSchema,
  MediaSourceSchema,
  mediaModalityOf,
  persistableMediaRefine,
  refineInFlightMediaPart,
} from './content.js';
import type { AbortSignalLike, ContentPart, DurableContentPart, MediaPart } from './content.js';

/** A syntactically valid canonical handle (64 lowercase hex). */
const HANDLE = `media://sha256-${'a'.repeat(64)}`;

/** 'hello' as padded base64 — 5 decoded bytes. */
const TINY_BASE64 = 'aGVsbG8=';

/** Valid base64 whose decoded size exceeds the 256 KB image/audio ceiling. */
const OVER_CEILING_BASE64 = 'A'.repeat(((INLINE_MEDIA_CEILING.image / 3) * 4 + 8) & ~3);

describe('ContentPartSchema', () => {
  it('accepts each of the five content-part variants', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
      { type: 'tool_result', toolCallId: 'c1', result: { ok: true }, isError: false },
      { type: 'reasoning', text: 'thinking' },
      { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: TINY_BASE64 } },
    ];
    for (const part of parts) {
      expect(ContentPartSchema.safeParse(part).success).toBe(true);
    }
  });

  it('pins the union member count to five (an added/removed arm must update this test)', () => {
    expect(ContentPartSchema.options).toHaveLength(5);
  });

  it('accepts a tool_result without the optional isError', () => {
    expect(
      ContentPartSchema.safeParse({ type: 'tool_result', toolCallId: 'c1', result: 'done' })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown content-part type', () => {
    expect(ContentPartSchema.safeParse({ type: 'image', url: 'x' }).success).toBe(false);
  });

  it('rejects a tool_call with an empty id or name', () => {
    expect(
      ContentPartSchema.safeParse({ type: 'tool_call', id: '', name: 'f', args: {} }).success,
    ).toBe(false);
    expect(
      ContentPartSchema.safeParse({ type: 'tool_call', id: 'c1', name: '', args: {} }).success,
    ).toBe(false);
  });

  it('rejects a tool_call missing its name (a required field)', () => {
    expect(ContentPartSchema.safeParse({ type: 'tool_call', id: 'c1', args: {} }).success).toBe(
      false,
    );
  });
});

describe('AbortSignalLike', () => {
  it('is a usable minimal cancellation handle', () => {
    // Constructed structurally — a real `AbortSignal` (typed only in surface code, which carries
    // the DOM/node lib) satisfies this same shape, which is the point: the platform-free packages
    // thread cancellation through it without pulling in `AbortSignal`'s lib here.
    let fired = false;
    const signal: AbortSignalLike = {
      aborted: false,
      addEventListener: (_type, listener) => listener(),
      removeEventListener: () => undefined,
    };
    signal.addEventListener('abort', () => {
      fired = true;
    });
    expect(signal.aborted).toBe(false);
    expect(fired).toBe(true);
  });
});

describe('ContentPart amendment (ADR-0030)', () => {
  it('accepts a reasoning part with an optional signature/redacted', () => {
    expect(ContentPartSchema.safeParse({ type: 'reasoning', text: 'thinking' }).success).toBe(true);
    expect(
      ContentPartSchema.safeParse({ type: 'reasoning', text: 't', signature: 's', redacted: true })
        .success,
    ).toBe(true);
  });

  it('accepts providerExecuted on tool_call and tool_result', () => {
    expect(
      ContentPartSchema.safeParse({
        type: 'tool_call',
        id: 'c1',
        name: 'f',
        args: {},
        providerExecuted: true,
      }).success,
    ).toBe(true);
    expect(
      ContentPartSchema.safeParse({
        type: 'tool_result',
        toolCallId: 'c1',
        result: {},
        providerExecuted: true,
      }).success,
    ).toBe(true);
  });
});

describe('MediaSource (ADR-0031)', () => {
  it('accepts the three in-flight carriers and pins the union to them', () => {
    const sources = [
      { kind: 'base64', data: TINY_BASE64 },
      { kind: 'handle', ref: HANDLE },
      { kind: 'url', url: 'https://example.com/a.png' },
    ];
    for (const source of sources) {
      expect(MediaSourceSchema.safeParse(source).success).toBe(true);
    }
    expect(MediaSourceSchema.options).toHaveLength(3);
  });

  it('rejects a malformed handle (wrong scheme, short hex, uppercase hex)', () => {
    for (const ref of [
      'blob://sha256-' + 'a'.repeat(64),
      'media://sha256-' + 'a'.repeat(63),
      'media://sha256-' + 'A'.repeat(64),
      'media://md5-' + 'a'.repeat(64),
    ]) {
      expect(MediaSourceSchema.safeParse({ kind: 'handle', ref }).success).toBe(false);
    }
  });

  it('durable union is handle-only by construction — base64 and url are structurally absent', () => {
    expect(DurableMediaSourceSchema.safeParse({ kind: 'handle', ref: HANDLE }).success).toBe(true);
    expect(DurableMediaSourceSchema.safeParse({ kind: 'base64', data: TINY_BASE64 }).success).toBe(
      false,
    );
    expect(
      DurableMediaSourceSchema.safeParse({ kind: 'url', url: 'https://example.com' }).success,
    ).toBe(false);
    expect(DurableMediaSourceSchema.options).toHaveLength(1);
  });
});

describe('media content-part arm (ADR-0031)', () => {
  it('accepts an in-flight media part on each carrier (the pure union is carrier-agnostic)', () => {
    // The url-gate / ceiling / caps are deliberately NOT on the pure union — they are mounted at
    // the seam ingestion boundary (refineInFlightMediaPart in @relavium/llm). A result-side part
    // (e.g. a generated image over the ceiling) must stay representable in flight.
    for (const source of [
      { kind: 'base64', data: TINY_BASE64 },
      { kind: 'handle', ref: HANDLE },
      { kind: 'url', url: 'https://example.com/a.png' },
    ]) {
      expect(
        ContentPartSchema.safeParse({ type: 'media', mimeType: 'image/png', source }).success,
      ).toBe(true);
    }
  });

  it('accepts the optional name/transcript hints', () => {
    expect(
      MediaPartSchema.safeParse({
        type: 'media',
        mimeType: 'audio/wav',
        source: { kind: 'handle', ref: HANDLE },
        name: 'greeting.wav',
        transcript: 'hello there',
      }).success,
    ).toBe(true);
  });

  it('rejects a media part with a malformed source', () => {
    expect(
      ContentPartSchema.safeParse({ type: 'media', mimeType: 'image/png', source: { kind: 'x' } })
        .success,
    ).toBe(false);
    expect(ContentPartSchema.safeParse({ type: 'media', mimeType: 'image/png' }).success).toBe(
      false,
    );
  });

  it('accepts typed durable media attachments on tool_result and rejects a base64 one', () => {
    const attached = {
      type: 'tool_result',
      toolCallId: 'c1',
      result: { descriptor: 'image saved' },
      providerExecuted: true,
      media: [{ type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } }],
    };
    expect(ContentPartSchema.safeParse(attached).success).toBe(true);
    expect(
      ContentPartSchema.safeParse({
        ...attached,
        media: [
          { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: TINY_BASE64 } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('DurableContentPart (ADR-0031)', () => {
  it('accepts the five durable variants and pins the union member count', () => {
    const parts: DurableContentPart[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } },
      { type: 'tool_result', toolCallId: 'c1', result: { ok: true } },
      { type: 'reasoning', text: 'thinking', redacted: true },
      {
        type: 'media',
        mimeType: 'video/mp4',
        source: { kind: 'handle', ref: HANDLE },
        byteLength: 1024,
        durationMs: 1500,
      },
    ];
    for (const part of parts) {
      expect(DurableContentPartSchema.safeParse(part).success).toBe(true);
    }
    expect(DurableContentPartSchema.innerType().options).toHaveLength(5);
  });

  it('rejects a durable media part with a base64 or url source (structurally)', () => {
    for (const source of [
      { kind: 'base64', data: TINY_BASE64 },
      { kind: 'url', url: 'https://example.com/a.png' },
    ]) {
      expect(
        DurableContentPartSchema.safeParse({ type: 'media', mimeType: 'image/png', source })
          .success,
      ).toBe(false);
    }
  });

  it('STRIPS a reasoning signature on the durable arm (the field is structurally absent)', () => {
    // Parse-as-sanitize: ADR-0030 pins the signature as never-persisted; the durable arm has no
    // field to hold it, so parsing a signed in-flight part through the durable union drops it.
    const parsed = DurableContentPartSchema.parse({
      type: 'reasoning',
      text: 't',
      signature: 'opaque-continuity-token',
    });
    expect(parsed).toEqual({ type: 'reasoning', text: 't' });
    expect(Object.keys(parsed)).not.toContain('signature');
  });

  it('rejects inline media bytes smuggled inside the opaque tool fields (the backstop scan)', () => {
    expect(
      DurableContentPartSchema.safeParse({
        type: 'tool_result',
        toolCallId: 'c1',
        result: { nested: [{ kind: 'base64', data: TINY_BASE64 }] },
      }).success,
    ).toBe(false);
    expect(
      DurableContentPartSchema.safeParse({
        type: 'tool_call',
        id: 'c1',
        name: 'f',
        args: { image: `data:image/png;base64,${TINY_BASE64}` },
      }).success,
    ).toBe(false);
  });

  it('enforces the Y3 metadata rules: durationMs is audio/video-only, byteLength is >= 0', () => {
    const base = { type: 'media', source: { kind: 'handle', ref: HANDLE } };
    expect(
      DurableMediaPartSchema.safeParse({ ...base, mimeType: 'audio/wav', durationMs: 1200 })
        .success,
    ).toBe(true);
    expect(
      DurableMediaPartSchema.safeParse({ ...base, mimeType: 'image/png', durationMs: 1200 })
        .success,
    ).toBe(false);
    expect(
      DurableMediaPartSchema.safeParse({ ...base, mimeType: 'image/png', byteLength: -1 }).success,
    ).toBe(false);
    // The same rules hold through the union (the shared refine cannot drift between positions).
    expect(
      DurableContentPartSchema.safeParse({ ...base, mimeType: 'application/pdf', durationMs: 5 })
        .success,
    ).toBe(false);
  });

  it('rejects a durable media part whose MIME maps to no known modality (fail-closed)', () => {
    expect(
      DurableMediaPartSchema.safeParse({
        type: 'media',
        mimeType: 'application/zip',
        source: { kind: 'handle', ref: HANDLE },
      }).success,
    ).toBe(false);
  });
});

describe('media helpers (ADR-0031)', () => {
  it('derives the modality from the MIME prefix, case-insensitively, document = application/pdf', () => {
    expect(mediaModalityOf('image/png')).toBe('image');
    expect(mediaModalityOf('audio/wav')).toBe('audio');
    expect(mediaModalityOf('video/mp4')).toBe('video');
    expect(mediaModalityOf('application/pdf')).toBe('document');
    expect(mediaModalityOf('APPLICATION/PDF')).toBe('document');
    expect(mediaModalityOf('text/plain')).toBeUndefined();
    expect(mediaModalityOf('application/zip')).toBeUndefined();
  });

  it('computes decoded base64 byte length and fails closed on invalid input', () => {
    expect(decodedBase64ByteLength('aGVsbG8=')).toBe(5); // 'hello'
    expect(decodedBase64ByteLength('aGVsbG8h')).toBe(6); // 'hello!'
    expect(decodedBase64ByteLength('aGk=')).toBe(2); // 'hi'
    expect(decodedBase64ByteLength('aA==')).toBe(1); // the '==' double-padding branch
    expect(decodedBase64ByteLength('')).toBeUndefined();
    expect(decodedBase64ByteLength('abc')).toBeUndefined(); // not a multiple of 4
    expect(decodedBase64ByteLength('a!c=')).toBeUndefined(); // illegal character
    expect(decodedBase64ByteLength('=abc')).toBeUndefined(); // padding not terminal
    expect(decodedBase64ByteLength('a===')).toBeUndefined(); // over-padded
  });

  it('finds inline media bytes nested anywhere in an opaque value, cycle-safely', () => {
    expect(containsInlineMediaBytes({ a: [{ kind: 'base64', data: TINY_BASE64 }] })).toBe(true);
    expect(containsInlineMediaBytes(`data:image/png;base64,${TINY_BASE64}`)).toBe(true);
    // RFC 2397: parameters before ;base64 and an empty mediatype are legal — both must trip the scan.
    expect(containsInlineMediaBytes(`data:image/png;name=x;base64,${TINY_BASE64}`)).toBe(true);
    expect(containsInlineMediaBytes(`data:text/plain;charset=utf-8;base64,${TINY_BASE64}`)).toBe(
      true,
    );
    expect(containsInlineMediaBytes(`data:;base64,${TINY_BASE64}`)).toBe(true);
    expect(
      containsInlineMediaBytes({ deep: { uri: `data:audio/wav;base64,${TINY_BASE64}` } }),
    ).toBe(true);
    expect(containsInlineMediaBytes({ kind: 'handle', ref: HANDLE })).toBe(false);
    expect(containsInlineMediaBytes({ ok: true, list: [1, 'two', null] })).toBe(false);
    expect(containsInlineMediaBytes(undefined)).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(containsInlineMediaBytes(cyclic)).toBe(false);
  });
});

describe('the tier policy constants (ADR-0031)', () => {
  it('pins video and document as never-inline (ceiling 0) and image/audio as bounded', () => {
    expect(INLINE_MEDIA_CEILING.video).toBe(0);
    expect(INLINE_MEDIA_CEILING.document).toBe(0);
    expect(INLINE_MEDIA_CEILING.image).toBeGreaterThan(0);
    expect(INLINE_MEDIA_CEILING.audio).toBeGreaterThan(0);
  });

  it('pins the per-message caps as positive and the aggregate below count x ceiling', () => {
    expect(MEDIA_MESSAGE_CAPS.maxPartsPerMessage).toBeGreaterThan(0);
    expect(MEDIA_MESSAGE_CAPS.maxInlineBytesPerMessage).toBeGreaterThan(0);
    // The aggregate cap must actually bind — otherwise the count cap alone defines the worst case.
    expect(MEDIA_MESSAGE_CAPS.maxInlineBytesPerMessage).toBeLessThanOrEqual(
      MEDIA_MESSAGE_CAPS.maxPartsPerMessage * INLINE_MEDIA_CEILING.image,
    );
  });

  it('pins the url carrier feature flag OFF until the shared SSRF primitive lands (1.AE)', () => {
    // Flipping this is a deliberate landing-gate act (ADR-0031 §Reserved shape), not a drive-by.
    expect(MEDIA_URL_SOURCE_ENABLED).toBe(false);
  });
});

describe('refineInFlightMediaPart — the seam ingestion rules (ADR-0031)', () => {
  /** The function in its natural mount, with the returned inline-byte accounting captured. */
  let returnedBytes: number | undefined;
  const boundary = MediaPartSchema.superRefine((part, ctx) => {
    returnedBytes = refineInFlightMediaPart(part, ctx);
  });
  const media = (mimeType: string, source: MediaPart['source']): unknown => ({
    type: 'media',
    mimeType,
    source,
  });

  it('accepts a part of EXACTLY the ceiling (the > vs >= boundary is pinned)', () => {
    // (ceiling + 2) / 3 * 4 − 2 'A's + '==' decodes to exactly INLINE_MEDIA_CEILING.image bytes.
    const exactCeiling = 'A'.repeat(((INLINE_MEDIA_CEILING.image + 2) / 3) * 4 - 2) + '==';
    expect(
      boundary.safeParse(media('image/png', { kind: 'base64', data: exactCeiling })).success,
    ).toBe(true);
    expect(returnedBytes).toBe(INLINE_MEDIA_CEILING.image);
  });

  it('accepts a sub-ceiling base64 image and reports its decoded size', () => {
    expect(
      boundary.safeParse(media('image/png', { kind: 'base64', data: TINY_BASE64 })).success,
    ).toBe(true);
    expect(returnedBytes).toBe(5);
  });

  it('accepts a handle for every modality (the canonical durable carrier) at 0 inline bytes', () => {
    for (const mime of ['image/png', 'audio/wav', 'video/mp4', 'application/pdf']) {
      expect(boundary.safeParse(media(mime, { kind: 'handle', ref: HANDLE })).success).toBe(true);
      expect(returnedBytes).toBe(0);
    }
  });

  it('rejects an over-ceiling base64 part (the input the happy path never sends)', () => {
    expect(
      boundary.safeParse(media('image/png', { kind: 'base64', data: OVER_CEILING_BASE64 })).success,
    ).toBe(false);
  });

  it('rejects inline video and document outright (ceiling 0 — never inline)', () => {
    expect(
      boundary.safeParse(media('video/mp4', { kind: 'base64', data: TINY_BASE64 })).success,
    ).toBe(false);
    expect(
      boundary.safeParse(media('application/pdf', { kind: 'base64', data: TINY_BASE64 })).success,
    ).toBe(false);
  });

  it('rejects the url carrier while the SSRF landing gate is off', () => {
    expect(
      boundary.safeParse(media('image/png', { kind: 'url', url: 'https://example.com/a.png' }))
        .success,
    ).toBe(false);
  });

  it('rejects an unknown modality and invalid base64 (fail-closed)', () => {
    expect(
      boundary.safeParse(media('application/zip', { kind: 'handle', ref: HANDLE })).success,
    ).toBe(false);
    expect(
      boundary.safeParse(media('image/png', { kind: 'base64', data: '!!not-base64!!' })).success,
    ).toBe(false);
  });
});

describe('persistableMediaRefine — the durable backstop (ADR-0031)', () => {
  const backstop = MediaPartSchema.superRefine(persistableMediaRefine);

  it('trips on a base64 part in a durable position', () => {
    const result = backstop.safeParse({
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: TINY_BASE64 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('deInlineMedia');
    }
  });

  it('trips on a url part in a durable position (handle-only durable is absolute)', () => {
    expect(
      backstop.safeParse({
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://example.com/a.png' },
      }).success,
    ).toBe(false);
  });

  it('passes a handle part untouched', () => {
    expect(
      backstop.safeParse({
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'handle', ref: HANDLE },
      }).success,
    ).toBe(true);
  });
});

describe('round-trip fidelity (1.AD acceptance: the new shapes parse AND round-trip)', () => {
  it('round-trips a fully-populated durable media part with no drift', () => {
    const part = {
      type: 'media',
      mimeType: 'video/mp4',
      source: { kind: 'handle', ref: HANDLE },
      name: 'clip.mp4',
      transcript: 'a fox jumps',
      byteLength: 2048,
      durationMs: 1500,
    };
    expect(DurableMediaPartSchema.parse(part)).toEqual(part);
    expect(DurableContentPartSchema.parse(part)).toEqual(part);
  });

  it('round-trips a fully-populated in-flight part and STRIPS durable-only metadata (Y3 lean rule)', () => {
    const part = {
      type: 'media',
      mimeType: 'audio/wav',
      source: { kind: 'base64', data: TINY_BASE64 },
      name: 'hi.wav',
      transcript: 'hello',
    };
    expect(MediaPartSchema.parse(part)).toEqual(part);
    expect(ContentPartSchema.parse(part)).toEqual(part);
    // The in-flight arm stays lean (ADR-0031 Y3): durable-only metadata is parse-stripped, the
    // same deliberate strip-as-sanitize behavior the durable reasoning arm pins for `signature`.
    const parsed = MediaPartSchema.parse({ ...part, byteLength: 5, durationMs: 100 });
    expect(parsed).toEqual(part);
    expect(Object.keys(parsed)).not.toContain('byteLength');
    expect(Object.keys(parsed)).not.toContain('durationMs');
  });

  it('bounds mimeType — parameters, spaces, oversize, and data-URI shapes are rejected', () => {
    // The bound keeps an attacker-controlled mimeType out of the interpolated error messages
    // (a bytes-into-logs channel, I3): bare type/subtype only, max 255 chars.
    for (const mimeType of [
      'image/png; charset=utf-8',
      'image png',
      `image/${'x'.repeat(300)}`,
      `data:image/png;base64,${TINY_BASE64}`,
    ]) {
      expect(
        MediaPartSchema.safeParse({
          type: 'media',
          mimeType,
          source: { kind: 'handle', ref: HANDLE },
        }).success,
      ).toBe(false);
    }
  });
});
