/**
 * The one builder of a key legend ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §2 and §3, which
 * generalise [ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §5): the dim,
 * ` · `-separated line under a screen that says which keys do what.
 *
 * The grammar, in one place:
 *
 * - **Brackets.** A letter and a Ctrl chord are written in brackets (`[d] withdraw`, `[Ctrl+Y] Allow once`, `[v] full diff`); the universal
 *   keys (`Enter`, `Esc`, the arrows, `PgUp/PgDn`, `Home/End`, `Tab`, `Space`, `Backspace`, `Del`) are written plain. {@link keyToken} is the
 *   one function that decides, so a sentence that names a key follows the same rule as a legend.
 * - **The verb states the effect.** An action the person performs is a lower-case imperative (`Enter apply`, `[d] withdraw`); a key of the
 *   approval's answer row keeps the capitalised word of its family (`Allow once`, `Deny`: ADR-0145 §4); a count goes after the verb in
 *   parentheses (`[Ctrl+C] exit (twice)`). No full stop. One separator, ` · `, on every row.
 * - **The key that leaves goes last and its effect is written**, and the legend cannot be built without it: `exit` is a required argument of
 *   {@link legend}. The four `Esc` classes (ADR-0145 §2) are four constructors, so the same class says the same words on every surface:
 *   `close` (nothing changes), `back` (one step), and the two that carry a consequence the person may not expect, written as a fact in the
 *   third person (`Esc stops the turn`, `Esc leaves it running`).
 * - **Text.** A status, a reason, a position or live text between the keys is a {@link LegendText}, drawn dim like the verbs.
 *
 * Framework-free and pure (it imports nothing from `ink`, `react` or `node:`: ADR-0145 §10). A screen builds its legend from the same
 * constants its key handler matches, so a hint cannot say a key does something the handler does not; each key table has a test that presses
 * every key it lists.
 */

import type { SheetRole, SheetSpan } from './sheet-frame.js';

/** How a view draws a key: emphasised by default, an answer that allows in `ok`, one that denies or destroys in `danger`, a stop in `warn`. */
export type LegendRole = Exclude<SheetRole, 'dim'>;

/**
 * One key (or several that do the same) and the thing it does: `{ keys: '↑/↓', verb: 'select' }` reads `↑/↓ select`. `keys` is written
 * WITHOUT brackets: the builder brackets what the grammar says to bracket. Several keys that do one thing are a list, drawn `a / b`.
 */
export interface LegendKey {
  readonly keys: string | readonly string[];
  readonly verb: string;
  readonly role?: LegendRole;
  /**
   * The key is LOCKED by its input guard's 2 s lockout right now (the maintainer's ruling of 2026-11-26 on ADR-0145 §3): the whole item, its
   * key too, is drawn dim, and its verb is followed by {@link LEGEND_WAIT} in the same text (`[Ctrl+Y] Create them (wait)`), so the state reads
   * without colour. Static: no countdown, no tick; the surface draws the item again without it once, at the moment the lock opens. Set by a
   * surface from its guard ONLY: nothing reads it back from a text, so a label that says `(wait)` is an ordinary label. A fit counts its
   * columns (the text is longer), and a popup's legend row keeps it before every other key but the ways out (`fittedLegendItems`).
   */
  readonly wait?: true;
}

/** What a locked key's verb is followed by ({@link LegendKey.wait}): one fixed word, never a time. */
export const LEGEND_WAIT = '(wait)';

/**
 * The mark of a key its guard holds now ({@link LegendKey.wait}), spread into the item a surface builds (`{ keys, verb, ...waitMark(locked) }`),
 * or nothing while it is free: the ONE spelling of it, so the popup host's legend, the native prompt's legend and a chord card's answer row
 * cannot mark a lock three ways.
 */
export function waitMark(locked: boolean): { readonly wait?: true } {
  return locked ? { wait: true } : {};
}

/** Words between the keys, drawn dim: a status (`Starting chat…`), a reason, a position (`Notice 1–17 of 60`) or live text (a query echo). */
export interface LegendText {
  readonly text: string;
}

export type LegendItem = LegendKey | LegendText;

/** The separator between two items: one space, a middle dot, one space. */
export const LEGEND_SEPARATOR = ' · ';

/** The universal keys, written plain; every other key (a letter, a digit, a Ctrl chord, an Alt chord) is bracketed. */
const PLAIN_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Esc',
  'Tab',
  'Shift+Tab',
  'Tab/Shift+Tab',
  'Space',
  'Backspace',
  'Del',
  'Delete',
  '↑',
  '↓',
  '←',
  '→',
  '↑/↓',
  '←/→',
  'PgUp',
  'PgDn',
  'PgUp/PgDn',
  'Home',
  'End',
  'Home/End',
]);

