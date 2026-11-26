/**
 * One notation for money, time, identifiers and paths ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §8,
 * MVP-11 Step 3). A CLI data module: it imports nothing from `ink`, `react` or `node:` (a lint rule holds it to that), so every
 * function is pure and a surface that wants a path or a clock passes it in.
 *
 * - **Money** in human text is USD. A micro-cent is 1e-8 USD, so an exact amount has at most eight fractional digits; every function
 *   here does its arithmetic on the integer (a remainder and a quotient of safe integers, never a float division or `toFixed`), and
 *   an amount it cannot show exactly is `unavailable`, never a guess. Three notations exist and no more: a USD amount ({@link formatUsd},
 *   {@link formatUsdExact}), a per-million price ({@link formatPrice}, {@link formatPricePair}) and raw micro-cents, which appear only in
 *   machine output and in the one flag that takes them.
 * - **Time**: a completed duration, a live elapsed counter, a relative age and the forward-looking counterpart.
 * - **Identifiers**: one cut for a run id on a surface that only labels it ({@link shortId}).
 * - **Paths**: project-relative, or from `~`, or as they were given ({@link displayPath}); the working directory as one short label
 *   ({@link directoryLabel}).
 */

import { displayWidth, sliceDisplayColumns } from './tui/viewport.js';

/** USD × 100,000,000: the canonical integer unit of money ([database-schema.md](../../../../docs/reference/shared-core/database-schema.md)). */
export const MICROCENTS_PER_USD = 100_000_000;

/** What an amount that cannot be shown exactly says. It is never a number: a guess at money is worse than none. */
export const AMOUNT_UNAVAILABLE = 'unavailable';

const DISPLAY_DIGITS = 4;
const STORED_DIGITS = 8;
/** Micro-cents in one unit of the fourth fractional digit (`1e-4` USD). */
const DISPLAY_STEP = MICROCENTS_PER_USD / 10 ** DISPLAY_DIGITS;

/** A whole number of micro-cents a person may be told about: a non-negative safe integer, so every figure below is exact. */
const isAmount = (microcents: number): boolean =>
  Number.isSafeInteger(microcents) && microcents >= 0;

/**
 * `text` without its final run of `0` characters. A loop, not `/0+$/`: that pattern retries from every `0` of a long run that is not at
 * the end, which is quadratic in the run's length (SonarCloud S8786). Linear in the text, whatever it holds.
 */
export function withoutTrailingZeros(text: string): string {
  let end = text.length;
  while (end > 0 && text.codePointAt(end - 1) === 0x30) end -= 1;
  return text.slice(0, end);
}

/**
 * Whole dollars and the fraction of an amount, as a number and as its eight digits. The remainder of a safe integer is exact, and the
 * quotient of an exact multiple of 1e8 is exact, so no float division can move a digit (a plain `amount / 1e8` is off by up to one
 * micro-cent near the top of the safe range).
 */
function split(microcents: number): {
  readonly whole: number;
  readonly fraction: number;
  readonly digits: string;
} {
  const fraction = microcents % MICROCENTS_PER_USD;
  return {
    whole: (microcents - fraction) / MICROCENTS_PER_USD,
    fraction,
    digits: String(fraction).padStart(STORED_DIGITS, '0'),
  };
}

/**
 * An ordinary amount (a run's or a session's cost): `$0.1235`, four fractional digits, rounded half up on the integer. This is for a
 * figure that was spent; an amount a person is asked to authorise, a cap, or a hold uses {@link formatUsdExact}, which never rounds.
 */
export function formatUsd(microcents: number): string {
  if (!isAmount(microcents)) return AMOUNT_UNAVAILABLE;
  const { whole, fraction } = split(microcents);
  const remainder = fraction % DISPLAY_STEP;
  const ticks = (fraction - remainder) / DISPLAY_STEP + (remainder * 2 >= DISPLAY_STEP ? 1 : 0);
  // Rounding up from .99995 carries into the dollars (a tick count of 10^4 is one whole dollar).
  const carry = ticks === 10 ** DISPLAY_DIGITS;
  return `$${carry ? whole + 1 : whole}.${String(carry ? 0 : ticks).padStart(DISPLAY_DIGITS, '0')}`;
}

