import { posix, win32 } from 'node:path';

import { CATALOG_SNAPSHOT } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import {
  AMOUNT_UNAVAILABLE,
  displayPath,
  formatAge,
  formatClock,
  formatDate,
  formatDateTime,
  formatAgeOfIso,
  formatDuration,
  formatElapsed,
  formatPrice,
  formatPricePair,
  formatRefreshed,
  formatTimeUntil,
  formatUsd,
  formatUsdExact,
  IN_THE_FUTURE,
  NO_TIME,
  optionalPaths,
  pricePhrase,
  shortId,
  SHORT_ID_CHARS,
  usdDecimal,
  withoutTrailingZeros,
} from './notation.js';

/** The micro-cents a shown USD amount stands for, read by an independent parser over BigInt (no float anywhere). */
function microcentsOfShown(text: string): bigint {
  const match = /^\$(\d+)(?:\.(\d{1,8}))?$/u.exec(text);
  if (match === null) throw new Error(`not a shown amount: ${text}`);
  return BigInt(match[1] ?? '0') * 100_000_000n + BigInt((match[2] ?? '').padEnd(8, '0'));
}

/** A small deterministic generator (mulberry32), so the property run is the same on every machine and every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Boundaries of the notation: the places a digit, a carry or the safe range changes. */
const BOUNDARIES: readonly number[] = [
  0,
  1,
  2,
  9,
  10,
  99,
  100,
  9_999,
  10_000,
  10_001,
  49_999,
  50_000,
  50_001,
  99_999,
  100_000,
  999_999,
  1_000_000,
  4_999_999,
  5_000_000,
  5_000_001,
  9_999_999,
  10_000_000,
  99_999_999,
  100_000_000,
  100_000_001,
  100_005_000,
  199_999_999,
  999_999_999,
  1_000_000_000,
  2 ** 31 - 1,
  2 ** 31,
  2 ** 31 + 1,
  2 ** 32,
  2 ** 40 + 12_345,
  10 ** 13,
  10 ** 13 + 1,
  10 ** 15 - 1,
  10 ** 15,
  Number.MAX_SAFE_INTEGER - 2,
  Number.MAX_SAFE_INTEGER - 1,
  Number.MAX_SAFE_INTEGER,
];

/** A few thousand amounts: every small one, every boundary, and seeded draws across every magnitude up to the safe limit. */
function sampleAmounts(): readonly number[] {
  const amounts = new Set<number>(BOUNDARIES);
  for (let value = 0; value <= 2_500; value += 1) amounts.add(value);
  for (let value = 99_990_000; value <= 100_010_000; value += 997) amounts.add(value);
  const next = generator(20_261_124);
  for (let draw = 0; draw < 2_500; draw += 1) {
    const magnitude = 10 ** Math.floor(next() * 16);
    amounts.add(Math.min(Number.MAX_SAFE_INTEGER, Math.floor(next() * magnitude)));
  }
  return [...amounts];
}

describe('formatUsd: an ordinary amount', () => {
  it('keeps the look of today: four fractional digits, rounded half up on the integer', () => {
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(5_000_000)).toBe('$0.0500'); // workflow-yaml-spec.md: 5_000_000 ≈ $0.05
    expect(formatUsd(100_000_000)).toBe('$1.0000');
    expect(formatUsd(123_456_789)).toBe('$1.2346');
    expect(formatUsd(123_454_999)).toBe('$1.2345');
    expect(formatUsd(5_000)).toBe('$0.0001'); // a half rounds up
    expect(formatUsd(4_999)).toBe('$0.0000');
  });

  it('carries a rounded-up fraction into the dollars', () => {
    expect(formatUsd(99_995_000)).toBe('$1.0000');
    expect(formatUsd(99_994_999)).toBe('$0.9999');
    expect(formatUsd(199_995_000)).toBe('$2.0000');
  });

  it('rounds an exact half the same way every time (a float toFixed moves it either way)', () => {
    // 0.00015 is 1.4999…e-4 as a double and rounds DOWN under toFixed(4); the integer is an exact half.
    expect(formatUsd(15_000)).toBe('$0.0002');
    expect((15_000 / 1e8).toFixed(4)).toBe('0.0001');
  });

  it('is unavailable for an amount it cannot show', () => {
    for (const value of [-1, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53, 1e300])
      expect(formatUsd(value), String(value)).toBe(AMOUNT_UNAVAILABLE);
  });
});

