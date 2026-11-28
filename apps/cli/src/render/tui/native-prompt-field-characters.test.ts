/**
 * What a native text or masked field accepts (MVP-11 unit 7, round 2 sitting #2: F6). A field's value is what a flow starts or writes (a
 * `/run` input, a gate's secret slot, the import path, a pricing rate, the provider key), and what the field and the confirmation show of it is
 * drawn through the display floor, which removes C0 and C1 controls, DEL and the bidirectional controls. A value holding one of those would be
 * shown as another string than the one used (`a<CSI>2Jb<NEL>c<RLO>d` was drawn `a2Jbcd`), so the field refuses it, as it always refused a C0
 * control and DEL: the same closed sentence, nothing of the refused text kept, `Backspace` to go on. The same goes for the invisible and format
 * characters the `/run` confirmation (`flowLine`) removes and the spaces it folds to an ordinary space (round 2 sittings #2 and #3: a closed
 * table of named ranges, every code point pressed), so the question shows exactly what is started. Every other character, a joiner of an
 * emoji sequence, the non-joiner of a script that needs it and the emoji presentation selector included, is typed as before and shown as it is.
 *
 * No escape of a special character is written into this file: each is built from its code point.
 */
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { parseWorkflow } from '@relavium/core';

import type { HostedLaunch, HostedStartRequest } from '../../home/run-host.js';
import { createRunLaunch } from '../../home/run-launch.js';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const enter: Key = { ...none, return: true };
const backspace: Key = { ...none, backspace: true };
const ch = (code: number): string => String.fromCharCode(code);
const REFUSED = 'Input contains unsupported control characters';

/** Every C1 control, U+0080 to U+009F. */
const C1 = Array.from({ length: 0x20 }, (_, index) => 0x80 + index);
/** The bidirectional controls the display floor removes: the embeddings and overrides, the isolates, and the three marks. */
const BIDI = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c,
];

/**
 * The characters the `/run` confirmation (`flowLine`) removes or folds, as named inclusive ranges (written here independently of the field's
 * own table, so a range the field lost is a failure here): the invisible and format characters of round 2 sittings #2 and #3, and the spaces
 * the confirmation folds to an ordinary space. A value holding one is shown as another string than the one started, so the field refuses it.
 * EVERY code point of every range is pressed below.
 */
const REFUSED_RANGES: readonly (readonly [name: string, first: number, last: number])[] = [
  ['the soft hyphen', 0xad, 0xad],
  ['the combining grapheme joiner', 0x34f, 0x34f],
  ['the Hangul choseong and jungseong fillers', 0x115f, 0x1160],
  ['the Mongolian vowel separator', 0x180e, 0x180e],
  ['the zero-width space', 0x200b, 0x200b],
  ['the line and paragraph separators', 0x2028, 0x2029],
  ['the word joiner', 0x2060, 0x2060],
  ['the invisible operators', 0x2061, 0x2064],
  ['the Hangul filler', 0x3164, 0x3164],
  ['the byte-order mark', 0xfeff, 0xfeff],
  ['the halfwidth Hangul filler', 0xffa0, 0xffa0],
  ['the interlinear annotation characters', 0xfff9, 0xfffb],
  ['the musical symbol format characters', 0x1d173, 0x1d17a],
  ['the tag characters', 0xe0000, 0xe007f],
  ['the no-break space', 0xa0, 0xa0],
  ['the en quad to the hair space', 0x2000, 0x200a],
  ['the narrow no-break space', 0x202f, 0x202f],
  ['the medium mathematical space', 0x205f, 0x205f],
  ['the ideographic space', 0x3000, 0x3000],
];
const INVISIBLE = REFUSED_RANGES.flatMap(([name, first, last]) =>
  Array.from({ length: last - first + 1 }, (_, index) => [name, first + index] as const),
);
/**
 * Invisible characters a text really uses: the joiner of an emoji sequence, the non-joiner a script such as Persian needs, and the emoji
 * presentation selector. They stay typeable (the confirmation drops them: an invisible difference, pinned in the last describe).
 */
const INVISIBLE_KEPT = [0x200d, 0x200c, 0xfe0f];
const hex = (code: number): string => code.toString(16).toUpperCase().padStart(4, '0');

