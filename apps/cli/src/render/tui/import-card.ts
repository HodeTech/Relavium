import type { NativeChordPort, NativePromptFlow } from './native-prompt-channel.js';
import { clipLine } from './sheet-frame.js';

/**
 * The import card of the Home's `/import` ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5): the person types a path, the card shows what the import would write, and a file is written only on a Yes. It is the
 * export card's twin and is drawn by the same native chord card, so it owns no keys of its own and every layer of the chord guard applies
 * to its Yes.
 *
 * - **A path prompt, not a browser.** One native text field, bounded and checked by the port; what is typed is a path, never a listing.
 * - **It shows what it would write before it writes.** The card is built from a PREPARED import (`prepareImport` in `commands/import.ts`:
 *   the kind, the id, the destination, the size and the notices about the file's literals, nothing written); only `Ctrl+Y`, accepted by
 *   the guard, runs the commit, and it runs it once.
 * - **The default is No.** `Ctrl+N`, `Esc`, `Ctrl+C`, a flow cancelled under the card, a closed Home and every key that is not a chord
 *   all write nothing: only an `allow` the channel returned is a Yes. **The card never overwrites**: an id the project already has, or a
 *   destination that is already taken, is a refusal before the card asks, and its words name the shell command that does overwrite.
 * - **A refusal is a card too.** When the import cannot be prepared the person is shown the reason, in the same place, with one way to
 *   close it; nothing is written and nothing is asked.
 *
 * Every string on the card passes the channel's sanitize floor again; the bounds here keep the card inside 80×24.
 */

/** What the card says about an import that was prepared: all of it display text, nothing a write is built from. */
export interface ImportOffer {
  readonly kind: 'workflow' | 'agent';
  readonly slug: string;
  /** The source, as the command names it: relative to the working directory. */
  readonly source: string;
  /** The cwd-relative destination, as the command prints it. */
  readonly destination: string;
  /** The bytes the file will take. */
  readonly bytes: number;
  /** The command's own notices about the file's literals, one sentence each, in its words. At most two exist. */
  readonly warnings: readonly string[];
}

/** What a commit left: the sentence the Home shows, or the reason it did not write. */
export type ImportAttempt =
  | { readonly ok: true; readonly written: string }
  | { readonly ok: false; readonly reason: string };

/** A prepared import, or the reason it cannot be: `commit` writes exactly what the offer describes. */
export type ImportPrepared =
  | { readonly ok: true; readonly offer: ImportOffer; readonly commit: () => ImportAttempt }
  | { readonly ok: false; readonly reason: string };

/** The Home's import seam: nothing here writes until a commit is called, and a refusal comes back as text, not as a throw. */
export interface ImportPort {
  /** What is wrong with a path as typed, before anything is read; none when it may be tried. Pure: it reads no file. */
  readonly pathIssue: (text: string) => string | undefined;
  /** Check the path again (the field's check is never trusted), read and validate the file, and work out what would be written. */
  readonly prepare: (pathText: string) => ImportPrepared;
}

export const IMPORT_PATH_MESSAGE = 'Path of the workflow or agent YAML to import (~ is your home)';
export const IMPORT_ALLOW_LABEL = 'Write the file';
export const IMPORT_DENY_LABEL = 'Write nothing';
export const IMPORT_CLOSE_LABEL = 'Close';
/** What the Home says when the card was answered with anything but a Yes, or the path was never given. */
export const IMPORT_NOT_WRITTEN = 'Nothing was written.';

const SOURCE_COLUMNS = 120;
const DESTINATION_COLUMNS = 160;
const SLUG_COLUMNS = 60;
const REASON_COLUMNS = 240;
/** A notice is a sentence the command wrote; the bound only keeps a card whose port was handed something else inside the screen. */
const WARNING_COLUMNS = 320;
/** The command writes at most two notices; the card draws no more. */
const WARNING_LIMIT = 2;

const label = (name: string): string => name.padEnd(12);

/** `1 byte`, `1,234 bytes`: the number grouped so it reads at a glance. */
const bytesText = (bytes: number): string =>
  `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;

export interface ImportCardText {
  readonly message: string;
  readonly details: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

/** The card's words for one offer: the question, where it comes from and where it goes, the size, the notices, and what a copy holds. */
export function importCardText(offer: ImportOffer): ImportCardText {
  return {
    message: `Import ${offer.kind} '${clipLine(offer.slug, SLUG_COLUMNS)}' into this project?`,
    details: [
      `${label('from')}${clipLine(offer.source, SOURCE_COLUMNS)}`,
      `${label('to')}${clipLine(offer.destination, DESTINATION_COLUMNS)}`,
      `${label('size')}${bytesText(offer.bytes)}`,
      ...offer.warnings.slice(0, WARNING_LIMIT).map((text) => clipLine(text, WARNING_COLUMNS)),
      'Canonical YAML: comments are dropped and values are kept as written. The file you named is not changed.',
    ],
    allow: IMPORT_ALLOW_LABEL,
    deny: IMPORT_DENY_LABEL,
  };
}

export interface ImportCardDeps {
  /** The Home's native prompt flow: its text field for the path, its chord card for the question, its select for a refusal. */
  readonly flow: Pick<NativePromptFlow, 'begin' | 'end' | 'select' | 'text'> & NativeChordPort;
  readonly port: ImportPort;
  /** Throws when the Home is closing; called before anything is asked or read. */
  readonly assertAdmitting?: (() => void) | undefined;
}

/** What the Home shows for a refusal. The reason is the prepare's or the commit's own sentence. */
export const importRefused = (reason: string): string => `Not imported. ${reason}`;

/**
 * Ask for a path, prepare the import of it, ask, and write only on a Yes. Resolves with the sentence the Home shows; a refusal and a No
 * are sentences, not faults. The flow is begun here and ended here, whatever the answer.
 */
export async function runImportCard(deps: ImportCardDeps): Promise<string> {
  deps.assertAdmitting?.();
  const signal = deps.flow.begin();
  try {
    const typed = await deps.flow.text({
      message: IMPORT_PATH_MESSAGE,
      validate: deps.port.pathIssue,
      escape: 'cancel',
    });
    // `Esc` and `Ctrl+C` end the flow; nothing has been read.
    if (typeof typed !== 'string') return IMPORT_NOT_WRITTEN;
    const prepared = deps.port.prepare(typed);
    if (!prepared.ok) {
      // The reason, where the question would have been, and one way to close it. Whatever closes it writes nothing.
      await deps.flow.select({
        message: `Cannot import: ${clipLine(prepared.reason, REASON_COLUMNS)}`,
        options: [{ value: 'close', label: IMPORT_CLOSE_LABEL }],
        escape: 'cancel',
      });
      return importRefused(prepared.reason);
    }
    const text = importCardText(prepared.offer);
    const answer = await deps.flow.chord({ ...text, escape: 'cancel', signal });
    // The default is No: only an `allow` the chord guard let through is a Yes, never "anything that is not a `deny`".
    if (answer !== 'allow') return IMPORT_NOT_WRITTEN;
    const attempt = prepared.commit();
    return attempt.ok ? attempt.written : importRefused(attempt.reason);
  } finally {
    await deps.flow.end();
  }
}