describe('formatUsdExact: the amount a person authorises, as it is held', () => {
  it('shows at least four and at most eight fractional digits, the zeros beyond the fourth trimmed', () => {
    const table: readonly (readonly [number, string])[] = [
      [0, '$0.0000'],
      [1, '$0.00000001'],
      [10, '$0.0000001'],
      [100, '$0.000001'],
      [10_000, '$0.0001'],
      [4_999_999, '$0.04999999'],
      [5_000_000, '$0.0500'],
      [5_000_001, '$0.05000001'],
      [5_000_100, '$0.050001'],
      [99_999_999, '$0.99999999'],
      [100_000_000, '$1.0000'],
      [100_000_001, '$1.00000001'],
      [2 ** 31, '$21.47483648'],
      [4_200_000, '$0.0420'],
      [Number.MAX_SAFE_INTEGER, '$90071992.54740991'],
    ];
    for (const [amount, shown] of table) expect(formatUsdExact(amount), String(amount)).toBe(shown);
  });

  it('never rounds: it differs from the ordinary look exactly where the ordinary look rounds', () => {
    expect(formatUsd(5_000_001)).toBe('$0.0500');
    expect(formatUsdExact(5_000_001)).toBe('$0.05000001');
    expect(formatUsd(4_999_999)).toBe('$0.0500');
    expect(formatUsdExact(4_999_999)).toBe('$0.04999999');
  });

  it('is unavailable for an amount it cannot show exactly, never a guess', () => {
    for (const value of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      1e21,
    ])
      expect(formatUsdExact(value), String(value)).toBe(AMOUNT_UNAVAILABLE);
  });

  it('shows an amount that, read back as micro-cents, is the amount it was given (a few thousand values)', () => {
    const amounts = sampleAmounts();
    expect(amounts.length).toBeGreaterThan(4_000);
    for (const amount of amounts) {
      const shown = formatUsdExact(amount);
      expect(microcentsOfShown(shown), `${amount} shown as ${shown}`).toBe(BigInt(amount));
      // At least four fractional digits and no trailing zero beyond the fourth.
      expect(shown, shown).toMatch(/^\$\d+\.\d{4}(?:\d{0,3}[1-9])?$/u);
    }
  });

  it('is the check that a float toFixed(4) cannot pass (the mutation this property exists to catch)', () => {
    const naive = (microcents: number): string => `$${(microcents / 1e8).toFixed(4)}`;
    const understated = sampleAmounts().filter(
      (amount) => microcentsOfShown(naive(amount)) < BigInt(amount),
    );
    const misread = sampleAmounts().filter(
      (amount) => microcentsOfShown(naive(amount)) !== BigInt(amount),
    );
    expect(understated.length).toBeGreaterThan(100); // a rounded-down amount authorises more than it says
    expect(misread.length).toBeGreaterThan(understated.length);
  });

  it('never understates what is authorised, at any amount', () => {
    for (const amount of sampleAmounts())
      expect(microcentsOfShown(formatUsdExact(amount)) >= BigInt(amount)).toBe(true);
  });
});

describe('prices: a per-million price and its digits', () => {
  it('reads $3 / $15 per M with every digit the price has and no trailing zero', () => {
    expect(formatPricePair(300_000_000, 1_500_000_000)).toBe('$3 / $15 per M');
    expect(formatPricePair(25_000_000, 125_000_000)).toBe('$0.25 / $1.25 per M');
    expect(formatPricePair(7_500_000, 43_500_000)).toBe('$0.075 / $0.435 per M');
    expect(formatPricePair(1, 100_000_001)).toBe('$0.00000001 / $1.00000001 per M');
    expect(formatPricePair(0, 0)).toBe('$0 / $0 per M');
  });

  it('writes the phrase after a price once: the digits are the caller’s and the words are the notation’s, and formatPrice is that phrase over an integer', () => {
    expect(pricePhrase('3')).toBe('$3 per M');
    expect(pricePhrase('0.04', 'image')).toBe('$0.04 per image');
    expect(pricePhrase('1e+30', 'M')).toBe('$1e+30 per M');
    for (const [microcents, unit] of [
      [300_000_000, 'M'],
      [4_000_000, 'image'],
      [100_000, 'second'],
    ] as const)
      expect(formatPrice(microcents, unit)).toBe(pricePhrase(usdDecimal(microcents), unit));
  });

  it('is one price per unit', () => {
    expect(formatPrice(300_000_000)).toBe('$3 per M');
    expect(formatPrice(4_000_000, 'image')).toBe('$0.04 per image');
    expect(formatPrice(100_000, 'second')).toBe('$0.001 per second');
    expect(usdDecimal(300_000_000)).toBe('3');
    expect(usdDecimal(3_000_000)).toBe('0.03');
  });

  it('is unavailable for a price it cannot show', () => {
    expect(formatPrice(-1)).toBe(AMOUNT_UNAVAILABLE);
    expect(formatPricePair(1.5, 3)).toBe(AMOUNT_UNAVAILABLE);
    expect(formatPricePair(3, Number.NaN)).toBe(AMOUNT_UNAVAILABLE);
  });

  it('shows every rate the shipped catalogue holds without losing a digit of it', () => {
    const rates: number[] = [];
    for (const model of Object.values(CATALOG_SNAPSHOT)) {
      rates.push(model.inputPerMtokMicrocents, model.outputPerMtokMicrocents);
      if (model.cachedInputPerMtokMicrocents !== undefined)
        rates.push(model.cachedInputPerMtokMicrocents);
      if (model.cacheWritePerMtokMicrocents !== undefined)
        rates.push(model.cacheWritePerMtokMicrocents);
    }
    expect(rates.length).toBeGreaterThan(200);
    for (const rate of rates) {
      const shown = usdDecimal(rate);
      expect(microcentsOfShown(`$${shown}`), `${rate} shown as ${shown}`).toBe(BigInt(rate));
      expect(shown, shown).not.toMatch(/\.\d*0$/u);
    }
    // A rate with a fractional-cent digit keeps its third digit (the old two-digit label showed $0.08 for $0.075). The catalogue's
    // input and output rates no longer need one (the picker's pair is two-digit at most), so the rates that do are read as the
    // single-rate label of the catalogue's cached and cache-write rates ($0.075 is the cached rate of several Gemini flash rows).
    const fractionalCent = rates
      .filter((rate) => rate % 1_000_000 !== 0)
      .map((rate) => formatPrice(rate));
    expect(fractionalCent.length).toBeGreaterThan(0);
    expect(fractionalCent).toContain('$0.075 per M');
    for (const label of fractionalCent) expect(label).toMatch(/^\$\d+\.\d{3,} per M$/u);
    const picker = Object.values(CATALOG_SNAPSHOT).map((model) =>
      formatPricePair(model.inputPerMtokMicrocents, model.outputPerMtokMicrocents),
    );
    for (const label of picker) expect(label).toMatch(/^\$[\d.]+ \/ \$[\d.]+ per M$/u);
  });
});