/** The security sitting's probe D: an 8-bit CSI, a NEL and a right-to-left override inside an ordinary word. */
const PROBE_D = `a${ch(0x9b)}2Jb${ch(0x85)}c${ch(0x202e)}d`;

function open(kind: 'text' | 'password') {
  const channel = createNativePromptChannel();
  channel.flow.begin();
  const answer =
    kind === 'text'
      ? channel.flow.text({ message: 'Topic' })
      : channel.flow.password({ message: 'Token' });
  return { ...channel, answer };
}

describe('a value the field could not show as it is, is refused whole', () => {
  it.each(['text', 'password'] as const)(
    '%s: probe D pasted is refused with the field’s closed sentence, nothing of it is kept, and Enter submits nothing',
    async (kind) => {
      const f = open(kind);
      expect(f.ui.paste(PROBE_D)).toBe(true);
      const snapshot = f.ui.getSnapshot();
      expect(snapshot.error.startsWith(REFUSED), snapshot.error).toBe(true);
      expect(snapshot.display, 'nothing of the refused paste is in the field').toBe('');
      expect(snapshot.error, 'the refusal names no character of the paste').not.toMatch(/2J|bc/u);
      f.ui.input('', enter);
      expect(f.ui.getSnapshot().kind, 'the refusal holds until the person edits').toBe(kind);
      // Backspace takes the refusal away; what is typed next is the value, exactly.
      f.ui.input('', backspace);
      expect(f.ui.getSnapshot().error).toBe('');
      f.ui.paste('abcd');
      f.ui.input('', enter);
      expect(await f.answer).toBe('abcd');
    },
  );

  it.each(
    [...C1, ...BIDI].map(
      (code) => [code.toString(16).toUpperCase().padStart(4, '0'), code] as const,
    ),
  )(
    'U+%s pasted, typed alone, and typed in a coalesced chunk is refused in a text and a masked field',
    async (_, code) => {
      for (const kind of ['text', 'password'] as const) {
        for (const deliver of [
          (f: ReturnType<typeof open>) => f.ui.paste(`a${ch(code)}b`),
          (f: ReturnType<typeof open>) => f.ui.input(ch(code), none),
          (f: ReturnType<typeof open>) => f.ui.input(`ab${ch(code)}cd`, none),
        ]) {
          const f = open(kind);
          f.ui.input('x', none);
          deliver(f);
          expect(
            f.ui.getSnapshot().error.startsWith(REFUSED),
            `${kind} U+${code.toString(16)}`,
          ).toBe(true);
          expect(f.ui.getSnapshot().display, 'only the key typed before it').toBe(
            kind === 'text' ? 'x' : '•',
          );
          f.ui.input('', backspace);
          f.ui.input('', enter);
          expect(await f.answer, 'the value never held the refused character').toBe('');
        }
      }
    },
  );

  it.each(INVISIBLE.map(([name, code]) => [hex(code), name, code] as const))(
    'U+%s (%s) pasted, typed alone, and typed in a coalesced chunk is refused in a text and a masked field',
    async (_, _name, code) => {
      const char = String.fromCodePoint(code);
      for (const kind of ['text', 'password'] as const) {
        for (const deliver of [
          (f: ReturnType<typeof open>) => f.ui.paste(`a${char}b`),
          (f: ReturnType<typeof open>) => f.ui.input(char, none),
          (f: ReturnType<typeof open>) => f.ui.input(`ab${char}cd`, none),
        ]) {
          const f = open(kind);
          f.ui.input('x', none);
          deliver(f);
          expect(
            f.ui.getSnapshot().error.startsWith(REFUSED),
            `${kind} U+${code.toString(16)}`,
          ).toBe(true);
          expect(f.ui.getSnapshot().display, 'only the key typed before it').toBe(
            kind === 'text' ? 'x' : '•',
          );
          f.ui.input('', backspace);
          f.ui.input('', enter);
          expect(await f.answer, 'the value never held the invisible character').toBe('');
        }
      }
    },
  );

  it.each(INVISIBLE_KEPT.map((code) => [hex(code), code] as const))(
    'U+%s (an emoji sequence, a script that needs it) is still typed in a text and a masked field',
    async (_, code) => {
      for (const kind of ['text', 'password'] as const) {
        const f = open(kind);
        f.ui.paste(`a${ch(code)}b`);
        expect(f.ui.getSnapshot().error, kind).toBe('');
        f.ui.input('', enter);
        expect(await f.answer).toBe(`a${ch(code)}b`);
      }
    },
  );

  it('a C0 control and DEL are refused as they always were', () => {
    for (const code of [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f]) {
      const f = open('text');
      f.ui.paste(`a${ch(code)}b`);
      expect(f.ui.getSnapshot().error.startsWith(REFUSED), code.toString(16)).toBe(true);
    }
  });
});

