/**
 * The `/help` popup on the Home ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10 as amended
 * 2026-11-27, [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D6): the keys of the Home and the commands it answers to, as ONE
 * page with no scroll at 80×24. It replaces the Home's `/help` screen, which cut rows at 80 columns, and it is the chat's popup (`help-popup.ts`)
 * with the Home's registry: the same report, the same `[c] copy`.
 *
 * - **The keys are the Home's own** (`HOME_KEYS`, `render/tui/help-sheet.ts`), each with the presses a test makes of it on a mounted Home, so the
 *   popup cannot list a key the Home does not have or say it does something else. They arrive through the port, as the chat's do.
 * - **The commands are the Home's palette rows** (`buildPaletteEntries('home', …)`, the registry's one table), grouped as the palette groups them
 *   (Work, Set up, Check, End) and listed by NAME ALONE: the descriptions are in the palette (`/`), and a one-page report has no room for fourteen
 *   of them. Nothing is copied.
 *
 * What the port hands in is scrubbed as every other string a report draws: a key's verb with the full scrub, a key's name with the floor that keeps
 * it from being something else (`keyLabel`).
 */

import type { CommandGroup } from '../commands/repl-commands.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import { blankHostGlyphs } from '../render/tui/glyphs.js';
import { inertLegendText } from '../render/tui/legend.js';
import { buildPaletteEntries } from '../render/tui/palette-entries.js';
import { HOME_EXIT_VERB, type PopupContent, type PopupOrigin } from './frame-model.js';
import { copyControlsFor } from './popup-copy.js';
import type { PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, scrubPopupText, wrapHanging } from './popup-text.js';

/** What the Home's `/help` lists beside its commands: the keys of the Home, as the controller's table gives them. */
export interface HomeHelpKeys {
  readonly keys: readonly { readonly keys: string; readonly verb: string }[];
}

/** The two headings of the report. */
const HEADINGS = {
  keys: 'Keys',
  commands: 'Commands · type / to see them with their descriptions',
} as const;

/** What each group of the Home's palette is called on the page (the palette draws no heading of its own). */
const GROUP_LABEL: Readonly<Partial<Record<CommandGroup, string>>> = {
  work: 'Work',
  setup: 'Set up',
  check: 'Check',
  end: 'End',
};

/** A key's name as the list draws it: what a person presses (`Ctrl+J`), which the full scrub would take for an answer chord. */
function keyLabel(keys: string): string {
  return blankHostGlyphs(inertLegendText(sanitizeUntrustedInline(keys)));
}

/** A row of a two-column list: the label padded to `width`, two spaces, the words, continued indented under themselves. */
function labelled(label: string, width: number, words: string): string[] {
  const lead = `  ${label.padEnd(width)}  `;
  return wrapHanging(`${lead}${words}`, POPUP_TEXT_COLUMNS, lead.length);
}

/** The commands of the Home's palette by group, in the palette's order: each group's label and its names (`/resume`, …). */
function commandGroups(): readonly { readonly label: string; readonly names: readonly string[] }[] {
  const entries = buildPaletteEntries('home', {
    hasSession: false,
    hasKey: true,
    turnRunning: false,
  });
  const groups: { label: string; names: string[] }[] = [];
  for (const entry of entries) {
    const label = GROUP_LABEL[entry.group] ?? entry.group;
    const last = groups.at(-1);
    if (last?.label === label) last.names.push(`/${entry.command.name}`);
    else groups.push({ label, names: [`/${entry.command.name}`] });
  }
  return groups;
}

/** The report's lines: the keys of the port, then the Home's commands by group. */
export function homeHelpLines(keys: HomeHelpKeys['keys']): readonly string[] {
  const labels = keys.map((key) => keyLabel(key.keys));
  const keyWidth = Math.max(0, ...labels.map((label) => label.length));
  const groups = commandGroups();
  const groupWidth = Math.max(0, ...groups.map((group) => group.label.length));
  return [
    HEADINGS.keys,
    ...keys.flatMap((key, index) =>
      labelled(labels[index] ?? '', keyWidth, scrubPopupText(key.verb)),
    ),
    '',
    HEADINGS.commands,
    ...groups.flatMap((group) => labelled(group.label, groupWidth, group.names.join('  '))),
  ];
}

/** The content of the one step. */
export function homeHelpContent(keys: HomeHelpKeys['keys']): PopupContent {
  return { kind: 'report', lines: homeHelpLines(keys) };
}

/** The popup's spec: one read-only step whose only control is `[c] copy`, with its way back naming the Home. */
export function homeHelpSpec(origin: PopupOrigin, content: PopupContent): PopupSpec {
  return {
    id: 'help',
    title: '/help',
    origin,
    steps: [
      {
        name: 'Help',
        content,
        controls: copyControlsFor(content),
        legendKeep: ['c'],
        exitVerb: HOME_EXIT_VERB,
      },
    ],
  };
}
