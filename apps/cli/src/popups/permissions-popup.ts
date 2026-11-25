/**
 * The `/permissions` popup in a chat ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2, [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §10; MVP-11 step 5c,
 * `popup-permissions-chat-80x24.png`): the commands remembered for this project and the ones approved for this session, and taking one back.
 * It replaces the chat's docked sheet, with the sheet's content and keys: `↑/↓` select, `[d]` (or `Del`) arms the withdrawal of the highlighted
 * row, and the withdrawal is a line answered by `Enter` through the popup host's guard (`chord.key: 'enter'`: not before 800 ms after its frame
 * was seen, not after 10 s, nothing typed before `[d]` or since), whose `Esc` keeps the row. The bare Home's `/permissions` is not this: it is
 * the Permissions tab of the tab host, over the same pure model (`permissions-sheet.ts`).
 *
 * **A `[d]` in the popup's first half second says nothing** (the sheet said "Wait a moment"). The popup host's opening guard drops it, as it
 * drops every answer that comes too soon (`Enter` on a list, a form's `Enter`, `/cost`'s `[r]`, the doctor's `[d]`), and none of those says a
 * word: a sentence for this one key would be a second rule. It would also say the wrong thing: the guard's wait is 500 ms from the frame, but
 * a notification stays for `NOTIFICATION_MS` (3 s) and is drawn in the legend row in place of its keys, so "Wait a moment" would hide
 * `[d] / Del withdraw` and tell the person to wait for 2.5 s after the key already works again. The next `[d]` arms
 * (`permissions-session.test.ts` pins both).
 *
 * Pure builders: the rows, the line, the spec and the words. The opener that answers the keys is `permissions-session.ts`; neither is loaded
 * until the person first opens a setting (`settings-port.ts`).
 *
 * **Every command string is untrusted** (a session approval is the argv a model asked to run; a remembered row's program name was written by
 * the person's project): each is escaped as the approval card shows it (`<U+202E>`, `<TAB>`: an invisible character is made visible, not
 * removed) and then passed through the popups' one scrub (`scrubPopupText`: secrets masked, host glyphs blanked, answer chords and key tokens
 * made inert), wherever it is drawn: a row, the line that names what is withdrawn, the announcement.
 */

import type { ChatMode } from '@relavium/shared';

