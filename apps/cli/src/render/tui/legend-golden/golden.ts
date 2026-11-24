/**
 * The shapes of the legend golden ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3, "golden first").
 *
 * A **recorder** drives one producer through every state that changes what it says and returns the exact strings it emitted, keyed by a
 * state label. A state with more than one row is written `<state> [1]`, `<state> [2]`, …, so a diff of the committed file is one line per
 * row of text. Nothing in a recording may depend on the clock, the machine, an absolute path or the environment.
 */

/** One state's output: a row, or the rows (a legend and the lines around it) in the order the screen draws them. */
export type Rows = string | readonly string[];
/** What a recorder returns: state label → what the producer said in that state. */
export type StateRows = Readonly<Record<string, Rows>>;
/** A recorder, called on every run of the golden test. It may be asynchronous (a view that needs a store to settle). */
export type Recorder = () => StateRows | Promise<StateRows>;
/** The committed file: producer id → state label → one row of text. */
export type Golden = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** `states` with every multi-row state written one key per row. */
export function flatten(states: StateRows): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [state, rows] of Object.entries(states)) {
    if (typeof rows === 'string') out[state] = rows;
    else if (rows.length === 0) out[`${state} [none]`] = '';
    else rows.forEach((row, index) => (out[`${state} [${String(index + 1)}]`] = row));
  }
  return out;
}

/** `{ a: 1, b: 2 }` as `a=1 b=2`: the label of one combination of the states a producer varies by. */
export function label(
  parts: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  return Object.entries(parts)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

/**
 * One producer of a key legend, a hint line, a footer hint or a sentence that names a key: where it lives and what it is. The registry
 * is data (`producers.ts` joins the groups); the recorder of the same `id` is in `recorders/`.
 */
export interface Producer {
  /** A stable, kebab-case name, unique in the registry; the golden's top-level key. */
  readonly id: string;
  /** The production file the string is written in or built by, relative to `apps/cli/src`, with `/` separators. */
  readonly file: string;
  /** What it says and when, in one line. */
  readonly describe: string;
}