/**
 * An amount exactly as it is held: at least four fractional digits and up to eight, the zeros beyond the fourth trimmed (`$0.0500`,
 * `$0.05000001`). Display rounding must never understate an amount that is being authorised, capped or held, so this one never
 * rounds: the text read back as micro-cents is the integer that went in. An amount it cannot show exactly (negative, fractional, not a
 * safe integer) is {@link AMOUNT_UNAVAILABLE}.
 */
export function formatUsdExact(microcents: number): string {
  if (!isAmount(microcents)) return AMOUNT_UNAVAILABLE;
  const { whole, digits } = split(microcents);
  return `$${whole}.${digits.slice(0, DISPLAY_DIGITS)}${withoutTrailingZeros(digits.slice(DISPLAY_DIGITS))}`;
}

/**
 * An amount as an exact decimal with no symbol and no padding (`300000000` → `3`, `7500000` → `0.075`, `1` → `0.00000001`), never in
 * exponent form: the digits of a price, which keeps every digit it has and none it does not.
 */
export function usdDecimal(microcents: number): string {
  if (!isAmount(microcents)) return AMOUNT_UNAVAILABLE;
  const { whole, digits } = split(microcents);
  const trimmed = withoutTrailingZeros(digits);
  return trimmed === '' ? String(whole) : `${whole}.${trimmed}`;
}

/** What a price is quoted per: a million tokens, or one billed media unit. */
export type PriceUnit = 'M' | 'image' | 'second';

/**
 * One price whose digits are already written (`3` is `$3 per M`): the one place the words "per M", "per image" and "per second" are put
 * after a price. {@link formatPrice} is this over a stored integer; a caller that holds a figure of its own (a ceiling, a number the person
 * typed and a sentence that quotes it back) writes its digits and asks for the phrase here, so no sentence spells a price another way
 * (`per million tokens`, `per unit`).
 */
export function pricePhrase(usdDigits: string, unit: PriceUnit = 'M'): string {
  return `$${usdDigits} per ${unit}`;
}

/** One price: `$3 per M`, `$0.04 per image`, `$0.001 per second`. Every digit the stored integer has, and no trailing zero. */
export function formatPrice(microcents: number, unit: PriceUnit = 'M'): string {
  const amount = usdDecimal(microcents);
  return amount === AMOUNT_UNAVAILABLE ? amount : pricePhrase(amount, unit);
}

/** A model's input and output price together: `$3 / $15 per M` (input first). A column that shows it says what the two are. */
export function formatPricePair(inputMicrocents: number, outputMicrocents: number): string {
  const input = usdDecimal(inputMicrocents);
  const output = usdDecimal(outputMicrocents);
  return input === AMOUNT_UNAVAILABLE || output === AMOUNT_UNAVAILABLE
    ? AMOUNT_UNAVAILABLE
    : `$${input} / $${output} per M`;
}

// ── time ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A span of whole seconds as a clock reads it, from a minute up: `1m04s`, and from an hour up `1h00m`, `1h01m` (hours and minutes: the seconds
 * of a span that long are noise, and a turn that has run a day reads `24h00m`, never `1440m00s`). The one helper of {@link formatDuration} and
 * {@link formatElapsed}.
 */
