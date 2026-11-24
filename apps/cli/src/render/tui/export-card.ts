import type { NativeChordPort, NativePromptFlow } from './native-prompt-channel.js';
import { clipLine } from './sheet-frame.js';

/**
 * The export card of the Defined tab ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): what `x` on a row asks the person before a file is written. It is drawn by the Home's native chord card, so it
 * owns no keys of its own and every layer of the chord guard applies to its Yes.
 *
 * - **It shows the destination before it writes.** The card is built from a PREPARED export (`prepareExport` in `commands/export.ts`:
 *   the destination and the bytes, nothing written); only `Ctrl+Y`, accepted by the guard, runs the commit, and it runs it once.
 * - **The default is No.** `Ctrl+N`, `Esc`, `Ctrl+C`, a flow cancelled under the card, a closed Home and every key that is not a chord
 *   all write nothing: only an `allow` the channel returned is a Yes. The card never overwrites; a destination that exists is refused
 *   before the card asks.
 * - **A refusal is a card too.** When the export cannot be prepared the person is shown the reason, in the same place, with one way to
 *   close it; nothing is written and nothing is asked.
 *
 * Every string on the card passes the channel's sanitize floor again; the bounds here keep the card inside 80×24.
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

/** What a commit left: the sentence the Home shows, or the reason it did not write. */
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

export const EXPORT_ALLOW_LABEL = 'Write the file';
export const EXPORT_DENY_LABEL = 'Write nothing';
export const EXPORT_CLOSE_LABEL = 'Close';
/** What the Home says when the card was answered with anything but a Yes. */
export const EXPORT_NOT_WRITTEN = 'Nothing was written.';

const DESTINATION_COLUMNS = 160;
const SLUG_COLUMNS = 60;
const REASON_COLUMNS = 240;

const label = (name: string): string => name.padEnd(12);

/** `1 byte`, `1,234 bytes`: the number grouped so it reads at a glance. */
const bytesText = (bytes: number): string =>
  `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;

export interface ExportCardText {
  readonly message: string;
  readonly details: readonly string[];
  readonly allow: string;
  readonly deny: string;
}

/** The card's words for one offer: the question, the destination and the size, and what a copy of this kind holds. */
export function exportCardText(offer: ExportOffer): ExportCardText {
  return {
    message: `Write ${offer.kind} '${clipLine(offer.slug, SLUG_COLUMNS)}' to a file in this directory?`,
    details: [
      `${label('destination')}${clipLine(offer.destination, DESTINATION_COLUMNS)}`,
      `${label('size')}${bytesText(offer.bytes)}`,
      'Canonical YAML: comments are dropped and values are kept as written. Review it before sharing.',
    ],
    allow: EXPORT_ALLOW_LABEL,
    deny: EXPORT_DENY_LABEL,
  };
}

export interface ExportCardDeps {
  /** The Home's native prompt flow: its chord card for the question, its select for a refusal. */
  readonly flow: Pick<NativePromptFlow, 'begin' | 'end' | 'select'> & NativeChordPort;
  readonly port: ExportPort;
  /** Throws when the Home is closing; called before anything is prepared or asked. */
  readonly assertAdmitting?: (() => void) | undefined;
}

/** What the Home shows for a refusal. The reason is the prepare's or the commit's own sentence. */
export const exportRefused = (reason: string): string => `Not exported. ${reason}`;

/**
 * Prepare the export of `slug`, ask, and write it only on a Yes. Resolves with the sentence the Home shows; a refusal and a No are
 * sentences, not faults. The flow is begun here and ended here, whatever the answer.
 */
export async function runExportCard(deps: ExportCardDeps, slug: string): Promise<string> {
  deps.assertAdmitting?.();
  const prepared = deps.port.prepare(slug);
  const signal = deps.flow.begin();
  try {
    if (!prepared.ok) {
      // The reason, where the question would have been, and one way to close it. Whatever closes it writes nothing.
      await deps.flow.select({
        message: `Cannot export '${clipLine(slug, SLUG_COLUMNS)}': ${clipLine(prepared.reason, REASON_COLUMNS)}`,
        options: [{ value: 'close', label: EXPORT_CLOSE_LABEL }],
        escape: 'cancel',
      });
      return exportRefused(prepared.reason);
    }
    const text = exportCardText(prepared.offer);
    const answer = await deps.flow.chord({ ...text, escape: 'cancel', signal });
    // The default is No: only an `allow` the chord guard let through is a Yes, never "anything that is not a `deny`".
    if (answer !== 'allow') return EXPORT_NOT_WRITTEN;
    const attempt = prepared.commit();
    return attempt.ok ? attempt.written : exportRefused(attempt.reason);
  } finally {
    await deps.flow.end();
  }
}