/**
 * The key tokens the grammar brackets, as {@link inertLegendText} looks for them: a single letter or digit (`[d]`, `[1]`) and a chord, any
 * short word, a `+` and a short rest (`[Ctrl+Y]`, `[Alt+Enter]`, `[Ctrl+Shift+R]`). A chord is read by its SHAPE and not by its modifier's name,
 * so a lookalike of one (`[Сtrl+Y]` with a Cyrillic `С`) is as inert as the real one; the price is that a name such as `file[a+b].ts` reads
 * `file(a+b).ts`. The universal keys are never bracketed, so a `[Enter]` is not the grammar's and is left alone. A name such as `[id].tsx` has
 * no token in it.
 */
const KEY_TOKEN_LOOKALIKE = /\[(?:[\p{L}\p{N}]|[^\]\n+]{1,10}\+[^\]\n]{1,16})\]/gu;

/**
 * What a terminal draws as a blank cell although it is not whitespace: the Braille blank (U+2800) and the Hangul fillers (U+115F, U+1160, and U+3164
 * and U+FFA0, which the compatibility fold reads as U+1160). They are not `\p{Cf}`, so the folded view keeps them, and beside the dot they read as
 * the spaces of the separator (`a\u3164·\u3164b` draws `a · b`): the lookarounds below count them as whitespace.
 */
const BLANK_CELLS = String.raw`\s\u2800\u115F\u1160\u3164\uFFA0`;

/**
 * The separator as it can be forged: a lookalike of the middle dot (U+00B7; the bullet and dot operators U+2219 and U+22C5, the hyphenation
 * point U+2027 and the katakana middle dot U+30FB; the Greek ano teleia U+0387 and the halfwidth katakana middle dot U+FF65 fold to the first
 * and the last of these, so the {@link foldedView} reads them as those; and, since a model id a project's agent file chooses reached the status
 * line with them (SE7-5), the word-separator middle dot U+2E31, the Latin middle dot U+A78F, the runic punctuation U+16EB, the raised point
 * U+2E33 and the bullet U+2022, with the bullets of the same class: U+2023, U+2043, U+25E6, U+2981 and U+25CF) with a whitespace character of
 * any kind (a no-break or a thin space too) on each side. The whitespace is looked at and left, so two dots in a row (`a · · b`) are both found.
 */
const SEPARATOR_LOOKALIKE = new RegExp(
  `(?<=[${BLANK_CELLS}])[\\u00B7\\u2219\\u22C5\\u2027\\u30FB\\u2E31\\uA78F\\u16EB\\u2E33\\u2022\\u2023\\u2043\\u25E6\\u2981\\u25CF](?=[${BLANK_CELLS}])`,
  'gu',
);

/** The characters that draw nothing (the zero-width and joining characters, the soft hyphen, the byte-order mark, the bidi marks): dropped from the view a forgery is looked for in. */
const INVISIBLE = /^\p{Cf}$/u;

/** `text` as a forgery would be read: the invisible characters gone and every other character in its compatibility form (`［Ctrl＋Y］` reads `[Ctrl+Y]`), with where each folded unit came from. */
function foldedView(text: string): {
  readonly folded: string;
  readonly start: readonly number[];
  readonly end: readonly number[];
} {
  let folded = '';
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  for (const character of text) {
    const next = at + character.length;
    if (!INVISIBLE.test(character)) {
      const piece = character.normalize('NFKC');
      for (let unit = 0; unit < piece.length; unit += 1) {
        start.push(at);
        end.push(next);
      }
      folded += piece;
    }
    at = next;
  }
  return { folded, start, end };
}

/**
 * Text from an untrusted source (a file name, a command line, a path) that is drawn INSIDE a legend as a {@link LegendText}: with the
 * legend's separator and its key tokens made inert, so a name cannot be read as another item of the legend (ADR-0145 §5: "a separator the
 * status line uses is neutralised inside a field value"). Every ` · ` becomes ` - ` (a different shape, not a lookalike: the forgery is
 * visual) and a bracketed key token becomes a parenthesised one (`[Ctrl+Y]` reads `(Ctrl+Y)`). Everything else, brackets of a name
 * included, is left as it is.
 *
 * What is looked for is looked for in the text as it would be READ: the invisible characters dropped (a zero-width space inside `[Ctrl+\u200BY]`)
 * and every character folded to its compatibility form (a fullwidth `［Ctrl＋Y］`, the fullwidth `＋` of a chord), so a forgery that is not byte-for-byte
 * the separator or the token is found all the same: any whitespace around the dot (a no-break or thin space), the lookalike dots
 * ({@link SEPARATOR_LOOKALIKE}) and a chord by its shape ({@link KEY_TOKEN_LOOKALIKE}). Only what is found is changed, in the text as it was written
 * (an emoji sequence, a name in another script, an invisible character elsewhere stay). It does not sanitise: the control characters go through
 * the inline sanitiser first.
 */