const clockOf = (wholeSeconds: number): string => {
  const minutes = Math.floor(wholeSeconds / 60);
  if (minutes < 60) return `${minutes}m${String(wholeSeconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
};

/**
 * A completed span, compactly: `420ms`, `3.2s`, `1m04s`, `1h01m`. A negative (clock skew) and a number that is not finite (`NaN`, `Infinity`: a
 * clock that failed) clamp to 0, as {@link formatElapsed} does, so a row never reads `NaNmNaNs`. A span that rounds to a whole second
 * reads in seconds (`999.5 ms` is `1.0s`, never `1000ms`).
 */
export function formatDuration(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const wholeMs = Math.round(safeMs);
  if (wholeMs < SECOND_MS) {
    return `${wholeMs}ms`;
  }
  const totalSeconds = safeMs / SECOND_MS;
  // Below the boundary where one-decimal rounding would read "60.0s" — show one-decimal seconds.
  if (totalSeconds < 59.95) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  // Round to whole seconds, then carry into minutes and hours — so 59.95–59.999s → "1m00s", 119.6s → "2m00s" and 3599.6s → "1h00m",
  // never the invalid "60.0s", "1m60s" or "60m00s".
  return clockOf(Math.round(totalSeconds));
}

/**
 * A LIVE in-flight counter (the "thinking… {elapsed}" turn timer): WHOLE seconds only so it does not jitter every animation frame —
 * `3s`, `12s`, `1m03s`, and from an hour up `1h00m` (no seconds, no days: the hours keep counting). Negatives (clock skew) and a non-finite input clamp to 0 (never `NaNmNaNs`). Distinct from
 * {@link formatDuration}, which shows sub-second precision for a COMPLETED span.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / SECOND_MS);
  return totalSeconds < 60 ? `${totalSeconds}s` : clockOf(totalSeconds);
}

/** What a timestamp more than one minute ahead of the clock says: it is not an age, and `just now` would be a lie. */
export const IN_THE_FUTURE = 'in the future';

/** What an age or a time-until of a number that is not finite is: nothing. It is the answer {@link formatAgeOfIso} gives for a text that is not a time, so a row draws what it has and never `NaNd ago`. */
export const NO_TIME = '';

/**
 * A coarse relative age from the time elapsed since (`nowMs - thenMs`): `just now` (under a minute, and a skew of up to one minute
 * into the future), `5m ago`, `3h ago`, `2d ago`. Each unit starts exactly at its boundary (60 s, 60 min, 24 h) and rounds down. More
 * than one minute ahead of the clock is {@link IN_THE_FUTURE}, never `just now`. One spelling of "ago" for every surface. A number
 * that is not finite (`NaN`, `Infinity`) is no age: {@link NO_TIME}.
 */
export function formatAge(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return NO_TIME;
  if (elapsedMs < -MINUTE_MS) return IN_THE_FUTURE;
  if (elapsedMs < MINUTE_MS) return 'just now';
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m ago`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h ago`;
  return `${Math.floor(elapsedMs / DAY_MS)}d ago`;
}

/** {@link formatAge} of an ISO timestamp; an unparseable one yields `''` (the row renders nothing rather than `NaN`). */
export function formatAgeOfIso(iso: string, nowMs: number): string {
  const thenMs = Date.parse(iso);
  return Number.isNaN(thenMs) ? '' : formatAge(nowMs - thenMs);
}

/**
 * The forward-looking counterpart of {@link formatAge}: `in 30s`, `in 5m`, `in 2h`, `in 3d` (a sub-second remainder reads `in 1s`, never
 * `in 0s`). A time that has PASSED (a negative remainder) reads as the age it is, by {@link formatAge}: `just now`, `5m ago`, never `in 1s`.
 * A number that is not finite is {@link NO_TIME}, never `in NaNd`.
 */
export function formatTimeUntil(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return NO_TIME;
  if (remainingMs < 0) return formatAge(-remainingMs);
  const seconds = Math.max(1, Math.floor(remainingMs / SECOND_MS));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * The calendar date of an ISO timestamp, in UTC: `2026-11-24`. A machine timestamp stays what it is stored as (UTC, to the millisecond);
 * this is how a human line says WHEN without the milliseconds and the `T`/`Z`. `''` for a text that is not a time (the caller draws
 * what it has) and for a year outside four digits.
 */
export function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const at = new Date(ms);
  const year = at.getUTCFullYear();
  if (year < 0 || year > 9999) return '';
  return `${String(year).padStart(4, '0')}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`;
}

/** The clock time of an ISO timestamp, in UTC, on a 24-hour clock: `09:05`, `23:59`. `''` for a text that is not a time. */
export function formatClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const at = new Date(ms);
  return `${pad2(at.getUTCHours())}:${pad2(at.getUTCMinutes())}`;
}

/** A moment as a person reads it: `2026-11-24 09:05 UTC` (the zone is said, because the stored timestamp is UTC and a clock is not read alone). */
export function formatDateTime(iso: string): string {
  const date = formatDate(iso);
  return date === '' ? '' : `${date} ${formatClock(iso)} UTC`;
}

/** The freshness of the newest live refresh: `never refreshed` when there is none (or its time is not a number), else `updated` and its {@link formatAge}. */
export function formatRefreshed(refreshedAtMs: number | undefined, nowMs: number): string {
  const age = refreshedAtMs === undefined ? NO_TIME : formatAge(nowMs - refreshedAtMs);
  // a refresh time that is not a number is no refresh a person can be told about: `updated ` with nothing after it would be worse
  return age === NO_TIME ? 'never refreshed' : `updated ${age}`;
}

// ── identifiers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How many characters of an identifier a line that only LABELS it keeps. */
export const SHORT_ID_CHARS = 8;

/**
 * An identifier cut for a line that only labels it (a run id on a row): its first {@link SHORT_ID_CHARS} characters, by code point (a
 * surrogate pair is never split) and with a cost that does not grow with the input (an id read back from a database may be any text).
 * The cut is not a sanitiser: the caller still sends the result through the inline sanitiser. **Never use it where the person is asked
 * to type or compare the id exactly** (a resume command, an approval's id): those keep the id whole, and the full id stays in details
 * and in machine output.
 */
export function shortId(id: string): string {
  return Array.from(id.slice(0, SHORT_ID_CHARS * 2))
    .slice(0, SHORT_ID_CHARS)
    .join('');
}

// ── paths ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link displayPath} shortens a path against. The caller passes them: this module reads no process state. */
export interface DisplayPathRoots {
  /** The project directory. A path inside it shows relative to it. */
  readonly cwd: string | undefined;
  /** The operator's home directory. A path inside it (and outside the project) shows from `~`. */
  readonly home: string | undefined;
  /** Read the paths as Windows paths: `\` and `/` both separate, a drive letter is a root, and names compare ignoring case. */
  readonly win32?: boolean;
}

interface ParsedPath {
  /** What the path is rooted at, compared as it is (a drive is lower-cased on Windows): `/`, `c:` or `//`. */
  readonly root: string;
  readonly parts: readonly string[];
  readonly trailing: boolean;
}