import type {
  PermissionEntry,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import { keyToken } from '../render/tui/legend.js';
import {
  EMPTY_SESSION_TEXT,
  emptyProjectText,
  escaped,
  initialPermissionsSheetState,
  sheetEntries,
  sheetNote,
  withdrawHint,
} from '../render/tui/permissions-sheet.js';
import { clipLine } from '../render/tui/sheet-frame.js';
import { displayWidth } from '../render/tui/viewport.js';
import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import type { PopupContent, PopupListRow, PopupOrigin } from './frame-model.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import type { ChordRefusal } from './popup-host.js';
import { POPUP_KEYS, type PopupControl, type PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, scrubPopupText, wrapPopupText } from './popup-text.js';

/** The popup's steps: the lists (its first), and the withdrawal's line, reached from the lists by `[d]`. */
export const PERMISSIONS_STEP = { list: 0, withdraw: 1 } as const;

/** The control that arms the withdrawal of the highlighted row: `[d]`, or the Delete key (`[d] / Del withdraw (then Enter)`). */
export const WITHDRAW_CONTROL: PopupControl = {
  key: 'd',
  verb: `withdraw (then ${POPUP_KEYS.enter})`,
  deleteKey: true,
};

/** What the lists say when they cannot be read at all (the port promises not to throw: this is a defect's state, never a stale list). */
export const PERMISSIONS_UNREADABLE_CONTENT: PopupContent = {
  kind: 'error',
  what: 'Could not read the permissions.',
  next: 'Close this and try again.',
};

/** What the lists say when they cannot be read again after a withdrawal: never the list as it was, which would still show the row. */
export const PERMISSIONS_UNREADABLE_AGAIN_CONTENT: PopupContent = {
  kind: 'error',
  what: 'Could not read the permissions again.',
  next: 'Close this and open /permissions again.',
};

/** The columns a section row's text has: a section row is drawn two columns in (`frame-model.ts`). */
const SECTION_COLUMNS = POPUP_TEXT_COLUMNS - 2;
/** The indent of the command a line names, under its question. */
const INDENT = '  ';
/** The most rows the command a line names may take: the line (its question, the command, its effect and the narrowing) fits ten rows whole. */
const MAX_COMMAND_LINES = 6;
/** The widest a remembered row's label is padded to, so the dates stand in one column without a long label pushing them off the row. */
const MAX_LABEL_PAD = 32;

/** A command string as the popup draws it: escaped as the card shows it, then the popups' one scrub. */
export function permissionText(text: string): string {
  return scrubPopupText(escaped(text));
}

/** The row's words: a remembered command's label, or a session approval's command. */
function entryText(entry: PermissionEntry): string {
  return permissionText(entry.kind === 'project' ? entry.row.label : entry.row.text);
}

/** The id of the row of the entry at `index` of `sheetEntries`. */
const rowId = (index: number): string => `entry:${String(index)}`;

/** The entry a row stands for in `snapshot` (the snapshot the rows were built from), or `undefined` for a heading or an unknown row. */
export function entryOfRow(
  snapshot: PermissionsSnapshot,
  row: PopupListRow | undefined,
): PermissionEntry | undefined {
  if (row === undefined || row.section === true) return undefined;
  const match = /^entry:(\d+)$/u.exec(row.id);
  return match === null ? undefined : sheetEntries(snapshot)[Number(match[1])];
}

/** A row that is not one: a heading, a sentence, a blank, never selected. */
function section(id: string, label: string): PopupListRow {
  return { id, label, section: true, enabled: false };
}

/** `text` as section rows, each with its own id. */
function sentence(prefix: string, text: string): PopupListRow[] {
  return wrapPopupText(text, SECTION_COLUMNS).map((line, at) =>
    section(`${prefix}:${String(at)}`, line),
  );
}

/** `text` padded with spaces to `width` display columns (never cut). */
function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** What a withdrawal said that the list alone does not show (a note, a failure), above the lists; nothing for one that was done. */
function resultRows(result: WithdrawAnswer | undefined): PopupListRow[] {
  if (result === undefined || result.tone === 'done') return [];
  return sentence('result', `${result.tone === 'note' ? 'Note' : 'Not withdrawn'}: ${result.text}`);
}

/** The project's remembered commands: the heading, then the rows (dates in one column), the empty sentence or why it cannot be read. */
function projectRows(
  snapshot: PermissionsSnapshot,
  mode: ChatMode,
  entries: readonly PermissionEntry[],
): PopupListRow[] {
  const { project } = snapshot;
  if (!project.ok)
    return [
      section('project', 'This project · remembered'),
      ...sentence('project-text', project.text),
    ];
  const rows: PopupListRow[] = [
    section('project', `This project · remembered (${String(project.rows.length)})`),
  ];
  if (project.rows.length === 0)
    rows.push(
      ...sentence(
        'project-text',
        emptyProjectText(initialPermissionsSheetState(snapshot, 'chat', mode, 0)),
      ),
    );
  const labels = project.rows.map((row) => permissionText(row.label));
  const pad = Math.min(MAX_LABEL_PAD, Math.max(0, ...labels.map((label) => displayWidth(label))));
  project.rows.forEach((row, at) => {
    const entry = entries[at];
    rows.push({
      id: rowId(at),
      label: padTo(labels[at] ?? '', pad),
      detail: permissionText(row.remembered),
      ...(entry === undefined ? {} : { effect: withdrawHint(entry) }),
    });
  });
  return rows;
}

/** This session's approvals: the heading, then the rows (numbered after the project's) or the empty sentence. */
function sessionRows(
  snapshot: PermissionsSnapshot,
  entries: readonly PermissionEntry[],
): PopupListRow[] {
  const session = snapshot.session ?? [];
  const first = snapshot.project.ok ? snapshot.project.rows.length : 0;
  const rows: PopupListRow[] = [
    section('session', `This session · approved (${String(session.length)})`),
  ];
  if (session.length === 0) rows.push(section('session-text', EMPTY_SESSION_TEXT));
  session.forEach((row, at) => {
    const entry = entries[first + at];
    rows.push({
      id: rowId(first + at),
      label: permissionText(row.text),
      ...(row.alsoRemembered ? { detail: '(also remembered)' } : {}),
      ...(entry === undefined ? {} : { effect: withdrawHint(entry) }),
    });
  });
  return rows;
}

/**
 * The lists, read now, in the chat's mode: what a grant is worth in it (the sheet's note), what the last withdrawal said when the list alone
 * does not show it, then the project's remembered commands and this session's approvals, each row's effect the sentence that says what
 * withdrawing it does. With nothing to withdraw at all it is the empty state (what is empty, and how a command is remembered).
 */
export function permissionsContent(
  snapshot: PermissionsSnapshot,
  mode: ChatMode,
  result?: WithdrawAnswer,
): PopupContent {
  const entries = sheetEntries(snapshot);
  const state = initialPermissionsSheetState(snapshot, 'chat', mode, 0);
  if (entries.length === 0)
    return {
      kind: 'empty',
      what: snapshot.project.ok ? emptyProjectText(state) : snapshot.project.text,
      next: EMPTY_SESSION_TEXT,
    };
  return {
    kind: 'list',
    rows: [
      ...sentence('note', `${mode} mode · ${sheetNote(state)}`),
      ...resultRows(result),
      section('blank-project', ''),
      ...projectRows(snapshot, mode, entries),
      section('blank-session', ''),
      ...sessionRows(snapshot, entries),
    ],
  };
}

/** The letters the lists answer to: `[d]` only while there is a row to withdraw. */
export function permissionsControls(snapshot: PermissionsSnapshot): readonly PopupControl[] {
  return sheetEntries(snapshot).length > 0 ? [WITHDRAW_CONTROL] : [];
}

/** `text` wrapped under the question, at most {@link MAX_COMMAND_LINES} rows, the last one ending in `…` when the command is longer. */
function commandLines(text: string): string[] {
  const width = POPUP_TEXT_COLUMNS - INDENT.length;
  const lines = wrapPopupText(text, width);
  if (lines.length > MAX_COMMAND_LINES) {
    lines.length = MAX_COMMAND_LINES;
    lines[MAX_COMMAND_LINES - 1] = clipLine(`${lines[MAX_COMMAND_LINES - 1] ?? ''}…`, width);
  }
  return lines.map((line) => `${INDENT}${line}`);
}

/** What every withdrawal line ends with: the direction of the change. */
export const WITHDRAW_NARROWS = 'Withdrawing only narrows what runs without asking.';

/**
 * The withdrawal's line: what is withdrawn (the command, escaped and scrubbed, wrapped and never wider than the popup), what that changes, and
 * that it only narrows. It is at most ten rows of the popup's text width, so it is whole on the page of every placement and is always offered.
 */
export function withdrawLineContent(entry: PermissionEntry): PopupContent {
  const lines: string[] = [];
  if (entry.kind === 'project') {
    lines.push('Withdraw this remembered command?');
    lines.push(
      ...commandLines(`${entryText(entry)} (remembered ${permissionText(entry.row.remembered)})`),
    );
    lines.push('Auto mode will ask about this command again.');
  } else {
    lines.push('Withdraw this session approval?');
    lines.push(...commandLines(entryText(entry)));
    lines.push(
      entry.row.alsoRemembered
        ? 'The project still remembers it: auto may still run it.'
        : 'This command will need approval again.',
    );
  }
  lines.push(WITHDRAW_NARROWS);
  return { kind: 'report', lines };
}

/** The popup's spec: the lists, and the withdrawal's line reached from them (`rail: 'path'`: the lists alone draw no rail). */
export function permissionsSpec(
  origin: PopupOrigin,
  content: PopupContent,
  controls: readonly PopupControl[],
): PopupSpec {
  return {
    id: 'permissions',
    title: '/permissions',
    origin,
    rail: 'path',
    steps: [
      { name: 'Permissions', content, controls },
      {
        name: 'Withdraw',
        content: { kind: 'report', lines: [] },
        back: PERMISSIONS_STEP.list,
        holds: 'chord',
        chord: { verb: 'withdraw', key: 'enter' },
        exitVerb: 'keep',
      },
    ],
  };
}

/** `lead` and the entry's words as one notification of at most {@link POPUP_NOTICE_MAX_COLUMNS}: the words are cut, never the lead. */
function noticeOf(lead: string, words: string): string {
  return `${lead}${clipLine(words, Math.max(1, POPUP_NOTICE_MAX_COLUMNS - displayWidth(lead)))}`;
}

/**
 * What a withdrawal announces on the host's channel: `Withdrawn: npm, 1 argument`, `Withdrawn, with a note: …` (the note is above the lists),
 * `Not withdrawn: …` (why is above the lists), and for a port that threw, its CODE only (`faultCode`: never its message, which can carry a path).
 * At most 54 columns: it is read whole beside a popup's way back.
 */
export function withdrawnAnnouncement(
  entry: PermissionEntry,
  answer: WithdrawAnswer,
  code?: string,
): string {
  if (code !== undefined) return noticeOf('Not withdrawn: ', code);
  const lead: Readonly<Record<WithdrawAnswer['tone'], string>> = {
    done: 'Withdrawn: ',
    note: 'Withdrawn, with a note: ',
    failed: 'Not withdrawn: ',
  };
  return noticeOf(lead[answer.tone], entryText(entry));
}

/**
 * Why `Enter` withdrew nothing, or why `[d]` armed nothing, in at most 54 columns: the host's reason in the words every line uses
 * (`chord-refusal.ts`), then what asks again. After typing (`typed`) a row has to be chosen first: `[d]` arms nothing until a navigation key.
 */
export function withdrawRefusedText(reason: ChordRefusal): string {
  const again =
    reason === 'typed'
      ? `${POPUP_KEYS.select}, then ${keyToken('d')}.`
      : `${keyToken('d')} asks again.`;
  return `Nothing withdrawn: ${CHORD_REFUSAL_PHRASE[reason]}. ${again}`;
}
