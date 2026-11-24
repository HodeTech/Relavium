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
 * The key tokens the grammar brackets: a single letter or digit (`[d]`, `[1]`) and a chord (`[Ctrl+Y]`, `[Alt+Enter]`, `[Ctrl+Shift+R]`). The
 * universal keys are never bracketed, so a `[Enter]` is not the grammar's and is left alone. A name such as `[id].tsx` has no token in it.
 */
const BRACKETED_KEY =
  /\[(?:[\p{L}\p{N}]|(?:Ctrl|Alt|Shift|Cmd|Meta|Super|Win)\+[^\]\n]{1,16})\]/giu;

/**
 * Text from an untrusted source (a file name, a command line, a path) that is drawn INSIDE a legend as a {@link LegendText}: with the
 * legend's separator and its key tokens made inert, so a name cannot be read as another item of the legend (ADR-0145 §5: "a separator the
 * status line uses is neutralised inside a field value"). Every ` · ` becomes ` - ` (a different shape, not a lookalike: the forgery is
 * visual) and a bracketed key token becomes a parenthesised one (`[Ctrl+Y]` reads `(Ctrl+Y)`). Everything else, brackets of a name
 * included, is left as it is. It does not sanitise: the control characters go through the inline sanitiser first.
 */
export function inertLegendText(text: string): string {
  return text
    .replaceAll(LEGEND_SEPARATOR, ' - ')
    .replace(BRACKETED_KEY, (token) => `(${token.slice(1, -1)})`);
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

function render(entries: readonly LegendItem[]): LegendRender {
  const spans: SheetSpan[] = [];
  let text = '';
  entries.forEach((item, index) => {
    if (index > 0) {
      spans.push({ from: text.length, to: text.length + LEGEND_SEPARATOR.length, role: 'dim' });
      text += LEGEND_SEPARATOR;
    }
    if (isKey(item)) {
      const label = keyLabel(item.keys);
      spans.push({
        from: text.length,
        to: text.length + label.length,
        role: item.role ?? 'strong',
      });
      text += label;
      // the space between the keys and the verb, then the verb
      spans.push({ from: text.length, to: text.length + 1 + item.verb.length, role: 'dim' });
      text += ` ${item.verb}`;
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