const DRIVE_ROOT = /^([A-Za-z]):[\\/]/u;

/** The root and the names of an absolute path, or `undefined` for a relative one. Repeated separators collapse. */
function parseAbsolute(path: string, win32: boolean): ParsedPath | undefined {
  let root: string;
  let rest: string;
  const drive = win32 ? DRIVE_ROOT.exec(path) : null;
  if (drive !== null) {
    root = `${(drive[1] ?? '').toLowerCase()}:`;
    rest = path.slice(3);
  } else if (win32 && (path.startsWith('\\\\') || path.startsWith('//'))) {
    root = '//';
    rest = path.slice(2);
  } else if (path.startsWith('/') || (win32 && path.startsWith('\\'))) {
    root = '/';
    rest = path.slice(1);
  } else {
    return undefined;
  }
  const parts = rest.split(win32 ? /[\\/]+/u : /\/+/u).filter((part) => part !== '');
  const last = path.at(-1);
  return { root, parts, trailing: last === '/' || (win32 && last === '\\') };
}

/**
 * `text` with the capital letters A to Z made lower case, and nothing else touched. JavaScript's own `toLowerCase` folds more than that (the
 * Kelvin sign U+212A is a `k`, the Angstrom sign U+212B an `å`), so a name that only LOOKS like another would be read as the same file and a
 * path outside the project shown inside it. A name that differs by anything but the case of an ASCII letter does not compare equal, and a
 * mismatch fails safe: the whole path is shown.
 */