describe('withoutTrailingZeros', () => {
  it('drops only the final run of zeros, in linear time', () => {
    expect(withoutTrailingZeros('0500')).toBe('05');
    expect(withoutTrailingZeros('0000')).toBe('');
    expect(withoutTrailingZeros('')).toBe('');
    expect(withoutTrailingZeros('100')).toBe('1');
    const long = `1${'0'.repeat(200_000)}1`;
    expect(withoutTrailingZeros(long)).toBe(long);
  });
});

describe('time', () => {
  it('formatDuration: sub-second, second and minute scales', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(3200)).toBe('3.2s');
    expect(formatDuration(64_000)).toBe('1m04s');
  });

  it('formatDuration: carries a rounded-up 60s into the next minute (never "1m60s" or "60.0s")', () => {
    expect(formatDuration(119_600)).toBe('2m00s');
    expect(formatDuration(59_900)).toBe('59.9s');
    expect(formatDuration(59_950)).toBe('1m00s');
    expect(formatDuration(59_999)).toBe('1m00s');
    expect(formatDuration(60_000)).toBe('1m00s');
  });

  it('formatDuration: from one hour up it reads hours and minutes, never "60m00s" or a thousand minutes', () => {
    const HOUR_MS = 3_600_000;
    expect(formatDuration(HOUR_MS - 1000)).toBe('59m59s');
    expect(formatDuration(HOUR_MS - 501)).toBe('59m59s');
    expect(formatDuration(HOUR_MS - 500)).toBe('1h00m'); // 3599.5 s rounds to a whole hour and carries
    expect(formatDuration(HOUR_MS)).toBe('1h00m');
    expect(formatDuration(HOUR_MS + 59_000)).toBe('1h00m');
    expect(formatDuration(HOUR_MS + 60_000)).toBe('1h01m');
    expect(formatDuration(HOUR_MS + 61_000)).toBe('1h01m');
    expect(formatDuration(22 * HOUR_MS + 10 * 60_000 + 32_000)).toBe('22h10m');
    expect(formatDuration(24 * HOUR_MS)).toBe('24h00m'); // hours only: a day is not a unit here
    expect(formatDuration(100 * HOUR_MS)).toBe('100h00m');
  });

  it('formatDuration: clamps a negative duration (clock skew) to zero', () => {
    expect(formatDuration(-5)).toBe('0ms');
  });

  it('formatDuration: a span that rounds to a whole second reads in seconds, never "1000ms"', () => {
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(999.4)).toBe('999ms');
    expect(formatDuration(999.5)).toBe('1.0s');
    expect(formatDuration(999.6)).toBe('1.0s');
    expect(formatDuration(999.999)).toBe('1.0s');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1049)).toBe('1.0s');
    expect(formatDuration(1050)).toBe('1.1s');
  });

  it('formatDuration: a number that is not finite is a clock fault and clamps to zero, never NaNmNaNs', () => {
    expect(formatDuration(Number.NaN)).toBe('0ms');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('0ms');
  });

  it('formatElapsed: whole seconds under a minute, floored so a live counter never reads ahead', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(3200)).toBe('3s');
    expect(formatElapsed(3999)).toBe('3s');
    expect(formatElapsed(59_000)).toBe('59s');
  });

  it('formatElapsed: rolls into m/ss at a minute, clamps a negative and guards a non-finite input', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(63_000)).toBe('1m03s');
    expect(formatElapsed(600_000)).toBe('10m00s');
    expect(formatElapsed(3_599_999)).toBe('59m59s');
    expect(formatElapsed(-5000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
  });

  it('formatElapsed: from one hour up it reads hours and minutes (a live timer once read 1330m32s)', () => {
    expect(formatElapsed(3_600_000)).toBe('1h00m');
    expect(formatElapsed(3_659_999)).toBe('1h00m');
    expect(formatElapsed(3_660_000)).toBe('1h01m');
    expect(formatElapsed(79_832_000)).toBe('22h10m'); // the 1330m32s of the report
    expect(formatElapsed(24 * 3_600_000)).toBe('24h00m');
  });

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('formatAge: one spelling of "ago", each unit starting exactly at its boundary and rounding down', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(MINUTE - 1)).toBe('just now');
    expect(formatAge(MINUTE)).toBe('1m ago');
    expect(formatAge(5 * MINUTE + 59_999)).toBe('5m ago');
    expect(formatAge(HOUR - 1)).toBe('59m ago');
    expect(formatAge(HOUR)).toBe('1h ago');
    expect(formatAge(DAY - 1)).toBe('23h ago');
    expect(formatAge(DAY)).toBe('1d ago');
    expect(formatAge(DAY + 13 * HOUR)).toBe('1d ago');
    expect(formatAge(2 * DAY - 1)).toBe('1d ago');
    expect(formatAge(400 * DAY)).toBe('400d ago');
  });

  it('formatAge and formatTimeUntil: a number that is not finite is no time at all (NO_TIME), never "NaNd ago" or "in NaNd"', () => {
    expect(NO_TIME).toBe('');
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatAge(value), String(value)).toBe(NO_TIME);
      expect(formatTimeUntil(value), String(value)).toBe(NO_TIME);
    }
    expect(formatRefreshed(Number.NaN, 5 * MINUTE)).toBe('never refreshed');
    expect(formatRefreshed(0, Number.NaN)).toBe('never refreshed');
  });

  it('formatAge: a stamp up to one minute ahead is skew; more than that is not an age', () => {
    expect(formatAge(-30_000)).toBe('just now');
    expect(formatAge(-MINUTE)).toBe('just now');
    expect(formatAge(-MINUTE - 1)).toBe(IN_THE_FUTURE);
    expect(formatAge(-10 * DAY)).toBe(IN_THE_FUTURE);
  });

  it('formatAgeOfIso: the age of an ISO stamp, empty for one that is not a time', () => {
    const now = Date.parse('2026-11-24T12:00:00.000Z');
    expect(formatAgeOfIso('2026-11-24T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatAgeOfIso('2026-11-24T12:00:30.000Z', now)).toBe('just now');
    expect(formatAgeOfIso('not a time', now)).toBe('');
    expect(formatAgeOfIso('', now)).toBe('');
  });

  it('formatTimeUntil: the forward-looking counterpart, never "in 0s"', () => {
    expect(formatTimeUntil(0)).toBe('in 1s');
    expect(formatTimeUntil(500)).toBe('in 1s');
    expect(formatTimeUntil(30_000)).toBe('in 30s');
    expect(formatTimeUntil(59_999)).toBe('in 59s');
    expect(formatTimeUntil(MINUTE)).toBe('in 1m');
    expect(formatTimeUntil(5 * MINUTE)).toBe('in 5m');
    expect(formatTimeUntil(2 * HOUR)).toBe('in 2h');
    expect(formatTimeUntil(3 * DAY)).toBe('in 3d');
  });

  it('formatTimeUntil: a time that has passed reads as the age it is, the words of formatAge, never "in 1s"', () => {
    expect(formatTimeUntil(-5)).toBe('just now');
    expect(formatTimeUntil(-(MINUTE - 1))).toBe('just now');
    expect(formatTimeUntil(-MINUTE)).toBe('1m ago');
    expect(formatTimeUntil(-2 * HOUR)).toBe('2h ago');
    expect(formatTimeUntil(-3 * DAY)).toBe('3d ago');
    for (const ms of [5, 59_999, MINUTE, HOUR, DAY, 400 * DAY])
      expect(formatTimeUntil(-ms), String(ms)).toBe(formatAge(ms));
    // the edge between the two: nothing left is still "in 1s", a negative nothing is the past
    expect(formatTimeUntil(0)).toBe('in 1s');
    expect(formatTimeUntil(-0)).toBe('in 1s');
    expect(formatTimeUntil(-1)).toBe('just now');
  });

  it('formatRefreshed: the same ages, under "updated", and "never refreshed" for none', () => {
    expect(formatRefreshed(undefined, 1_000_000)).toBe('never refreshed');
    expect(formatRefreshed(1_000_000, 1_000_000)).toBe('updated just now');
    expect(formatRefreshed(0, 5 * MINUTE)).toBe('updated 5m ago');
    expect(formatRefreshed(0, 3 * HOUR)).toBe('updated 3h ago');
    expect(formatRefreshed(0, 2 * DAY)).toBe('updated 2d ago');
    expect(formatRefreshed(2_000_000, 1_000_000)).toBe(`updated ${IN_THE_FUTURE}`);
  });
});

