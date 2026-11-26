import { framedFlow } from '../../home/framed-flow.js';
import { flowText } from './flow-text.js';
import type { NativeChordPort, NativePromptFlow } from './native-prompt-channel.js';
import { clipLine } from './sheet-frame.js';

/**
 * The Home's `/import`, drawn as a popup ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §9, MVP-8 step 5; [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6):
 * the person types a path, the popup shows what the import would write, and a file is written only on a Yes. Its rail is `Path · Review · Done`.
 * It is drawn by the native channel framed as a popup (`framedFlow`), so it owns no keys of its own and every layer of the chord guard applies
 * to its Yes.
 *
 * - **A path prompt, not a browser.** One native text field, bounded and checked by the port; what is typed is a path, never a listing.
 * - **It shows what it would write before it writes.** The Review step is built from a PREPARED import (`prepareImport` in
 *   `commands/import.ts`: the kind, the id, the destination, the size and the notices about the file's literals, nothing written); only
 *   `Ctrl+Y`, accepted by the guard, runs the commit, and it runs it once.
 * - **The default is No.** `Ctrl+N`, `Esc`, `Ctrl+C`, a flow cancelled under the card, a closed Home and every key that is not a chord
 *   all write nothing: only an `allow` the channel returned is a Yes. **It never overwrites**: an id the project already has, or a
 *   destination that is already taken, is a refusal before it asks, and its words name the shell command that does overwrite (the one
 *   exception `no-shell-remedy.test.ts` lists: the popup has no way to replace a file).
 * - **A refusal is a step too.** When the import cannot be prepared the person is shown the reason, in the same place, with one way to
 *   close it; nothing is written and nothing is asked.
 * - **The result is the Done step** (§6): what was imported and where it went, project-relative, closed by `Enter` or `Esc`; a write that
 *   failed says so there. Nothing goes to the Home's notice: a cancel is one notification, the sentence {@link runImportCard} resolves with.
 *
 * **Every string the file or the path supplied (the id, the source, the destination, a notice, a refusal) passes the full scrub
 * ({@link flowText}) before it reaches the channel**; the bounds here keep the popup inside 80×24.
 */

/** What the card says about an import that was prepared: all of it display text, nothing a write is built from. */
export interface ImportOffer {
  readonly kind: 'workflow' | 'agent';
  readonly slug: string;
  /** The source, as the command names it: relative to the working directory. */
  readonly source: string;
  /** The cwd-relative destination, as the command prints it. */
  readonly destination: string;
  /** The destination relative to the project's root (`.relavium/workflows/<id>.relavium.yaml`): what the Done step names. */
  readonly target: string;
  /** The bytes the file will take. */
  readonly bytes: number;
  /** The command's own notices about the file's literals, one sentence each, in its words. At most two exist. */
  readonly warnings: readonly string[];
}

/** What a commit left: the command's sentence for a file written, or the reason it did not write. */
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

const IMPORT_TITLE = '/import';
const IMPORT_STEPS = ['Path', 'Review', 'Done'] as const;
const PATH = 0;
const REVIEW = 1;

export const IMPORT_PATH_MESSAGE = 'Path of the workflow or agent YAML to import (~ is your home)';
export const IMPORT_ALLOW_LABEL = 'Write the file';
export const IMPORT_DENY_LABEL = 'Write nothing';
/** The notification when the popup was answered with anything but a Yes, or the path was never given. */
export const IMPORT_NOT_WRITTEN = 'Nothing was written.';
/** What the refusal step says above the reason. */
export const IMPORT_CANNOT = 'Cannot import this file.';
/** What the Done step says when the write itself was refused. */
export const IMPORT_FAILED = 'Not imported.';
const IMPORT_CANONICAL =
  'Canonical YAML: comments are dropped and values are kept as written. The file you named is not changed.';

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

/** An untrusted fragment as the popup draws it: the full scrub, then the bound. */
const shown = (text: string, columns: number): string => clipLine(flowText(text), columns);

