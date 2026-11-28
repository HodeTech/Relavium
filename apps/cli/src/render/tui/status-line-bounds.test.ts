/**
 * SE7-6 (the scoped security sitting of unit 7): the cost of the status line grew with the length of a free value. The line is rebuilt on every
 * render of a chat (and a running turn repaints every 80 ms), and every width it measured and every cut it tried walked the whole of a value: a
 * 10,000-character model id (a project agent file chooses it) cost 31 ms a call, 67 ms with a 10,000-character provider too. Each free value
 * (provider, model, directory, mode, effort, the cost's two forms) is now bounded to 256 code points, and the bound is written after the
 * value was scrubbed from a window of four times that, so a secret that straddles the bound is whole inside the window and is redacted before
 * the cut (the straddling key of SE7-7 is not made here). A value under the bound is drawn exactly as before.
 */
import { describe, expect, it } from 'vitest';

import { type ChatStatusInput, type HomeStatusInput, statusLine } from './status-line.js';

/**
 * How much more a value of 100,000 characters may cost than one of 10,000: the cost is the same once a value is past the window the line scrubs
 * (the bound is 256 code points, the window 1,024), so the answer is 1 and a loaded machine moves it by a fraction; unbounded, it grows with the
 * length and the answer is 10. A RATIO and not a wall-clock figure: the cost of one call is 3 ms on a quiet machine and 10 ms on a loaded one,
 * and the property under test (SE7-6) is that it does not grow with the value, not how fast the machine is.
 */
const GROWTH_BOUND = 3;

const WIDE = 2000;
const SIZE = 10_000;
const MUCH_LONGER = 100_000;
const long = (text: string, count: number): string => text.repeat(Math.ceil(count / text.length));

const CHAT = (over: Partial<ChatStatusInput> = {}): ChatStatusInput => ({
  surface: 'chat',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  turns: 1,
  cost: { full: '$0.01 known; usage unverified', short: '$0.01 known', qualified: true },
  ...over,
});

const HOME = (over: Partial<HomeStatusInput> = {}): HomeStatusInput => ({
  surface: 'home',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  directory: '~/work/app',
  ...over,
});

/**
 * The cost of one call in milliseconds: the best mean of five batches after a warm-up call, so a pause of a loaded machine in one batch is not
 * read as the cost of the line.
 */
function callMs(call: () => unknown): number {
  call();
  const batches = 5;
  const calls = 10;
  let best = Number.POSITIVE_INFINITY;
  for (let batch = 0; batch < batches; batch += 1) {
    const start = performance.now();
    for (let index = 0; index < calls; index += 1) call();
    best = Math.min(best, (performance.now() - start) / calls);
  }
  return best;
}

const KEY_SHAPED = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');

/** The cost of a line built by `build` for values of `length` characters, as a multiple of what it costs for `SIZE` characters. */
function growth(build: (length: number) => () => unknown): number {
  const small = callMs(build(SIZE));
  const large = callMs(build(MUCH_LONGER));
  return large / small;
}

describe('the status line costs the same whatever the length of a value (SE7-6)', () => {
  it('a chat with a model id, provider, mode and effort ten times longer costs no more than 3 times as much a call', () => {
    expect(
      growth((length) => {
        const input = CHAT({
          model: long('model-', length),
          provider: long('provider-', length),
          mode: long('mode-', length),
          effort: long('effort-', length),
        });
        return () => statusLine(input, 100, 0);
      }),
    ).toBeLessThan(GROWTH_BOUND);
  });

  it('a chat with cost forms ten times longer costs the same', () => {
    expect(
      growth((length) => {
        const input = CHAT({
          cost: {
            full: long('$1 known; ', length),
            short: long('$1 known', length),
            qualified: true,
          },
        });
        return () => statusLine(input, 100, 0);
      }),
    ).toBeLessThan(GROWTH_BOUND);
  });

  it('the Home with a directory, model and provider ten times longer costs the same', () => {
    expect(
      growth((length) => {
        const input = HOME({
          directory: `~/${long('segment/', length)}`,
          model: long('model-', length),
          provider: long('provider-', length),
        });
        return () => statusLine(input, 100);
      }),
    ).toBeLessThan(GROWTH_BOUND);
  });
});

describe('a value under the bound is drawn exactly as before, and one over it is visibly cut (SE7-6)', () => {
  it('keeps a model of 256 code points whole', () => {
    const model = 'm'.repeat(256);
    expect(statusLine(CHAT({ model }), WIDE, 0).text).toContain(` · ${model} · ask mode`);
  });

  it('cuts a model of 257 code points to 255 and the host ellipsis, so the cut shows', () => {
    const text = statusLine(CHAT({ model: 'm'.repeat(257) }), WIDE, 0).text;
    expect(text).toContain(` · ${'m'.repeat(255)}… · ask mode`);
    expect(text).not.toContain('m'.repeat(256));
  });

  it('bounds the directory of the Home and the cost forms the same way', () => {
    expect(statusLine(HOME({ directory: `~/${'d'.repeat(400)}` }), WIDE).text).toContain(
      `   ~/${'d'.repeat(253)}…`,
    );
    const cost = statusLine(
      CHAT({
        cost: { full: `$0.01 known; ${'u'.repeat(400)}`, short: '$0.01 known', qualified: true },
      }),
      WIDE,
      0,
    ).text;
    expect(cost).toContain(`$0.01 known; ${'u'.repeat(242)}…`);
  });

  it('counts code points, not UTF-16 units, so a pair is never split', () => {
    const text = statusLine(CHAT({ model: '😀'.repeat(300) }), WIDE, 0).text;
    expect(text).toContain(`${'😀'.repeat(255)}…`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});

describe('a secret that straddles the bound is redacted, not cut (SE7-6, SE7-7)', () => {
  it.each([240, 245, 250, 254, 255])(
    'a key starting at code point %i of the model id leaves none of its body',
    (start) => {
      const model = `${'m'.repeat(start - 1)} ${KEY_SHAPED}`;
      const text = statusLine(CHAT({ model }), WIDE, 0).text;
      expect(text).not.toContain('sk-ant');
      expect(text).not.toContain('api03');
      expect(text).not.toMatch(/ABCDEF/u);
    },
  );

  it('a key whose body begins before the bound and ends far after it is redacted too', () => {
    const model = `${'m'.repeat(230)} ${KEY_SHAPED}${'k'.repeat(600)}`;
    const text = statusLine(CHAT({ model }), WIDE, 0).text;
    expect(text).not.toMatch(/sk-ant|api03|ABCDEF|kkkkkk/u);
  });
});
