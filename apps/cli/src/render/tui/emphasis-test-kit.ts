/**
 * What a test needs to ask a frame about its styling (not shared by any product code): the runs of a frame by the styles active over them,
 * and the styles still open at the end of each row. A small SGR reader, so a test says "this row is bold and inverse over these words" and
 * "no row leaves a style open" instead of matching escape bytes.
 */

const ESC = String.fromCharCode(0x1b);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, 'gu');

export interface StyleRun {
  readonly text: string;
  /** The styles active over `text`, sorted: `bold`, `dim`, `inverse`, `underline`, `colour`, `background`, … */
  readonly styles: readonly string[];
}

const ON: Readonly<Record<string, string>> = {
  '1': 'bold',
  '2': 'dim',
  '3': 'italic',
  '4': 'underline',
  '7': 'inverse',
  '9': 'strike',
};
const OFF: Readonly<Record<string, readonly string[]>> = {
  '22': ['bold', 'dim'],
  '23': ['italic'],
  '24': ['underline'],
  '27': ['inverse'],
  '29': ['strike'],
  '39': ['colour'],
  '49': ['background'],
};

/** Applies the parameters of one SGR sequence to the set of active styles. */
function apply(active: Set<string>, params: string): void {
  for (const code of params.split(';')) {
    const number = Number(code === '' ? '0' : code);
    if (number === 0) active.clear();
    else if (ON[code] !== undefined) active.add(ON[code]);
    else if (OFF[code] !== undefined) for (const name of OFF[code]) active.delete(name);
    else if ((number >= 30 && number <= 38) || (number >= 90 && number <= 97)) active.add('colour');
    else if ((number >= 40 && number <= 48) || (number >= 100 && number <= 107))
      active.add('background');
  }
}

/** `text` cut into the runs that have one set of styles, in order; an empty run is not listed. */
export function styleRuns(text: string): StyleRun[] {
  const active = new Set<string>();
  const runs: StyleRun[] = [];
  let at = 0;
  const flush = (upto: number): void => {
    const run = text.slice(at, upto);
    if (run.length > 0) runs.push({ text: run, styles: [...active].sort() });
  };
  for (const match of text.matchAll(SGR)) {
    flush(match.index);
    at = match.index + match[0].length;
    apply(active, match[1] ?? '');
  }
  flush(text.length);
  return runs;
}

/** The styles active over the first run of `frame` that contains `needle`; `undefined` when no run does. */
export function stylesOver(frame: string, needle: string): readonly string[] | undefined {
  return styleRuns(frame).find((run) => run.text.includes(needle))?.styles;
}

/** For each row of `frame`, the styles still open at its end: a row that closes everything it opened is an empty list. */
export function openAtEndOfEachRow(frame: string): readonly (readonly string[])[] {
  const active = new Set<string>();
  return frame.split('\n').map((row) => {
    for (const match of row.matchAll(SGR)) apply(active, match[1] ?? '');
    const open = [...active].sort();
    // A row is judged on its own: what a previous row left open is reported there, and the next row starts again from nothing.
    active.clear();
    return open;
  });
}

/** `frame` without its styling. */
export const plain = (frame: string): string => frame.replace(SGR, '');