export interface ImportCardText {
  readonly message: string;
  readonly details: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

/** The Review step's words for one offer: the question, where it comes from and where it goes, the size, the notices, and what a copy holds. */
export function importCardText(offer: ImportOffer): ImportCardText {
  return {
    message: `Import ${offer.kind} '${shown(offer.slug, SLUG_COLUMNS)}' into this project?`,
    details: [
      `${label('from')}${shown(offer.source, SOURCE_COLUMNS)}`,
      `${label('to')}${shown(offer.destination, DESTINATION_COLUMNS)}`,
      `${label('size')}${bytesText(offer.bytes)}`,
      ...offer.warnings.slice(0, WARNING_LIMIT).map((text) => shown(text, WARNING_COLUMNS)),
      IMPORT_CANONICAL,
    ],
    allow: IMPORT_ALLOW_LABEL,
    deny: IMPORT_DENY_LABEL,
  };
}

/** What the Done step says for a file that was written: what was imported, and what to type next. */
function importDoneText(offer: ImportOffer): {
  readonly message: string;
  readonly lines: readonly string[];
  readonly target: string;
} {
  return {
    message: `Imported ${offer.kind} '${shown(offer.slug, SLUG_COLUMNS)}'`,
    lines: [
      offer.kind === 'workflow'
        ? 'Next: /run runs it, and /workflows lists it.'
        : 'Next: /agents lists it.',
    ],
    target: shown(offer.target, DESTINATION_COLUMNS),
  };
}

export interface ImportCardDeps {
  /** The Home's native prompt flow: framed here as the `/import` popup (its text field, its chord card, its refusal and its Done step). */
  readonly flow: NativePromptFlow & NativeChordPort;
  readonly port: ImportPort;
  /** Throws when the Home is closing; called before anything is asked or read. */
  readonly assertAdmitting?: (() => void) | undefined;
}

/**
 * Ask for a path, prepare the import of it, ask, and write only on a Yes. Resolves with the ONE notification the Home shows (nothing was
 * written: a No, an `Esc`, a cancel), or `undefined` when the popup itself said what happened (the Done step, a refusal). The flow is begun
 * here and ended here, whatever the answer.
 */
export async function runImportCard(deps: ImportCardDeps): Promise<string | undefined> {
  deps.assertAdmitting?.();
  const flow = framedFlow(deps.flow, {
    title: IMPORT_TITLE,
    origin: 'home',
    stepNames: IMPORT_STEPS,
    progress: 'manual',
  });
  const signal = flow.begin();
  try {
    const typed = await flow.at(PATH).text({
      message: IMPORT_PATH_MESSAGE,
      validate: deps.port.pathIssue,
      escape: 'cancel',
    });
    // `Esc` and `Ctrl+C` end the flow; nothing has been read.
    if (typeof typed !== 'string') return IMPORT_NOT_WRITTEN;
    const prepared = deps.port.prepare(typed);
    if (!prepared.ok) {
      // The refusal, where the question would have been: the reason, and one way to close it. Whatever closes it writes nothing.
      await flow.fail(REVIEW, IMPORT_CANNOT, shown(prepared.reason, REASON_COLUMNS));
      return undefined;
    }
    const answer = await flow
      .at(REVIEW)
      .chord({ ...importCardText(prepared.offer), escape: 'cancel', signal });
    // The default is No: only an `allow` the chord guard let through is a Yes, never "anything that is not a `deny`".
    if (answer !== 'allow') return IMPORT_NOT_WRITTEN;
    const attempt = prepared.commit();
    if (attempt.ok) await flow.done(importDoneText(prepared.offer));
    else
      await flow.done({
        message: IMPORT_FAILED,
        lines: [shown(attempt.reason, REASON_COLUMNS)],
        tone: 'failed',
      });
    return undefined;
  } finally {
    await flow.end();
  }
}