describe('shortId', () => {
  it('keeps the first eight characters, whole code points, and the cost does not grow with the input', () => {
    expect(SHORT_ID_CHARS).toBe(8);
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('');
    expect(shortId('😀'.repeat(20))).toBe('😀'.repeat(8));
    expect(shortId(`ab${'😀'.repeat(20)}`)).toBe(`ab${'😀'.repeat(6)}`);
    expect(shortId('x'.repeat(5_000_000))).toBe('x'.repeat(8));
  });

  it('reads at most the code points it keeps (twice over, for a surrogate pair) of a 5 MB id: counted through the string iterator', () => {
    const huge = 'x'.repeat(5_000_000);
    const original = String.prototype[Symbol.iterator];
    let yielded = 0;
    Object.defineProperty(String.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function* counting(this: string): Generator<string> {
        for (const character of original.call(this)) {
          yielded += 1;
          yield character;
        }
      },
    });
    let cut: string;
    try {
      yielded = 0;
      cut = shortId(huge);
    } finally {
      Object.defineProperty(String.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: original,
      });
    }
    expect(cut).toBe('xxxxxxxx');
    // an implementation that walks the whole id would yield five million; the bound is its own slice
    expect(yielded).toBeLessThanOrEqual(SHORT_ID_CHARS * 2);
    expect(yielded).toBeGreaterThan(0);
  });
});

