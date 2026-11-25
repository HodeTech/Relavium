/**
 * The `/help` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10,
 * [MVP-11 §4.4](../../../../docs/roadmap/phases/mvp-11.md#44-reports-and-settings-as-popups)): the commands and the keys of the chat the person is
 * in, as one scrollable report. The Home's own `/help` stays its screen.
 *
 * - **The commands are the chat's own palette rows**, in the palette's order, from the one command table (`buildPaletteEntries`, which both
 *   the palette and its view read): a row, its description on this surface and, where a row cannot act, why. Nothing is copied.
 * - **The keys are the host's `CHAT_KEYS`** (`render/tui/chat-keys.ts`), each with the press a test makes of it on a mounted chat, so the
 *   popup cannot list a key the chat does not have or say it does something else.
 *
 * What the host's port hands in is scrubbed like every other string a report draws: a key's verb with the full scrub ({@link reportText}), a
 * key's name with the floor that keeps it from being something else ({@link keyLabel}: a name such as `Ctrl+J` is not an answer chord), so a host
 * that wired a wrong or hostile label cannot forge a key token or a separator of the popup's own.
 */

import { sanitizeUntrustedInline } from '../render/sanitize.js';
import { blankHostGlyphs } from '../render/tui/glyphs.js';
import { inertLegendText } from '../render/tui/legend.js';
import { buildPaletteEntries } from '../render/tui/palette-entries.js';
import type { PopupContent, PopupOrigin } from './frame-model.js';
import type { PopupSpec } from './popup-reducer.js';
import type { HelpPort, ReportSurface } from './report-port.js';
import { REPORT_TEXT_COLUMNS, reportText, wrapHanging } from './report-text.js';

/** The two headings of the report. */
export const HELP_HEADINGS = { commands: 'Commands', keys: 'Keys' } as const;

/**
 * A key's name as the list draws it: what a person presses, such as `Ctrl+J`, which the full scrub would take for an answer chord and replace.
 * It is the host's own word, but the port hands it in, so it takes the floor that keeps a name from being something else: secrets scrubbed, one
 * line, a forged bracketed key token or separator made inert and the host's glyphs blanked.
 */
function keyLabel(keys: string): string {
  return blankHostGlyphs(inertLegendText(sanitizeUntrustedInline(keys)));
}

/** A row of a two-column list: the label padded to `width`, two spaces, the words, continued indented under themselves. */
function labelled(label: string, width: number, words: string): string[] {
  const lead = `  ${label.padEnd(width)}  `;
  return wrapHanging(`${lead}${words}`, REPORT_TEXT_COLUMNS, lead.length);
}

/**
 * The report's lines for `surface`: the commands of its palette, then the keys of the port. The palette is read as the host reads it for a
 * chat that has a conversation and a key (so every row can act), and a row that could not says so beside it.
 */
export function helpLines(surface: ReportSurface, keys: HelpPort['keys']): readonly string[] {
  const entries = buildPaletteEntries(surface, {
    hasSession: true,
    hasKey: true,
    turnRunning: false,
  });
  const names = entries.map((entry) => `/${entry.command.name}`);
  const commandWidth = Math.max(0, ...names.map((name) => name.length));
  const labels = keys.map((key) => keyLabel(key.keys));
  const keyWidth = Math.max(0, ...labels.map((label) => label.length));
  return [
    HELP_HEADINGS.commands,
    ...entries.flatMap((entry, index) =>
      labelled(
        names[index] ?? '',
        commandWidth,
        entry.enabled
          ? entry.description
          : `${entry.description} (unavailable: ${entry.reason ?? ''})`,
      ),
    ),
    '',
    HELP_HEADINGS.keys,
    ...keys.flatMap((key, index) => labelled(labels[index] ?? '', keyWidth, reportText(key.verb))),
  ];
}

/** The content of the one step. */
export function helpContent(surface: ReportSurface, keys: HelpPort['keys']): PopupContent {
  return { kind: 'report', lines: helpLines(surface, keys) };
}

/** The popup's spec: one read-only step with no control. */
export function helpSpec(origin: PopupOrigin, content: PopupContent): PopupSpec {
  return { id: 'help', title: '/help', origin, steps: [{ name: 'Help', content }] };
}