export function inertLegendText(text: string): string {
  // two passes, so that a separator inside a chord (`[Ctrl+ · Y]`) is made inert before the chord is
  const separated = replaceFolded(text, SEPARATOR_LOOKALIKE, () => '-');
  return replaceFolded(separated, KEY_TOKEN_LOOKALIKE, (written) => {
    // the first and the last character of what was written are the brackets, whatever their form was: they become parentheses, the rest stays
    const characters = Array.from(written);
    return `(${characters.slice(1, -1).join('')})`;
  });
}

/** `text` with each match of `pattern` in its {@link foldedView} replaced, in the text as it was written, by `replace` of what was written there. */
function replaceFolded(
  text: string,
  pattern: RegExp,
  replace: (written: string) => string,
): string {
  const { folded, start, end } = foldedView(text);
  let out = '';
  let at = 0;
  for (const found of folded.matchAll(pattern)) {
    const from = start[found.index] ?? 0;
    const to = end[found.index + found[0].length - 1] ?? from;
    out += text.slice(at, from) + replace(text.slice(from, to));
    at = to;
  }
  return out + text.slice(at);
}

/** A key as the grammar writes it: `Enter` stays `Enter`, `d` becomes `[d]`, `Ctrl+Y` becomes `[Ctrl+Y]`. Idempotent on a bracketed key. */
export function keyToken(key: string): string {
  if (key.startsWith('[') && key.endsWith(']')) return key;
  return PLAIN_KEYS.has(key) ? key : `[${key}]`;
}

/**
 * The keys of an item as written: each key by {@link keyToken}, a list joined by ` / `, or by `, ` when a key of the list already holds a
 * slash (`↑/↓, PgUp/PgDn select` reads; `↑/↓ / PgUp/PgDn select` does not).
 */
export function keyLabel(keys: string | readonly string[]): string {
  if (typeof keys === 'string') return keyToken(keys);
  return keys.map(keyToken).join(keys.some((key) => key.includes('/')) ? ', ' : ' / ');
}

function isKey(item: LegendItem): item is LegendKey {
  return 'keys' in item;
}

/**
 * What the key that leaves does. Built only by the four constructors of {@link exitKey}, so a legend names one of the four classes of
 * ADR-0145 §2 and says its effect.
 */
export interface LegendExit extends LegendKey {
  readonly class: 'decide' | 'step' | 'close' | 'leave';
}

/** The `Esc` of ADR-0145 §2, by class; `keys` defaults to `Esc` and is another key where the surface leaves by another (`Ctrl+C`). */
export const exitKey = {
  /** Nothing changes: the palette, a picker, a popup's first step. */
  close: (keys: string | readonly string[] = 'Esc', verb = 'close'): LegendExit => ({
    class: 'close',
    keys,
    verb,
  }),
  /** Back one level: the full view to its approval, a detail to its list. */
  step: (keys: string | readonly string[] = 'Esc', verb = 'back'): LegendExit => ({
    class: 'step',
    keys,
    verb,
  }),
  /** Rejects and stops; the consequence is stated (`stops the turn`). */
  decide: (effect: string, keys: string | readonly string[] = 'Esc'): LegendExit => ({
    class: 'decide',
    keys,
    verb: effect,
    role: 'warn',
  }),
  /** The surface closes and the work or the state stays (`leaves it running`, `leaves it pending`). */
  leave: (effect: string, keys: string | readonly string[] = 'Esc'): LegendExit => ({
    class: 'leave',
    keys,
    verb: effect,
  }),
} as const;

/** A rendered legend: its text and where its keys, verbs, texts and separators are in it (the spans cover the text once, in order). */
export interface LegendRender {
  readonly text: string;
  readonly spans: readonly SheetSpan[];
}

/**
 * A key item's two parts as drawn: its keys (in its role, or dim while it waits) and its verb (dim; a waiting key's verb ends in
 * {@link LEGEND_WAIT}). The verb part starts with the space between the two.
 */
function keyParts(item: LegendKey): {
  readonly label: string;
  readonly role: SheetRole;
  readonly verb: string;
} {
  if (item.wait === true)
    return { label: keyLabel(item.keys), role: 'dim', verb: ` ${item.verb} ${LEGEND_WAIT}` };
  return { label: keyLabel(item.keys), role: item.role ?? 'strong', verb: ` ${item.verb}` };
}