describe('displayPath', () => {
  const roots = { cwd: '/home/ada/work/app', home: '/home/ada' };

  it('is project-relative inside the project, without a leading ./', () => {
    expect(displayPath('/home/ada/work/app/src/app.ts', roots)).toBe('src/app.ts');
    expect(displayPath('/home/ada/work/app', roots)).toBe('.');
    expect(displayPath('/home/ada/work/app/', roots)).toBe('.');
    expect(displayPath('/home/ada/work/app/src/', roots)).toBe('src/');
    expect(displayPath('/home/ada/work/app//src///app.ts', roots)).toBe('src/app.ts');
  });

  it('is from ~ inside the home and outside the project', () => {
    expect(displayPath('/home/ada/notes/todo.md', roots)).toBe('~/notes/todo.md');
    expect(displayPath('/home/ada', roots)).toBe('~');
    expect(displayPath('/home/ada/', roots)).toBe('~');
    expect(displayPath('/home/ada/work/other', roots)).toBe('~/work/other');
  });

  it('keeps the absolute path outside both: it cannot be shortened without hiding where it is', () => {
    expect(displayPath('/etc/hosts', roots)).toBe('/etc/hosts');
    expect(displayPath('/home/adam/x', roots)).toBe('/home/adam/x'); // a sibling that shares a prefix is not inside
    expect(displayPath('/home/ada/work/app-two/x', roots)).toBe('~/work/app-two/x');
    expect(displayPath('/home', roots)).toBe('/home');
  });

  it('is not fooled by a path that climbs out of the directory it starts in', () => {
    expect(displayPath('/home/ada/work/app/../secret', roots)).toBe('/home/ada/work/app/../secret');
    expect(displayPath('/home/ada/../../etc/passwd', roots)).toBe('/home/ada/../../etc/passwd');
    expect(displayPath('/home/ada/work/app/./src', roots)).toBe('/home/ada/work/app/./src');
    expect(displayPath('/x', { cwd: '/home/ada/..', home: '/home/ada/..' })).toBe('/x');
  });

  it('shortens nothing against a root that holds a dot segment: it names a place only after it is resolved, and the text cannot say which', () => {
    expect(
      displayPath('/work/../work/proj/x', { cwd: '/work/../work/proj', home: undefined }),
    ).toBe('/work/../work/proj/x');
    expect(displayPath('/work/./proj/x', { cwd: '/work/./proj', home: undefined })).toBe(
      '/work/./proj/x',
    );
    expect(displayPath('/work/../me/x', { cwd: undefined, home: '/work/../me' })).toBe(
      '/work/../me/x',
    );
    // the plain root beside it still shortens: the dot segment is the root's, not the target's
    expect(displayPath('/work/proj/x', { cwd: '/work/../work/proj', home: '/work' })).toBe(
      '~/proj/x',
    );
  });

  it('shortens nothing against a filesystem root', () => {
    expect(displayPath('/etc/hosts', { cwd: '/', home: '/' })).toBe('/etc/hosts');
  });

  it('returns a relative path without its leading ./ and leaves ~ forms alone', () => {
    expect(displayPath('./src/app.ts', roots)).toBe('src/app.ts');
    expect(displayPath('././a', roots)).toBe('a');
    expect(displayPath('src/app.ts', roots)).toBe('src/app.ts');
    expect(displayPath('~/notes', roots)).toBe('~/notes');
    expect(displayPath('', roots)).toBe('');
  });

  it('reads a backslash as a name on POSIX', () => {
    expect(displayPath('/home/ada/work/app/a\\b', roots)).toBe('a\\b');
  });

  it('works with no home and no project', () => {
    expect(displayPath('/home/ada/x', { cwd: undefined, home: undefined })).toBe('/home/ada/x');
    expect(displayPath('/home/ada/x', { cwd: '', home: '' })).toBe('/home/ada/x');
    expect(displayPath('/home/ada/x', { cwd: undefined, home: '/home/ada' })).toBe('~/x');
  });

  describe('on Windows', () => {
    const win = {
      cwd: 'C:\\Users\\Ada\\work\\app',
      home: 'C:\\Users\\Ada',
      win32: true,
    } as const;

    it('shortens a backslash path with the separator the input used', () => {
      expect(displayPath('C:\\Users\\Ada\\work\\app\\src\\app.ts', win)).toBe('src\\app.ts');
      expect(displayPath('C:\\Users\\Ada\\notes\\todo.md', win)).toBe('~\\notes\\todo.md');
      expect(displayPath('C:\\Users\\Ada\\work\\app', win)).toBe('.');
      expect(displayPath('C:\\Users\\Ada', win)).toBe('~');
      expect(displayPath('C:\\Users\\Ada\\work\\app\\src\\', win)).toBe('src\\');
    });

    it('accepts forward slashes and keeps them', () => {
      expect(displayPath('C:/Users/Ada/work/app/src/app.ts', win)).toBe('src/app.ts');
      expect(displayPath('C:/Users/Ada/notes', win)).toBe('~/notes');
    });

    it('compares names and the drive letter ignoring case, and keeps the case of what it shows', () => {
      expect(displayPath('c:\\users\\ada\\WORK\\APP\\Src\\App.ts', win)).toBe('Src\\App.ts');
      expect(displayPath('C:\\USERS\\ADA\\Notes', win)).toBe('~\\Notes');
    });

    it('leaves another drive, a UNC path and a path that merely shares a prefix as they are', () => {
      expect(displayPath('D:\\Users\\Ada\\notes', win)).toBe('D:\\Users\\Ada\\notes');
      expect(displayPath('\\\\server\\share\\Users\\Ada\\x', win)).toBe(
        '\\\\server\\share\\Users\\Ada\\x',
      );
      expect(displayPath('C:\\Users\\Adam\\x', win)).toBe('C:\\Users\\Adam\\x');
      expect(displayPath('C:\\Users\\Ada\\work\\app\\..\\x', win)).toBe(
        'C:\\Users\\Ada\\work\\app\\..\\x',
      );
    });

    it('folds the case of ASCII letters only: a Kelvin sign or an Angstrom sign is not a k or an a-ring, and a mismatch shows the whole path', () => {
      // `toLowerCase` reads U+212A as `k` and U+212B as `å`, so a folder that only LOOKS like the home would have been taken for it
      expect(
        displayPath('C:\\Users\\\u212Au\\a', {
          cwd: undefined,
          home: 'C:\\Users\\ku',
          win32: true,
        }),
      ).toBe('C:\\Users\\\u212Au\\a');
      expect(
        displayPath('C:\\Users\\\u212Bx\\a', {
          cwd: 'C:\\Users\\\u00E5x',
          home: undefined,
          win32: true,
        }),
      ).toBe('C:\\Users\\\u212Bx\\a');
      // the same letters in ASCII are the same name in any case
      expect(
        displayPath('C:\\Users\\Ku\\a', { cwd: undefined, home: 'C:\\Users\\kU', win32: true }),
      ).toBe('~\\a');
      // other letters are compared exactly: a different case of a non-ASCII letter is another name (the failure is the safe one)
      expect(
        displayPath('C:\\Users\\\u00C9\\a', {
          cwd: 'C:\\Users\\\u00E9',
          home: undefined,
          win32: true,
        }),
      ).toBe('C:\\Users\\\u00C9\\a');
    });

    it('keeps a UNC root, a single-slash path and a drive-less root apart: only the same root shortens', () => {
      const unc = { cwd: '\\\\srv\\share\\proj', home: undefined, win32: true } as const;
      // a UNC root and a path that starts with a single slash are not the same root, though the names after them are
      expect(displayPath('/srv/share/proj/x', unc)).toBe('/srv/share/proj/x');
      expect(displayPath('\\srv\\share\\proj\\x', unc)).toBe('\\srv\\share\\proj\\x');
      // the UNC path against the UNC root is shortened, and `//` is the same root as `\\`
      expect(displayPath('\\\\srv\\share\\proj\\x', unc)).toBe('x');
      expect(displayPath('//srv/share/proj/x', unc)).toBe('x');
      // a drive-less rooted path is read as an absolute one (on the current drive): it shortens against a drive-less root, not against a drive
      const rooted = { cwd: '\\work\\proj', home: undefined, win32: true } as const;
      expect(displayPath('\\work\\proj\\x', rooted)).toBe('x');
      expect(displayPath('/work/proj/x', rooted)).toBe('x');
      expect(
        displayPath('\\work\\proj\\x', { cwd: 'C:\\work\\proj', home: undefined, win32: true }),
      ).toBe('\\work\\proj\\x');
      expect(displayPath('C:\\work\\proj\\x', rooted)).toBe('C:\\work\\proj\\x');
    });

    it('does not read a drive-relative path (`C:name`) as an absolute one, in either place', () => {
      const roots = { cwd: 'C:\\o', home: undefined, win32: true } as const;
      expect(displayPath('C:xo\\file', roots)).toBe('C:xo\\file');
      expect(displayPath('C:o\\file', roots)).toBe('C:o\\file');
      // and a root written that way names nothing to shorten against
      expect(displayPath('C:\\o\\file', { cwd: 'C:o', home: undefined, win32: true })).toBe(
        'C:\\o\\file',
      );
    });

    it('does not treat case as the same name on POSIX', () => {
      expect(displayPath('/HOME/ADA/x', { cwd: undefined, home: '/home/ada' })).toBe('/HOME/ADA/x');
    });

    it('shows a drive root path whole, and a relative path without its leading .\\', () => {
      expect(displayPath('C:\\', { cwd: 'C:\\', home: 'C:\\', win32: true })).toBe('C:\\');
      expect(displayPath('.\\src\\a.ts', win)).toBe('src\\a.ts');
    });

    it('never shows a project folder named `~` as the home: it keeps its `.\\` (or `./`, the separator the input used)', () => {
      expect(displayPath('C:\\Users\\Ada\\work\\app\\~\\x.yaml', win)).toBe('.\\~\\x.yaml');
      expect(displayPath('C:\\Users\\Ada\\work\\app\\~bob\\x', win)).toBe('.\\~bob\\x');
      expect(displayPath('C:/Users/Ada/work/app/~/x.yaml', win)).toBe('./~/x.yaml');
      expect(displayPath('C:\\Users\\Ada\\work\\app\\a\\~\\x', win)).toBe('a\\~\\x');
      // the home itself is still the home
      expect(displayPath('C:\\Users\\Ada\\~\\x', win)).toBe('~\\~\\x');
      expect(displayPath('.\\~\\x', win)).toBe('.\\~\\x');
      expect(displayPath('.\\', win)).toBe('.');
      expect(displayPath('.\\\\a', win)).toBe('a');
    });
  });

  it('never shows a project folder named `~` or `~name` as the home: a path under <project>/~ keeps its ./', () => {
    expect(displayPath('/home/ada/work/app/~/x.yaml', roots)).toBe('./~/x.yaml');
    expect(displayPath('/home/ada/work/app/~', roots)).toBe('./~');
    expect(displayPath('/home/ada/work/app/~/', roots)).toBe('./~/');
    expect(displayPath('/home/ada/work/app/~bob/x', roots)).toBe('./~bob/x');
    expect(displayPath('/home/ada/work/app/~.bak', roots)).toBe('./~.bak');
    // a `~` that is not the first name is not confusable, and stays as it is
    expect(displayPath('/home/ada/work/app/a/~/x.yaml', roots)).toBe('a/~/x.yaml');
    // the home and a `~` folder INSIDE the home are the home's: `~/~/x` is the second one, read once
    expect(displayPath('/home/ada/~/x.yaml', roots)).toBe('~/~/x.yaml');
    // when the project IS the home, a `~` folder of it is still not the home
    expect(displayPath('/home/ada/~/x.yaml', { cwd: '/home/ada', home: '/home/ada' })).toBe(
      './~/x.yaml',
    );
  });

  it('reads `./` as the project, never as an empty string, and never turns `.//a` into the absolute `/a`', () => {
    expect(displayPath('./', roots)).toBe('.');
    expect(displayPath('.//', roots)).toBe('.');
    expect(displayPath('././', roots)).toBe('.');
    expect(displayPath('.//a', roots)).toBe('a');
    expect(displayPath('././/a/b', roots)).toBe('a/b');
    expect(displayPath('.', roots)).toBe('.');
    expect(displayPath('..', roots)).toBe('..');
    expect(displayPath('../a', roots)).toBe('../a');
    expect(displayPath('', roots)).toBe('');
  });

  it('keeps the `./` of a relative path that would otherwise start with `~`, and leaves a given `~` form alone', () => {
    expect(displayPath('./~/x', roots)).toBe('./~/x');
    expect(displayPath('././~bob', roots)).toBe('./~bob');
    expect(displayPath('~/x', roots)).toBe('~/x');
    expect(displayPath('~bob/x', roots)).toBe('~bob/x');
  });
});