const asciiLower = (text: string): string => text.replace(/[A-Z]+/gu, (run) => run.toLowerCase());

const sameName = (a: string, b: string, win32: boolean): boolean =>
  win32 ? asciiLower(a) === asciiLower(b) : a === b;

const isDotSegment = (part: string): boolean => part === '.' || part === '..';

/**
 * The names of `target` that follow `base`, or `undefined` when `target` is not provably inside it. A base with no names (a filesystem
 * or drive root) shortens nothing, and a name that is `.` or `..` anywhere in the base or in what follows stops the shortening: a
 * path that climbs out of a directory must not be shown as if it stayed in.
 */
function insideOf(
  base: ParsedPath | undefined,
  target: ParsedPath,
  win32: boolean,
): readonly string[] | undefined {
  if (base === undefined || base.parts.length === 0 || base.parts.some(isDotSegment)) {
    return undefined;
  }
  if (base.root !== target.root || base.parts.length > target.parts.length) return undefined;
  if (!base.parts.every((part, index) => sameName(part, target.parts[index] ?? '', win32))) {
    return undefined;
  }
  const rest = target.parts.slice(base.parts.length);
  return rest.some(isDotSegment) ? undefined : rest;
}

/**
 * `{ paths: roots }` when there are roots and `{}` when there are none: for a model whose input says `paths?: DisplayPathRoots` and so refuses an
 * explicit `undefined` (`exactOptionalPropertyTypes`). Spread it (`...optionalPaths(deps.paths)`) instead of writing the conditional at
 * each place that passes its roots on.
 */
export function optionalPaths(roots: DisplayPathRoots | undefined): {
  readonly paths?: DisplayPathRoots;
} {
  return roots === undefined ? {} : { paths: roots };
}

/** The separator a shortened path is written with: a backslash when it is a Windows path that used one, else a slash. */
const separatorOf = (path: string, win32: boolean): string =>
  win32 && path.includes('\\') ? '\\' : '/';

const isSeparator = (char: string | undefined, win32: boolean): boolean =>
  char === '/' || (win32 && char === '\\');

/** The index after every leading `./` of `path` and after the separators that follow each (`.//a` and `././a` both start at `a`). */
function afterLeadingDots(path: string, win32: boolean): number {
  let at = 0;
  while (path[at] === '.' && isSeparator(path[at + 1], win32)) {
    at += 2;
    while (isSeparator(path[at], win32)) at += 1;
  }
  return at;
}

/**
 * A relative path as it is read: without its leading `./`, the project itself as `.`. A path that was given as `~…` is left alone (it was
 * already written from the home), but one that only BECOMES `~…` by losing its `./` keeps it: `./~/x` is a folder named `~` in the
 * project, and `~/x` would read as the home.
 */
function relativeForm(path: string, win32: boolean): string {
  const at = afterLeadingDots(path, win32);
  if (at === 0) return path;
  const rest = path.slice(at);
  if (rest === '') return '.';
  return rest.startsWith('~') ? `.${separatorOf(path, win32)}${rest}` : rest;
}

/** The names that follow a root, as the text of a path: separated, with the separator the input ended in kept. */
function tailOf(rest: readonly string[], trailing: boolean, separator: string): string {
  return rest.join(separator) + (trailing && rest.length > 0 ? separator : '');
}

/**
 * A path inside the project, project-relative: `src/app.ts`, and `.` for the project itself. A tail that STARTS with `~` (a folder named
 * `~` or `~bob`) keeps its `./`, because `~/x.yaml` is where a person reads the home: a file written under `<project>/~/` must never be
 * shown as if it were in the home directory.
 */