describe('every other character is typed, and shown as it is', () => {
  /**
   * Letters with marks, CJK, a symbol, an emoji ZWJ sequence (the joiner U+200D is no control), an emoji with its presentation selector
   * (U+FE0F) and a Persian word with its non-joiner (U+200C). A no-break space is no longer here: the confirmation shows it as an ordinary
   * space, so the field refuses it (round 2 sitting #3).
   */
  const ORDINARY = [
    `h${ch(0xe9)}llo w${ch(0xf6)}rld`,
    `${ch(0x65e5)}${ch(0x672c)}${ch(0x8a9e)}`,
    `ok ${ch(0x2713)}`,
    `${String.fromCodePoint(0x1f469)}${ch(0x200d)}${String.fromCodePoint(0x1f4bb)}`,
    `${ch(0x2764)}${ch(0xfe0f)} it`,
    [0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645].map(ch).join(''),
    'release-notes 2026/11 (draft)',
  ];

  it.each(ORDINARY)(
    '%j pasted into a text field is the value, and is what the field shows',
    async (text) => {
      const f = open('text');
      f.ui.paste(text);
      expect(f.ui.getSnapshot().error).toBe('');
      expect(f.ui.getSnapshot().display).toBe(text);
      f.ui.input('', enter);
      expect(await f.answer).toBe(text);
    },
  );

  it('a masked field takes a pasted key whole, and shows only bullets', async () => {
    const f = open('password');
    f.ui.paste('sk-ant-api03-SYNTHETIC-not-a-key_0123456789');
    expect(f.ui.getSnapshot().error).toBe('');
    expect(f.ui.getSnapshot().display).toMatch(/^•+$/u);
    f.ui.input('', enter);
    expect(await f.answer).toBe('sk-ant-api03-SYNTHETIC-not-a-key_0123456789');
  });

  it('Esc still leaves a refused field', async () => {
    const f = open('text');
    f.ui.paste(PROBE_D);
    f.ui.input('', { ...none, escape: true });
    expect(await f.answer).toBe(NATIVE_PROMPT_CANCEL);
  });
});