/**
 * The oracle `node:path` gives: whatever `displayPath` shows, read the way a person reads it (relative to the project, `~` as the home,
 * anything else as it is), names the SAME file as the path that went in. A seeded fuzz over folder names that are hostile to the
 * shortening (`~`, `~x`, `.`, `..`, repeated separators, other case on Windows).
 */
describe('displayPath: what is shown names the file that went in (a node:path oracle)', () => {
  const NAMES = ['a', 'b', 'src', '~', '~x', '.', '..', 'A', 'x y', '~.bak'] as const;

  interface Flavour {
    readonly name: string;
    readonly win32: boolean;
    /** Resolves like the platform, and compares in the way its filesystem names compare. */
    readonly resolve: (...paths: string[]) => string;
    readonly roots: readonly string[];
    readonly separators: readonly string[];
  }

  const FLAVOURS: readonly Flavour[] = [
    {
      name: 'posix',
      win32: false,
      resolve: (...paths) => posix.resolve(...paths),
      // a root with a dot segment shortens nothing, and a path that climbs out of one must never read as inside it
      roots: ['/home/ada', '/home/ada/work/app', '/srv', '/', '/home/ada/../ada/work'],
      separators: ['/', '//', '///'],
    },
    {
      name: 'win32',
      win32: true,
      resolve: (...paths) => win32.resolve(...paths).toLowerCase(),
      // a UNC root (the backslash and the slash spelling) and a root with no drive are roots of their own
      roots: [
        'C:\\Users\\Ada',
        'C:\\Users\\Ada\\work\\app',
        'D:\\data',
        'c:/Users/Ada',
        '\\\\srv\\share\\Ada\\work',
        '//srv/share/Ada',
        '\\Users\\Ada',
        'C:\\Users\\Ada\\..\\Ada\\work',
      ],
      separators: ['\\', '/', '\\\\', '/\\'],
    },
  ];

  /** What a person reads a shown path as, against the project and the home: the path it names, or `undefined` when it reads as neither. */
  function reading(shown: string, cwd: string, home: string, flavour: Flavour): string {
    const rest = /^~(?:[\\/]+(.*))?$/su.exec(shown);
    if (rest !== null) return flavour.resolve(home, rest[1] ?? '.');
    if (shown.startsWith('~')) return `a home that belongs to somebody else: ${shown}`;
    return flavour.resolve(cwd, shown);
  }

  function pick<T>(next: () => number, items: readonly T[]): T {
    return items[Math.floor(next() * items.length)] as T;
  }

  /** A path under `base` (or not): names joined with the flavour's separators, sometimes repeated. */
  function pathUnder(base: string, next: () => number, flavour: Flavour): string {
    const count = Math.floor(next() * 4);
    const names = Array.from({ length: count }, () => pick(next, NAMES));
    const trailing = next() < 0.2 ? pick(next, flavour.separators) : '';
    const root = base.replace(/[\\/]+$/u, '');
    return `${root}${names.map((name) => `${pick(next, flavour.separators)}${name}`).join('')}${trailing}`;
  }

  for (const flavour of FLAVOURS) {
    it(`${flavour.name}: 4,000 seeded cases, every shown path reads back as the file that went in`, () => {
      const next = generator(flavour.win32 ? 24_112_026 : 11_242_026);
      let shortened = 0;
      let home = 0;
      let confusable = 0;
      for (let draw = 0; draw < 4000; draw += 1) {
        const cwd = pick(next, flavour.roots);
        const homeDir = pick(next, flavour.roots);
        const base = pick(next, [cwd, cwd, homeDir, pick(next, flavour.roots)]);
        const target = pathUnder(
          flavour.win32 && next() < 0.3 ? base.toUpperCase() : base,
          next,
          flavour,
        );
        const shown = displayPath(target, { cwd, home: homeDir, win32: flavour.win32 });
        if (shown === target) continue;
        shortened += 1;
        if (shown.startsWith('~')) home += 1;
        if (/(^|[\\/])~/u.test(shown) && !shown.startsWith('~')) confusable += 1;
        expect(
          reading(shown, cwd, homeDir, flavour),
          `${JSON.stringify({ target, shown, cwd, home: homeDir })}`,
        ).toBe(flavour.resolve(target));
      }
      // the draw is not vacuous: many were shortened, both ways, and a fair share held a `~` name that must not be mistaken for the home
      expect(shortened).toBeGreaterThan(1000);
      expect(home).toBeGreaterThan(100);
      expect(confusable).toBeGreaterThan(20);
    });

    it(`${flavour.name}: a relative path with leading dots reads back as the same file`, () => {
      const next = generator(flavour.win32 ? 77 : 78);
      const cwd = flavour.roots[1] ?? '/';
      for (let draw = 0; draw < 1500; draw += 1) {
        const dots = Array.from(
          { length: 1 + Math.floor(next() * 3) },
          () => `.${pick(next, flavour.separators)}`,
        ).join('');
        const rest = pathUnder('', next, flavour).replace(/^[\\/]+/u, '');
        const given = `${dots}${rest}`;
        const shown = displayPath(given, { cwd, home: flavour.roots[0], win32: flavour.win32 });
        if (/(^|[\\/])\.\.([\\/]|$)/u.test(given)) continue;
        expect(
          reading(shown, cwd, flavour.roots[0] ?? '/', flavour),
          JSON.stringify({ given, shown }),
        ).toBe(flavour.resolve(cwd, given));
      }
    });
  }
});

