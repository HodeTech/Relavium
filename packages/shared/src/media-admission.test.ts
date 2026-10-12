import { describe, expect, it } from 'vitest';
import {
  admitMediaDescriptor,
  canonicalMediaMimeType,
  MediaAdmissionError,
  mediaMimeTypesCompatible,
  reconcileMediaDescriptors,
} from './media-admission.js';
import { collectMediaForAdmission } from './media-publication.js';
import type { DurableMediaMeta } from './content.js';
const handle = `media://sha256-${'a'.repeat(64)}`;
const meta: DurableMediaMeta = { handle, mimeType: 'audio/L16', modality: 'audio', byteLength: 2 };
const part = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'media',
  mimeType: 'audio/L16',
  byteLength: 2,
  source: { kind: 'handle', ref: handle },
  ...extra,
});
describe('strict media descriptor admission', () => {
  it('normalizes only reviewed aliases and case; refuses parameters/whitespace/control/unknown', () => {
    expect(canonicalMediaMimeType('IMAGE/JPG')).toBe('image/jpeg');
    expect(canonicalMediaMimeType('audio/x-wav')).toBe('audio/wav');
    expect(canonicalMediaMimeType('audio/x-flac')).toBe('audio/flac');
    for (const mime of [
      'image/svg+xml',
      'image/avif',
      'audio/mp4',
      ' image/png',
      'image/png;foo=bar',
      'audio/ogg\n',
    ])
      expect(() => canonicalMediaMimeType(mime)).toThrow(MediaAdmissionError);
  });
  it('uses directional Ogg compatibility only, never metadata tuple relabelling', () => {
    expect(mediaMimeTypesCompatible('audio/ogg', 'audio/opus')).toBe(true);
    expect(mediaMimeTypesCompatible('audio/opus', 'audio/ogg')).toBe(false);
    expect(() =>
      reconcileMediaDescriptors([
        { ...meta, mimeType: 'audio/ogg' },
        { ...meta, mimeType: 'audio/opus' },
      ]),
    ).toThrow(MediaAdmissionError);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid actual counts %s',
    (value) => {
      expect(() => admitMediaDescriptor({ ...meta, byteLength: value })).toThrow(
        MediaAdmissionError,
      );
    },
  );
  it.each([undefined, null, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2'])(
    'does not erase present invalid duration %s',
    (durationMs) => {
      expect(
        () => admitMediaDescriptor({ ...meta, durationMs }),
        'media-invalid-duration-not-dropped',
      ).toThrow(MediaAdmissionError);
    },
  );
  it('rejects mismatched modality and image duration', () => {
    expect(() => admitMediaDescriptor({ ...meta, modality: 'image' })).toThrow();
    expect(() =>
      admitMediaDescriptor({ ...meta, mimeType: 'image/png', modality: 'image', durationMs: 1 }),
    ).toThrow();
  });
  it('owns/freeze DTOs and enriches absent duration in either order', () => {
    const input = { ...meta };
    const owned = admitMediaDescriptor(input);
    input.byteLength = 99;
    expect(owned.byteLength).toBe(2);
    expect(Object.isFrozen(owned)).toBe(true);
    for (const items of [
      [meta, { ...meta, durationMs: 3 }],
      [{ ...meta, durationMs: 3 }, meta],
    ])
      expect(reconcileMediaDescriptors(items)).toEqual([{ ...meta, durationMs: 3 }]);
  });
  it('rejects array getters, holes, overrides and descriptor accessors without evaluating them', () => {
    let calls = 0;
    const hostile = { ...meta };
    Object.defineProperty(hostile, 'mimeType', {
      get() {
        calls++;
        return 'audio/L16';
      },
    });
    expect(() => admitMediaDescriptor(hostile)).toThrow();
    const batch: DurableMediaMeta[] = [meta];
    Object.defineProperty(batch, 0, {
      get() {
        calls++;
        return meta;
      },
    });
    expect(() => reconcileMediaDescriptors(batch)).toThrow();
    expect(() => reconcileMediaDescriptors(new Array<DurableMediaMeta>(1))).toThrow();
    const overridden = [meta];
    Object.defineProperty(overridden, Symbol.iterator, {
      value() {
        calls++;
        throw new Error('private');
      },
    });
    expect(reconcileMediaDescriptors(overridden)).toEqual([meta]);
    expect(calls).toBe(0);
  });
  for (const shape of ['array', 'map-key', 'map-value', 'set', 'record'])
    for (const reverse of [false, true])
      it(`checks distinct same-hash occurrences before dedup: ${shape}/${reverse}`, () => {
        const a = part(),
          b = part({ durationMs: 0 }),
          items = reverse ? [b, a] : [a, b];
        const value =
          shape === 'array'
            ? items
            : shape === 'map-key'
              ? new Map(items.map((v, i) => [v, i]))
              : shape === 'map-value'
                ? new Map(items.map((v, i) => [i, v]))
                : shape === 'set'
                  ? new Set(items)
                  : { first: items[0], second: items[1] };
        expect(() => collectMediaForAdmission(value), 'media-conflict-before-dedup').toThrow(
          MediaAdmissionError,
        );
      });
  it('rejects malformed standalone media and non-handle carriers', () => {
    for (const value of [
      { type: 'media' },
      { type: 'media', mimeType: 'audio/L16', source: { kind: 'wat' } },
      part({ source: { kind: 'url', url: 'https://example.invalid' } }),
    ])
      expect(() => collectMediaForAdmission(value)).toThrow(MediaAdmissionError);
  });
  it('compares conflicts in all tuple fields including intervening omissions', () => {
    for (const different of [
      { ...meta, byteLength: 4 },
      { ...meta, mimeType: 'audio/wav' },
      { ...meta, durationMs: 7 },
    ])
      expect(() =>
        reconcileMediaDescriptors([{ ...meta, durationMs: 3 }, meta, different]),
      ).toThrow(MediaAdmissionError);
  });
});