function projectForm(rest: readonly string[], trailing: boolean, separator: string): string {
  const tail = tailOf(rest, trailing, separator);
  if (tail === '') return '.';
  return tail.startsWith('~') ? `.${separator}${tail}` : tail;
}

/** A path inside the home and outside the project, from `~`. */
function homeForm(rest: readonly string[], trailing: boolean, separator: string): string {
  const tail = tailOf(rest, trailing, separator);
  return tail === '' ? '~' : `~${separator}${tail}`;
}

/** The root a path is shortened against, parsed; `undefined` for none (an empty root or no root at all). */
function parsedBase(root: string | undefined, win32: boolean): ParsedPath | undefined {
  return root === undefined || root === '' ? undefined : parseAbsolute(root, win32);
}

/** An absolute path shortened against the project and then the home, or `undefined` when it is inside neither. */
function shortenAbsolute(
  target: ParsedPath,
  separator: string,
  roots: DisplayPathRoots,
  win32: boolean,
): string | undefined {
  const inProject = insideOf(parsedBase(roots.cwd, win32), target, win32);
  if (inProject !== undefined) return projectForm(inProject, target.trailing, separator);
  const inHome = insideOf(parsedBase(roots.home, win32), target, win32);
  return inHome === undefined ? undefined : homeForm(inHome, target.trailing, separator);
}

/**
 * A path as a person reads it: project-relative when it is inside `cwd` (`src/app.ts`, never `./src/app.ts`; the project itself is
 * `.`), `~/…` when it is inside `home`, and otherwise the path exactly as it was given. A path outside both cannot be shortened
 * without hiding where it is, so it stays absolute (the approval card for a write outside the project keeps showing the real path). A
 * relative path is already short: it is returned without a leading `./`. With `win32` the path is read as a Windows path and the
 * result uses the separator the input used.
 *
 * **A result that starts with `~` is always the home.** A project folder named `~` or `~bob` (a shell leaves `--out=~/x.yaml`
 * unexpanded, so the file lands in `<project>/~/`) is shown `./~/x.yaml`, never `~/x.yaml`.
 *
 * **It does not sanitise.** A path read from configuration, a project file or chosen by a model is an untrusted string: the caller
 * sends the result through the inline sanitiser, the host-glyph blanking and a length bound AFTER the shortening.
 */
export function displayPath(path: string, roots: DisplayPathRoots): string {
  const win32 = roots.win32 === true;
  const target = parseAbsolute(path, win32);
  if (target === undefined) return relativeForm(path, win32);
  return shortenAbsolute(target, separatorOf(path, win32), roots, win32) ?? path;
}

// ── the working directory ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What stands for the path elements left out at the front of a label (`…/app`): one column, so a label that was cut says so. */
export const PATH_ELLIPSIS = '…';

/** Is `path` written as a Windows path: a drive letter, or a backslash anywhere. */
const looksWindows = (path: string): boolean => DRIVE_ROOT.test(path) || path.includes('\\');

/** `cwd` from `~` when it is inside `home` (`~/acme-web`, and `~` for the home itself), otherwise `undefined`. */
function fromHome(cwd: string, home: string | undefined, win32: boolean): string | undefined {
  const target = parseAbsolute(cwd, win32);
  if (target === undefined) return undefined;
  const rest = insideOf(parsedBase(home, win32), target, win32);
  if (rest === undefined) return undefined;
  return rest.length === 0 ? '~' : `~/${rest.join('/')}`;
}

/** `…/<the last name>`, for a path outside the home; `/` for a path that has no name (a filesystem root or a drive root). */
function fromEnd(cwd: string, win32: boolean): string {
  const names =
    parseAbsolute(cwd, win32)?.parts ?? cwd.split(/[\\/]+/u).filter((name) => name !== '');
  const last = names.at(-1);
  return last === undefined ? '/' : `${PATH_ELLIPSIS}/${last}`;
}

