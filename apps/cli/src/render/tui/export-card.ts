import { framedFlow } from '../../home/framed-flow.js';
import { flowText } from './flow-text.js';
import type { NativeChordPort, NativePromptFlow } from './native-prompt-channel.js';
import { clipLine } from './sheet-frame.js';

/**
 * The export of the Defined tab, drawn as a popup ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4; [ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6):
 * what `x` on a row asks the person before a file is written. Its rail is `Review · Done`. It is drawn by the native channel framed as a popup
 * (`framedFlow`), so it owns no keys of its own and every layer of the chord guard applies to its Yes.
 *
 * - **It shows the destination before it writes.** The Review step is built from a PREPARED export (`prepareExport` in
 *   `commands/export.ts`: the destination and the bytes, nothing written); only `Ctrl+Y`, accepted by the guard, runs the commit, and it
 *   runs it once.
 * - **The default is No.** `Ctrl+N`, `Esc`, `Ctrl+C`, a flow cancelled under the card, a closed Home and every key that is not a chord
 *   all write nothing: only an `allow` the channel returned is a Yes. It never overwrites; a destination that exists is refused before it
 *   asks.
 * - **A refusal is a step too.** When the export cannot be prepared the person is shown the reason, in the same place, with one way to
 *   close it; nothing is written and nothing is asked.
 * - **The result is the Done step** (§6): what was exported and the file it went to (relative to the working directory, where the command
 *   writes it), closed by `Enter` or `Esc`; a write that failed says so there. Nothing is left on the tab's message row: a cancel is one
 *   notification, the sentence {@link runExportCard} resolves with.
 *
 * **Every string the catalog or the file system supplied (the id, the destination, a refusal) passes the full scrub ({@link flowText})
 * before it reaches the channel**; the bounds here keep the popup inside 80×24.
 */

/** What the card says about an export that was prepared: all of it display text, nothing a write is built from. */
export interface ExportOffer {
  readonly kind: 'workflow' | 'agent';
  readonly slug: string;
  /** The cwd-relative destination, as the command prints it. */
  readonly destination: string;
  /** The bytes the file will take. */
  readonly bytes: number;
}

/** What a commit left: the command's sentence for a file written, or the reason it did not write. */
export type ExportAttempt =
  | { readonly ok: true; readonly written: string }
  | { readonly ok: false; readonly reason: string };

/** A prepared export, or the reason it cannot be: `commit` writes exactly what the offer describes. */
export type ExportPrepared =
  | { readonly ok: true; readonly offer: ExportOffer; readonly commit: () => ExportAttempt }
  | { readonly ok: false; readonly reason: string };

/** The Home's export seam: prepare writes nothing, and a refusal comes back as text, not as a throw. */
export interface ExportPort {
  readonly prepare: (slug: string) => ExportPrepared;
}

const EXPORT_TITLE = 'Export';
const EXPORT_STEPS = ['Review', 'Done'] as const;
const REVIEW = 0;

export const EXPORT_ALLOW_LABEL = 'Write the file';
export const EXPORT_DENY_LABEL = 'Write nothing';
/** The notification when the popup was answered with anything but a Yes. */
export const EXPORT_NOT_WRITTEN = 'Nothing was written.';
/** What the Done step says when the write itself was refused. */
export const EXPORT_FAILED = 'Not exported.';
const EXPORT_CANONICAL =
  'Canonical YAML: comments are dropped and values are kept as written. Review it before sharing.';

const DESTINATION_COLUMNS = 160;
const SLUG_COLUMNS = 60;
const REASON_COLUMNS = 240;

const label = (name: string): string => name.padEnd(12);

/** `1 byte`, `1,234 bytes`: the number grouped so it reads at a glance. */
const bytesText = (bytes: number): string =>
  `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;

/** An untrusted fragment as the popup draws it: the full scrub, then the bound. */
const shown = (text: string, columns: number): string => clipLine(flowText(text), columns);

export interface ExportCardText {
  readonly message: string;
  readonly details: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

/** The Review step's words for one offer: the question, the destination and the size, and what a copy of this kind holds. */
export function exportCardText(offer: ExportOffer): ExportCardText {
  return {
    message: `Write ${offer.kind} '${shown(offer.slug, SLUG_COLUMNS)}' to a file in this directory?`,
    details: [
      `${label('destination')}${shown(offer.destination, DESTINATION_COLUMNS)}`,
      `${label('size')}${bytesText(offer.bytes)}`,
      EXPORT_CANONICAL,
    ],
    allow: EXPORT_ALLOW_LABEL,
    deny: EXPORT_DENY_LABEL,
  };
}

export interface ExportCardDeps {
  /** The Home's native prompt flow: framed here as the export popup (its chord card, its refusal and its Done step). */
  readonly flow: NativePromptFlow & NativeChordPort;
  readonly port: ExportPort;
  /** Throws when the Home is closing; called before anything is prepared or asked. */
  readonly assertAdmitting?: (() => void) | undefined;
}

/**
 * Prepare the export of `slug`, ask, and write it only on a Yes. Resolves with the ONE notification the Home shows (nothing was written: a
 * No, an `Esc`, a cancel), or `undefined` when the popup itself said what happened (the Done step, a refusal). The flow is begun here and
 * ended here, whatever the answer.
 */
export async function runExportCard(
  deps: ExportCardDeps,
  slug: string,
): Promise<string | undefined> {
  deps.assertAdmitting?.();
  const prepared = deps.port.prepare(slug);
  const flow = framedFlow(deps.flow, {
    title: EXPORT_TITLE,
    origin: 'home',
    stepNames: EXPORT_STEPS,
    progress: 'manual',
  });
  const signal = flow.begin();
  try {
    if (!prepared.ok) {
      // The refusal, where the question would have been: the reason, and one way to close it. Whatever closes it writes nothing.
      await flow.fail(
        REVIEW,
        `Cannot export '${shown(slug, SLUG_COLUMNS)}'.`,
        shown(prepared.reason, REASON_COLUMNS),
      );
      return undefined;
    }
    const answer = await flow
      .at(REVIEW)
      .chord({ ...exportCardText(prepared.offer), escape: 'cancel', signal });
    // The default is No: only an `allow` the chord guard let through is a Yes, never "anything that is not a `deny`".
    if (answer !== 'allow') return EXPORT_NOT_WRITTEN;
    const attempt = prepared.commit();
    if (attempt.ok)
      await flow.done({
        message: `Exported ${prepared.offer.kind} '${shown(prepared.offer.slug, SLUG_COLUMNS)}'`,
        lines: [EXPORT_CANONICAL],
        target: shown(prepared.offer.destination, DESTINATION_COLUMNS),
      });
    else
      await flow.done({
        message: EXPORT_FAILED,
        lines: [shown(attempt.reason, REASON_COLUMNS)],
        tone: 'failed',
      });
    return undefined;
  } finally {
    await flow.end();
  }
}