describe('the `/run` confirmation shows exactly what is started', () => {
  const ONE_FIELD = `schema_version: '1.0'
workflow:
  id: nightly
  inputs:
    - { name: topic, type: string, required: true }
  nodes:
    - { id: start, type: input }
    - { id: out, type: output }
  edges:
    - { from: start, to: out }
`;

  it('probe D cannot reach the confirmation; the value typed after the refusal is the one asked about and the one started', async () => {
    let clock = 10_000;
    const channel = createNativePromptChannel({ now: () => clock });
    let visible = channel.ui.getSnapshot();
    channel.ui.bindVisibility((snapshot) => snapshot === visible);
    const show = (): void => {
      visible = channel.ui.getSnapshot();
      channel.ui.shown(visible);
    };
    const STARTED: HostedLaunch = {
      kind: 'started',
      leg: 'start',
      runId: '0123456789abcdef-run',
      ended: new Promise(() => {}),
    };
    const start = vi.fn((request: HostedStartRequest) => (void request, Promise.resolve(STARTED)));
    const launch = createRunLaunch({
      flow: channel.flow,
      host: { start },
      catalog: {
        list: () => [
          { path: 'nightly.yaml', slug: 'nightly', name: undefined, tags: [], valid: true },
        ],
        load: (path) => ({
          definition: parseWorkflow(ONE_FIELD, { source: path }),
          sourceDigest: 'd'.repeat(64),
          fsScope: { tier: 'sandboxed', fromRepository: false },
        }),
      },
    });
    const said = launch.open('nightly', 'nightly.yaml');
    const until = async (kind: string): Promise<void> => {
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== kind; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.ui.getSnapshot().kind).toBe(kind);
    };
    await until('text');
    clock += 60;
    show();
    clock += 1_000;
    channel.ui.paste(PROBE_D);
    expect(channel.ui.getSnapshot().error.startsWith(REFUSED)).toBe(true);
    channel.ui.input('', enter);
    expect(channel.ui.getSnapshot().kind, 'Enter on a refused field asks nothing further').toBe(
      'text',
    );
    channel.ui.input('', backspace);
    channel.ui.paste('abcd');
    channel.ui.input('', enter);
    await until('chord');
    expect(channel.ui.getSnapshot().message).toBe('Run nightly with topic=abcd?');
    clock += 60;
    show();
    clock += 4_000;
    channel.ui.input('y', { ...none, ctrl: true });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]?.[0].rawInputs).toEqual({ topic: 'abcd' });
    await said;
  });

  /** What the `/run` field and its confirmation do with `value` pasted into the one field: refused there, or the question it reaches. */
  async function confirmationOf(value: string): Promise<{ refused: boolean; question: string }> {
    let clock = 10_000;
    const channel = createNativePromptChannel({ now: () => clock });
    channel.ui.bindVisibility(() => true);
    const launch = createRunLaunch({
      flow: channel.flow,
      host: { start: () => new Promise<HostedLaunch>(() => {}) },
      catalog: {
        list: () => [
          { path: 'nightly.yaml', slug: 'nightly', name: undefined, tags: [], valid: true },
        ],
        load: (path) => ({
          definition: parseWorkflow(ONE_FIELD, { source: path }),
          sourceDigest: 'd'.repeat(64),
          fsScope: { tier: 'sandboxed', fromRepository: false },
        }),
      },
    });
    const said = launch.open('nightly', 'nightly.yaml');
    const until = async (kind: string): Promise<void> => {
      for (let turn = 0; turn < 50 && channel.ui.getSnapshot().kind !== kind; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(channel.ui.getSnapshot().kind).toBe(kind);
    };
    await until('text');
    channel.ui.shown(channel.ui.getSnapshot());
    clock += 1_000;
    channel.ui.paste(value);
    const refused = channel.ui.getSnapshot().error.startsWith(REFUSED);
    let question = '';
    if (!refused) {
      channel.ui.input('', enter);
      await until('chord');
      question = channel.ui.getSnapshot().message;
    }
    channel.ui.input('', { ...none, escape: true });
    channel.ui.input('c', { ...none, ctrl: true });
    await said;
    return { refused, question };
  }

  /**
   * The security sitting's probe (round 2 sitting #3, finding 4: `f6-residual`): 22 invisible, format and space characters inside `a…b`. Each
   * the confirmation would show differently is refused at the field; the three a text needs are typed and the confirmation drops them (the
   * documented invisible difference); the braille blank U+2800 was always shown as it is.
   */
  it.each(
    [
      0x200b, 0x2060, 0xfeff, 0xad, 0x2028, 0x2029, 0x180e, 0x2061, 0x2063, 0x2064, 0xfff9, 0xfffb,
      0x34f, 0x115f, 0x3164, 0xe0041, 0x1d173, 0xa0, 0x3000,
    ].map((code) => [hex(code), code] as const),
  )(
    'f6-residual U+%s: the /run field refuses it, so it never reaches the confirmation',
    async (_, code) => {
      const result = await confirmationOf(`a${String.fromCodePoint(code)}b`);
      expect(result).toEqual({ refused: true, question: '' });
    },
  );

  it.each(INVISIBLE_KEPT.map((code) => [hex(code), code] as const))(
    'f6-residual U+%s is typed, and the confirmation drops it (an invisible difference, documented beside the field’s table)',
    async (_, code) => {
      expect(await confirmationOf(`a${ch(code)}b`)).toEqual({
        refused: false,
        question: 'Run nightly with topic=ab?',
      });
    },
  );

  it('f6-residual U+2800 (the braille blank) is typed and asked about as it is', async () => {
    expect(await confirmationOf(`a${ch(0x2800)}b`)).toEqual({
      refused: false,
      question: `Run nightly with topic=a${ch(0x2800)}b?`,
    });
  });
});