function render(entries: readonly LegendItem[]): LegendRender {
  const spans: SheetSpan[] = [];
  let text = '';
  entries.forEach((item, index) => {
    if (index > 0) {
      spans.push({ from: text.length, to: text.length + LEGEND_SEPARATOR.length, role: 'dim' });
      text += LEGEND_SEPARATOR;
    }
    if (isKey(item)) {
      const { label, role, verb } = keyParts(item);
      spans.push({ from: text.length, to: text.length + label.length, role });
      text += label;
      // the space between the keys and the verb, then the verb
      spans.push({ from: text.length, to: text.length + verb.length, role: 'dim' });
      text += verb;
    } else {
      spans.push({ from: text.length, to: text.length + item.text.length, role: 'dim' });
      text += item.text;
    }
  });
  return { text, spans };
}

/** The legend text for these items in the order given and then the key that leaves, joined by {@link LEGEND_SEPARATOR}. */
export function legend(items: readonly LegendItem[], exit: LegendExit): string {
  return render([...items, exit]).text;
}

/**
 * Where the keys, the verbs and the separators are in {@link legend}'s text, so a view can draw the keys apart from the words: each key in
 * its role (emphasised by default), each verb, each text and each separator dimmed. The spans index `legend(items, exit)` exactly.
 */
export function legendSpans(items: readonly LegendItem[], exit: LegendExit): readonly SheetSpan[] {
  return render([...items, exit]).spans;
}

/**
 * The legend as rows of at most `columns` (as `width` measures them), filled in order and cut BETWEEN items, never inside one: a terminal
 * that wraps a long line would split `[Ctrl+C]` from `stops the turn`, and a key is not read without its effect. A row that another follows keeps
 * the separator's dot at its end (`a · b ·` then `c`), as a wrapped legend reads, so the rows put back one after the other are the legend. The
 * key that leaves is the last item of the last row; an item wider than a row has a row of its own, and the caller's own cut applies to it. For a
 * refusal drawn on a terminal too narrow for one row (a card that cannot be shown), where {@link fitLegend}'s dropping of keys would hide what
 * the person can still press.
 */
export function legendRows(
  items: readonly LegendItem[],
  exit: LegendExit,
  columns: number,
  width: (text: string) => number,
): readonly string[] {
  const dot = LEGEND_SEPARATOR.trimEnd();
  const rows: string[] = [];
  let row: LegendItem[] = [];
  for (const item of [...items, exit]) {
    // an item that is not the last may end a row, which then carries the dot of the separator it stands in front of
    const trailing = item === exit ? 0 : width(LEGEND_SEPARATOR) - width(' ');
    if (row.length === 0 || width(keyHint([...row, item])) + trailing <= columns) row.push(item);
    else {
      rows.push(`${keyHint(row)}${dot}`);
      row = [item];
    }
  }
  rows.push(keyHint(row));
  return rows;
}

/**
 * Items with no key that leaves: a hint beside a row or a status (`no key yet · Enter add one`, `Notice 1–17 of 60 · PgUp/PgDn read`) and a
 * card's first row of answers, whose second row carries the exit. The same grammar (bracket rule, one separator, verbs that state the effect)
 * as {@link legend}, in a second function so that {@link legend} can keep its exit required. Empty items are an empty render.
 */
export function legendItems(items: readonly LegendItem[]): LegendRender {
  return render(items);
}

/** The text of {@link legendItems}. */
export function keyHint(items: readonly LegendItem[]): string {
  return render(items).text;
}

/** An item that may be dropped when the legend does not fit, and how much it matters (higher is kept longer). */
export interface OptionalItem {
  readonly item: LegendItem;
  readonly priority: number;
}

/**
 * The one fit-to-width rule: the legend with as many of the optional items as fit in `columns`, dropping the lowest priority first (and, among
 * equals, the one that comes last). The required items and the exit are never dropped; when even they do not fit the caller's own truncation
 * applies. `width` measures a string the way the renderer does (a width function is passed in so this module stays free of imports).
 */
export function fitLegend(
  required: readonly LegendItem[],
  optional: readonly OptionalItem[],
  exit: LegendExit,
  columns: number,
  width: (text: string) => number,
): readonly LegendItem[] {
  const kept = new Set(optional.map((_, index) => index));
  const build = (): readonly LegendItem[] => [
    ...required,
    ...optional.filter((_, index) => kept.has(index)).map((entry) => entry.item),
  ];
  const order = optional
    .map((entry, index) => ({ index, priority: entry.priority }))
    .sort((a, b) => a.priority - b.priority || b.index - a.index);
  for (const drop of order) {
    if (width(legend(build(), exit)) <= columns) break;
    kept.delete(drop.index);
  }
  return build();
}