describe('optionalPaths', () => {
  it('is the roots under `paths` when there are some, and nothing at all when there are none', () => {
    const roots = { cwd: '/work/app', home: '/home/ada' };
    expect(optionalPaths(roots)).toEqual({ paths: roots });
    expect(optionalPaths(roots).paths).toBe(roots);
    // nothing: not a `paths: undefined`, which a model that says `paths?: DisplayPathRoots` refuses
    expect(optionalPaths(undefined)).toEqual({});
    expect('paths' in optionalPaths(undefined)).toBe(false);
  });
});

describe('dates and clock times', () => {
  it('reads an ISO timestamp as a UTC date, a 24-hour clock time, and both with the zone said', () => {
    expect(formatDate('2026-11-24T09:05:59.999Z')).toBe('2026-11-24');
    expect(formatClock('2026-11-24T09:05:59.999Z')).toBe('09:05');
    expect(formatClock('2026-11-24T23:59:00.000Z')).toBe('23:59');
    expect(formatClock('2026-11-24T00:00:00.000Z')).toBe('00:00');
    expect(formatDateTime('2026-11-24T09:05:59.999Z')).toBe('2026-11-24 09:05 UTC');
    // Near a midnight a local clock would read another day on most machines: the notation is UTC wherever the machine is.
    expect(formatDateTime('2026-11-24T23:30:00.000Z')).toBe('2026-11-24 23:30 UTC');
    expect(formatDateTime('2026-12-31T23:59:59.999Z')).toBe('2026-12-31 23:59 UTC');
    expect(formatDateTime('2027-01-01T00:00:00.000Z')).toBe('2027-01-01 00:00 UTC');
  });

  it('converts a stamp written with an offset to UTC, so one moment has one spelling', () => {
    expect(formatDateTime('2026-11-24T01:30:00+03:00')).toBe('2026-11-23 22:30 UTC');
  });

  it('is empty for a text that is not a time, and for a year outside four digits', () => {
    for (const text of [
      '',
      'not a time',
      '2026-13-45',
      '+275760-09-13T00:00:00.000Z',
      '-000001-06-01T00:00:00.000Z',
      '+010000-01-01T00:00:00.000Z',
    ])
      expect(formatDateTime(text), text).toBe('');
    // the first and the last year of four digits are dates
    expect(formatDate('0000-01-01T00:00:00.000Z')).toBe('0000-01-01');
    expect(formatDate('9999-12-31T23:59:59.999Z')).toBe('9999-12-31');
    expect(formatDate('not a time')).toBe('');
    expect(formatClock('not a time')).toBe('');
  });
});
