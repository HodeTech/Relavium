// Chalk's level is read once, when it is first imported: this module is the first thing the golden's recorders import, so a frame can
// SEE its styles (the test-only side effect of `force-color.ts`).
import '../force-color.js';

import { Box } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';

import { isHintShaped } from './hint-shape.js';

/**
 * How the golden reads a mounted view: the rows of the frame the terminal would show. A view is drawn at a fixed width (the test
 * renderer's stdout is 100 columns wide, so a width above that is not drawable), once without colour (plain text, the way `NO_COLOR`
 * shows it) and once with it, where every styled run is written `⟦style: text⟧` so a role (allow-green, deny-red, dim) is part of the
 * golden and a change of it is a visible diff.
 */

// eslint-disable-next-line no-control-regex -- the escape that starts a styling sequence
const SGR = /\u001b\[([0-9;]*)m/gu;

const STYLE_NAMES: Readonly<Record<string, string>> = {
  '1': 'bold',
  '2': 'dim',
  '3': 'italic',
  '4': 'underline',
  '7': 'inverse',
  '9': 'strike',
  '30': 'black',
  '31': 'red',
  '32': 'green',
  '33': 'yellow',
  '34': 'blue',
  '35': 'magenta',
  '36': 'cyan',
  '37': 'white',
  '90': 'gray',
  '41': 'bg-red',
  '42': 'bg-green',
  '43': 'bg-yellow',
};
/** What a closing code turns off: `22` ends bold and dim, `39` the foreground, `49` the background. */
const CLOSES: Readonly<Record<string, readonly string[]>> = {
  '22': ['bold', 'dim'],
  '23': ['italic'],
  '24': ['underline'],
  '27': ['inverse'],
  '29': ['strike'],
  '39': ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'],
  '49': ['bg-red', 'bg-green', 'bg-yellow'],
};

/** `text` with every styled run written `⟦style,style: run⟧`; unstyled text stays as it is. */
export function tagStyles(text: string): string {
  const active = new Set<string>();
  let out = '';
  let at = 0;
  const flush = (upto: number): void => {
    const run = text.slice(at, upto);
    if (run.length === 0) return;
    if (active.size === 0) {
      out += run;
      return;
    }
    out += `⟦${[...active].sort().join(',')}: ${run}⟧`;
  };
  for (const match of text.matchAll(SGR)) {
    flush(match.index);
    at = match.index + match[0].length;
    for (const code of (match[1] ?? '').split(';')) {
      if (code === '0' || code === '') active.clear();
      else if (CLOSES[code] !== undefined) for (const name of CLOSES[code]) active.delete(name);
      else if (STYLE_NAMES[code] !== undefined) active.add(STYLE_NAMES[code]);
    }
  }
  flush(text.length);
  return out;
}

/** The plain text of a frame: every styling sequence dropped. */
export function plainText(frame: string): string {
  return frame.replace(SGR, '');
}

export interface MountOptions {
  /** The width the view is drawn at (at most the test renderer's 100). */
  readonly columns?: number;
}

/** The rows of `element` drawn once, trailing blanks dropped, in plain text. */
export function plainRows(element: ReactElement, options: MountOptions = {}): string[] {
  return mount(element, options).map((row) => plainText(row));
}

/** The rows of `element` drawn once, with every styled run tagged. */
export function styledRows(element: ReactElement, options: MountOptions = {}): string[] {
  return mount(element, options).map((row) => tagStyles(row));
}

function mount(element: ReactElement, options: MountOptions): string[] {
  const view = render(<Box width={options.columns ?? 100}>{element}</Box>);
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame.split('\n').map((row) => row.replace(/\s+$/u, ''));
}

/**
 * The rows of a frame that are a key legend, a hint or a sentence naming a key ({@link isHintShaped}), in frame order. A row is judged by
 * its plain text, so a key drawn in a run of its own (`[d]` bold, `withdraw` dim) is still the row it is; what is returned is the row
 * as `shape` renders it.
 */
function legendRows(raw: readonly string[], shape: (row: string) => string): string[] {
  return raw.filter((row) => isHintShaped(plainText(row))).map(shape);
}

/** The legend rows of `element` without colour and with it, as two states of the same name (`<state> colour=off`, `colour=on`). */
export function legendStates(
  state: string,
  element: (color: boolean) => ReactElement,
  options: MountOptions = {},
): Record<string, readonly string[]> {
  return {
    [`${state} colour=off`]: legendRows(mount(element(false), options), plainText),
    [`${state} colour=on`]: legendRows(mount(element(true), options), tagStyles),
  };
}

/**
 * The hint-shaped rows of a frame that was drawn elsewhere (a host that owns its own renderer): plain, or with its styled runs tagged.
 * A sentence the renderer wrapped at `wrapAt` columns is put back together (the row that filled the line, and the row after it).
 */
export function hintRowsOfFrame(frame: string, styled: boolean, wrapAt = 96): string[] {
  const rows = frame.split('\n').map((row) => row.replace(/\s+$/u, ''));
  const out: string[] = [];
  let previousFilled = false;
  for (const row of rows) {
    const text = plainText(row);
    if (!isHintShaped(text)) {
      previousFilled = false;
      continue;
    }
    const shaped = styled ? tagStyles(row) : text;
    const last = out.length - 1;
    if (previousFilled && last >= 0)
      out[last] = `${out[last] ?? ''}${shaped.startsWith(' ') ? '' : ' '}${shaped}`;
    else out.push(shaped);
    previousFilled = text.length >= wrapAt;
  }
  return out;
}

/**
 * Wait until `read()` has said the same thing for `quiet` polls in a row. A view driven through a store settles on the macrotasks after
 * the change, and a loaded machine takes longer than a fixed pause would allow, so the recorders wait for the frame, not for the clock.
 * Bounded: a frame that never settles (a spinner) returns after `maxPolls` and is recorded as it is.
 */
export async function settled(
  read: () => string,
  options: { readonly pollMs?: number; readonly quiet?: number; readonly maxPolls?: number } = {},
): Promise<void> {
  const { pollMs = 15, quiet = 4, maxPolls = 200 } = options;
  let last = read();
  let same = 0;
  for (let poll = 0; poll < maxPolls && same < quiet; poll += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    const now = read();
    same = now === last ? same + 1 : 0;
    last = now;
  }
}