/**
 * `text` cut to at most `room` display columns from the FRONT, keeping its end behind one {@link PATH_ELLIPSIS}. Whole grapheme clusters
 * only: a wide character that would straddle the cut is left out (so the result is never one column too wide), and a room of zero or
 * less is the empty string.
 */
function keepTail(text: string, room: number): string {
  if (room < 1) return '';
  const total = displayWidth(text);
  for (let kept = room - 1; kept > 0; kept -= 1) {
    const tail = sliceDisplayColumns(text, total - kept, total);
    if (displayWidth(tail) <= room - 1) return `${PATH_ELLIPSIS}${tail}`;
  }
  return PATH_ELLIPSIS;
}

/**
 * A directory label (`~/work/clients/acme/web`, `…/app`) cut by NAMES to fit `room` display columns: the leading names become
 * {@link PATH_ELLIPSIS} and the end, the part that tells one directory from another, stays. The longest run of trailing names that fits
 * is kept (`…/clients/acme/web`, then `…/acme/web`, down to `…/web`) and the last name is never cut: when even `…/<last name>` is wider
 * than `room` it is returned all the same (the floor of this cut, which is why a caller that must fit uses {@link cutPathLead}). A label
 * that fits, or has a single name, is returned as it is. It does not sanitise: the caller sends the label through the inline sanitiser
 * BEFORE cutting (a cut is a host-written ellipsis, which the sanitiser's compatibility fold would turn into three dots).
 */
export function cutPathNames(label: string, room: number): string {
  if (displayWidth(label) <= room) return label;
  const names = label.split('/');
  let candidate = label;
  for (let keep = names.length - 1; keep >= 1; keep -= 1) {
    candidate = `${PATH_ELLIPSIS}/${names.slice(-keep).join('/')}`;
    if (displayWidth(candidate) <= room) return candidate;
  }
  return candidate;
}

/**
 * {@link cutPathNames}, and, when even `…/<last name>` does not fit, the end of the whole label by characters behind one
 * {@link PATH_ELLIPSIS} (whole grapheme clusters, never wider than `room`); a room of zero or less is the empty string.
 */
export function cutPathLead(label: string, room: number): string {
  const named = cutPathNames(label, room);
  return displayWidth(named) <= room ? named : keepTail(label, room);
}

/**
 * The working directory as ONE short label for the status line ([ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2): `~/acme-web` for a path inside the operator's `home`, `~` for the home itself, and, for a path outside it, its LAST name behind
 * `…/` (`…/app` for `/srv/app`: never absolute, and never the middle of a path the line has no room to name). The status line names the
 * directory the chat will run in, so project-relative is NOT used here (that is {@link displayPath}'s, for a path inside the project).
 *
 * Separators are `/` on every platform: a path that is written as a Windows path (a drive letter or a backslash) is read as one, its
 * backslashes are folded to `/`, its drive letter is dropped, and its names compare ignoring the case of ASCII letters only (as
 * {@link displayPath} does). A trailing separator is not part of the label, and a path with no name (`/`, `C:\`) is `/`. A path that
 * climbs (`.` or `..` among its names) is never shown as inside the home: it falls to the outside form. `bound`, in display columns,
 * cuts the label from its lead with {@link cutPathLead}. Pure: no filesystem access, no process state. Control and bidirectional
 * characters are NOT its business: the caller passes the label through the inline sanitiser (`flowLine`) before it is drawn.
 */
export function directoryLabel(cwd: string, home: string | undefined, bound?: number): string {
  if (cwd === '') return '';
  const win32 = looksWindows(cwd) || (home !== undefined && looksWindows(home));
  const label = fromHome(cwd, home, win32) ?? fromEnd(cwd, win32);
  return bound === undefined ? label : cutPathLead(label, bound);
}
