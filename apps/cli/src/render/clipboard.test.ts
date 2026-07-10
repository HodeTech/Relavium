import { describe, expect, it } from 'vitest';

import {
  copyToClipboard,
  detectMultiplexer,
  encodeOsc52,
  OSC52_MAX_BASE64_LENGTH,
  type ClipboardDeps,
} from './clipboard.js';

/**
 * The OSC 52 clipboard writer (2.6.F Step 6). Three properties carry the whole feature: the payload is base64 (so
 * transcript text can never terminate the escape), tmux needs a DCS passthrough with DOUBLED inner escapes (without
 * it tmux swallows the sequence and nothing reaches the emulator), and an over-long payload is REFUSED rather than
 * truncated (a silently half-copied selection is worse than a refusal).
 */

const harness = (
  env: Record<string, string | undefined> = {},
): { deps: ClipboardDeps; writes: string[] } => {
  const writes: string[] = [];
  return { deps: { writeControl: (s) => writes.push(s), env }, writes };
};

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('detectMultiplexer', () => {
  it('reads the environment each multiplexer sets for its children', () => {
    expect(detectMultiplexer({ TMUX: '/tmp/tmux-501/default,123,0' })).toBe('tmux');
    expect(detectMultiplexer({ ZELLIJ: '0' })).toBe('zellij');
    expect(detectMultiplexer({})).toBeUndefined();
  });

  it('an EMPTY variable is not a multiplexer (a shell that exported it blank)', () => {
    expect(detectMultiplexer({ TMUX: '' })).toBeUndefined();
    expect(detectMultiplexer({ ZELLIJ: '' })).toBeUndefined();
  });

  it('tmux wins when both are somehow set (the inner one frames the escape)', () => {
    expect(detectMultiplexer({ TMUX: 'x', ZELLIJ: '0' })).toBe('tmux');
  });
});

describe('encodeOsc52', () => {
  it('the plain form is `ESC ] 52 ; c ; <base64> BEL`', () => {
    expect(encodeOsc52('SGk=')).toBe('\x1b]52;c;SGk=\x07');
  });

  it('writes only the CLIPBOARD selection — never PRIMARY (which would clobber the middle-click buffer)', () => {
    expect(encodeOsc52('SGk=')).toContain(';c;');
    expect(encodeOsc52('SGk=')).not.toContain(';p;');
  });

  it('SECURITY: never emits the `?` read payload — OSC 52 can also EXFILTRATE the clipboard', () => {
    expect(encodeOsc52(b64('?'))).not.toContain(';c;?');
  });

  it('tmux: wraps in a DCS passthrough with every inner ESC DOUBLED', () => {
    // Without the doubling tmux interprets the ESC instead of forwarding it, and the clipboard never updates.
    expect(encodeOsc52('SGk=', 'tmux')).toBe('\x1bPtmux;\x1b\x1b]52;c;SGk=\x07\x1b\\');
  });

  it('zellij: forwards a PLAIN OSC 52 (it does not need the tmux wrapper)', () => {
    expect(encodeOsc52('SGk=', 'zellij')).toBe('\x1b]52;c;SGk=\x07');
  });
});

describe('copyToClipboard', () => {
  it('base64-encodes the text and writes exactly one escape', () => {
    const { deps, writes } = harness();
    expect(copyToClipboard(deps, 'hello')).toEqual({ kind: 'written', characters: 5 });
    expect(writes).toEqual([`\x1b]52;c;${b64('hello')}\x07`]);
  });

  it('SECURITY: an ESC or BEL inside the text cannot terminate the escape — base64 IS the boundary', () => {
    const { deps, writes } = harness();
    copyToClipboard(deps, 'a\x1b]52;c;evil\x07b');
    const written = writes[0] ?? '';
    // Exactly one BEL (the real terminator) and one ESC (the introducer); the payload's own bytes are encoded away.
    expect([...written].filter((c) => c === '\x07')).toHaveLength(1);
    expect([...written].filter((c) => c === '\x1b')).toHaveLength(1);
    expect(written).toContain(b64('a\x1b]52;c;evil\x07b'));
  });

  it('preserves non-ASCII exactly (UTF-8 in, UTF-8 out)', () => {
    const { deps, writes } = harness();
    copyToClipboard(deps, 'merhaba 日本語 👋');
    expect(writes[0]).toContain(b64('merhaba 日本語 👋'));
  });

  it('EMPTY text writes nothing at all — a click that selected nothing must not touch the clipboard', () => {
    const { deps, writes } = harness();
    expect(copyToClipboard(deps, '')).toEqual({ kind: 'empty' });
    expect(writes).toEqual([]);
  });

  it('REFUSES an over-long payload rather than truncating it, and writes nothing', () => {
    const { deps, writes } = harness();
    // 3 bytes of input → 4 of base64, so this comfortably exceeds the floor.
    const huge = 'x'.repeat(OSC52_MAX_BASE64_LENGTH);
    const outcome = copyToClipboard(deps, huge);
    expect(outcome.kind).toBe('too-large');
    expect(outcome).toMatchObject({ limit: OSC52_MAX_BASE64_LENGTH });
    expect(writes).toEqual([]); // a half-copied selection is worse than a refusal
  });

  it('the bound is INCLUSIVE, exercised on BOTH sides of it', () => {
    // base64 length is always 4·ceil(n/3), so no payload lands exactly on 74 994: 56 244 chars encode to 74 992
    // (fits) and one more char pushes it to 74 996 (refused). Testing a rounder number would miss the boundary.
    const fits = harness();
    expect(copyToClipboard(fits.deps, 'y'.repeat(56_244)).kind).toBe('written');
    expect(fits.writes).toHaveLength(1);

    const over = harness();
    expect(copyToClipboard(over.deps, 'y'.repeat(56_245))).toMatchObject({
      kind: 'too-large',
      base64Length: 74_996,
      limit: OSC52_MAX_BASE64_LENGTH,
    });
    expect(over.writes).toEqual([]);
  });

  it('inside tmux, the ONE write is the DCS-wrapped form', () => {
    const { deps, writes } = harness({ TMUX: '/tmp/tmux-501/default,1,0' });
    copyToClipboard(deps, 'hi');
    expect(writes).toEqual([`\x1bPtmux;\x1b\x1b]52;c;${b64('hi')}\x07\x1b\\`]);
  });

  it('is TOTAL: a throwing writeControl is the caller’s to handle, and no partial escape is emitted before it', () => {
    // The three refusal paths (`empty`, `too-large`) must write NOTHING, so a caller can trust that a failed copy
    // never left a half-sequence on the terminal. The success path writes exactly once — asserted above.
    const boom = new Error('stdout closed');
    const deps = {
      writeControl: () => {
        throw boom;
      },
      env: {},
    };
    expect(copyToClipboard(deps, '')).toEqual({ kind: 'empty' }); // never reaches writeControl
    expect(copyToClipboard(deps, 'x'.repeat(56_245)).kind).toBe('too-large'); // …nor here
    expect(() => copyToClipboard(deps, 'hi')).toThrow(boom); // …and the ONE write is not swallowed
  });
});
