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
    // The label of a model whose price needs three digits keeps them (the old two-digit label showed $0.08 for $0.075).
    const picker = Object.values(CATALOG_SNAPSHOT).map((model) =>
      formatPricePair(model.inputPerMtokMicrocents, model.outputPerMtokMicrocents),
    );
    expect(picker.some((label) => label.includes('$0.075'))).toBe(true);
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

  it('formatDuration: clamps a negative duration (clock skew) to zero', () => {
    expect(formatDuration(-5)).toBe('0ms');
  });

  it('formatElapsed: whole seconds under a minute, floored so a live counter never reads ahead', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(3200)).toBe('3s');
    expect(formatElapsed(59_000)).toBe('59s');
  });

  it('formatElapsed: rolls into m/ss at a minute, clamps a negative and guards a non-finite input', () => {
    expect(formatElapsed(60_000)).toBe('1m00s');
    expect(formatElapsed(63_000)).toBe('1m03s');
    expect(formatElapsed(600_000)).toBe('10m00s');
    expect(formatElapsed(-5000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s');
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
    expect(formatAge(400 * DAY)).toBe('400d ago');
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
    expect(formatTimeUntil(5 * MINUTE)).toBe('in 5m');
    expect(formatTimeUntil(2 * HOUR)).toBe('in 2h');
    expect(formatTimeUntil(3 * DAY)).toBe('in 3d');
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

    it('does not treat case as the same name on POSIX', () => {
      expect(displayPath('/HOME/ADA/x', { cwd: undefined, home: '/home/ada' })).toBe('/HOME/ADA/x');
    });

    it('shows a drive root path whole, and a relative path without its leading .\\', () => {
      expect(displayPath('C:\\', { cwd: 'C:\\', home: 'C:\\', win32: true })).toBe('C:\\');
      expect(displayPath('.\\src\\a.ts', win)).toBe('src\\a.ts');
    });
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
    for (const text of ['', 'not a time', '2026-13-45', '+275760-09-13T00:00:00.000Z'])
      expect(formatDateTime(text), text).toBe('');
    expect(formatDate('not a time')).toBe('');
    expect(formatClock('not a time')).toBe('');
  });
});
