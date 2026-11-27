/**
 * The `/permissions` popup in a chat ([ADR-0137](../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2, [ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §10; MVP-11 step 5c,
 * `popup-permissions-chat-80x24.png`): the commands remembered for this project and the ones approved for this session, and taking one back.
 * It replaces the chat's docked sheet, with the sheet's content and keys: `↑/↓` select, `[d]` (or `Del`) arms the withdrawal of the highlighted
 * row, and the withdrawal is a line answered by `Enter` through the popup host's guard (`chord.key: 'enter'`: not before 800 ms after its frame
 * was seen, not after 10 s, nothing typed before `[d]` or since), whose `Esc` keeps the row. The bare Home's `/permissions` is this popup's Home variant
 * (`homePermissionsContent`: the project's list and the repository's allowlist, read-only, no session), over the same pure model.
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
  RepoAllowlist,
  WithdrawAnswer,
} from '../permissions/chat-permissions.js';
import { keyToken } from '../render/tui/legend.js';
import { clipLine } from '../render/tui/sheet-frame.js';
import { escapeReviewCharacter } from '../render/tui/tool-review-projection.js';
import { displayWidth, padTo } from '../render/tui/viewport.js';
import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import {
  HOME_EXIT_VERB,
  type PopupContent,
  type PopupListRow,
  type PopupOrigin,
} from './frame-model.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import type { ChordRefusal } from './popup-host.js';
import { POPUP_KEYS, type PopupControl, type PopupSpec } from './popup-reducer.js';
import { storedLine } from './home-text.js';
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

/**
 * The text of a command, with every control, invisible and `<` character shown as the approval card shows it (`<U+202E>`, `<TAB>`): an invisible
 * character is made visible, not removed. Every sink of the popup draws a stored word through it, before its own scrub.
 */
export function escaped(text: string): string {
  return [...text].map((char) => escapeReviewCharacter(char, false)).join('');
}

/** A command string as the popup draws it: escaped as the card shows it, then the popups' one scrub. */
export function permissionText(text: string): string {
  return scrubPopupText(escaped(text));
}

/** The selectable rows, in the order the lists draw them: the project's remembered commands, then the session's approvals. */
export function permissionEntries(snapshot: PermissionsSnapshot): readonly PermissionEntry[] {
  const entries: PermissionEntry[] = [];
  if (snapshot.project.ok)
    for (const row of snapshot.project.rows) entries.push({ kind: 'project', row });
  for (const row of snapshot.session ?? []) entries.push({ kind: 'session', row });
  return entries;
}

/**
 * The one-row note on what a grant is worth ([ADR-0118](../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1),
 * by the chat's mode; the bare Home has no chat (`mode` is `undefined`) and says where a remembered command is run unasked.
 */
export function grantNote(mode: ChatMode | undefined): string {
  switch (mode) {
    case undefined:
      return 'Only auto mode runs a remembered command unasked, in a chat in this project.';
    case 'auto':
      return 'Auto runs approved commands; remembered ones ask again after a file write.';
    case 'plan':
      return 'Plan mode refuses every command; nothing here runs.';
    case 'ask':
    case 'accept-edits':
      return 'Session-approved commands run unasked here; a remembered one still asks.';
  }
}

/** What an empty project list says: in a chat by its mode (`plan` has no cards, so it has nothing to point at), on the Home by where a card is. */
export function emptyProjectText(mode: ChatMode | undefined): string {
  if (mode === undefined)
    return `Nothing is remembered for this project. A command is remembered from its card in a chat (${keyToken('Ctrl+O')}, then ${keyToken('Enter')}).`;
  return mode === 'plan'
    ? 'Nothing is remembered for this project.'
    : `Nothing is remembered for this project. Press ${keyToken('Ctrl+O')} on a command card, then ${keyToken('Enter')}, to remember one.`;
}

/** What a chat's session list says when nothing is approved for it. */
export const EMPTY_SESSION_TEXT = 'Nothing is approved for this session.';

/** The lead of the sentence under a highlighted row, and the key it names. */
const HINT_LEAD = 'Press ';
const HINT_KEY = keyToken('d');

/** What withdrawing the entry would mean, in one sentence: the highlighted row's effect. */
export function withdrawHint(entry: PermissionEntry): string {
  if (entry.kind === 'project')
    return `${HINT_LEAD}${HINT_KEY} to withdraw it: auto mode will ask about this command again.`;
  return entry.row.alsoRemembered
    ? `${HINT_LEAD}${HINT_KEY} to withdraw the session approval; the project still remembers it.`
    : `${HINT_LEAD}${HINT_KEY} to withdraw it: this command will need approval again.`;
}

/** How a stored word (a command, a label, a date) is made fit to draw: the chat's popup uses {@link permissionText}, the Home's {@link homePermissionText}. */
export type PermissionDraw = (text: string) => string;

/**
 * A stored word as the Home's `/permissions` popup draws it: escaped as the card shows it (a control or an override character is a visible token),
 * then the Home's row scrub that every Home popup uses (`home-text.ts`): a `▲ N more` or `▼ N more` is made plain, a `[Enter]` becomes `(Enter)`, so
 * a command a repository wrote cannot forge a marker or a key hint in the list (review round 1, P-5/X-3).
 */
export const homePermissionText: PermissionDraw = (text) => storedLine(escaped(text));

/** The row's words: a remembered command's label, or a session approval's command. */
function entryText(entry: PermissionEntry, draw: PermissionDraw = permissionText): string {
  return draw(entry.kind === 'project' ? entry.row.label : entry.row.text);
}

/** The id of the row of the entry at `index` of `permissionEntries`. */
const rowId = (index: number): string => `entry:${String(index)}`;

/** The entry a row stands for in `snapshot` (the snapshot the rows were built from), or `undefined` for a heading or an unknown row. */
export function entryOfRow(
  snapshot: PermissionsSnapshot,
  row: PopupListRow | undefined,
): PermissionEntry | undefined {
  if (row === undefined || row.section === true) return undefined;
  const match = /^entry:(\d+)$/u.exec(row.id);
  return match === null ? undefined : permissionEntries(snapshot)[Number(match[1])];
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

/** What a withdrawal said that the list alone does not show (a note, a failure), above the lists; nothing for one that was done. */
function resultRows(result: WithdrawAnswer | undefined): PopupListRow[] {
  if (result === undefined || result.tone === 'done') return [];
  return sentence('result', `${result.tone === 'note' ? 'Note' : 'Not withdrawn'}: ${result.text}`);
}

/** The project's remembered commands: the heading, then the rows (dates in one column), the empty sentence or why it cannot be read. */
function projectRows(
  snapshot: PermissionsSnapshot,
  mode: ChatMode | undefined,
  entries: readonly PermissionEntry[],
  draw: PermissionDraw = permissionText,
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
  if (project.rows.length === 0) rows.push(...sentence('project-text', emptyProjectText(mode)));
  const labels = project.rows.map((row) => draw(row.label));
  const pad = Math.min(MAX_LABEL_PAD, Math.max(0, ...labels.map((label) => displayWidth(label))));
  project.rows.forEach((row, at) => {
    const entry = entries[at];
    rows.push({
      id: rowId(at),
      label: padTo(labels[at] ?? '', pad),
      detail: draw(row.remembered),
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
 * The lists, read now, in the chat's mode: what a grant is worth in it ({@link grantNote}), what the last withdrawal said when the list alone
 * does not show it, then the project's remembered commands and this session's approvals, each row's effect the sentence that says what
 * withdrawing it does. With nothing to withdraw at all it is the empty state (what is empty, and how a command is remembered).
 */
export function permissionsContent(
  snapshot: PermissionsSnapshot,
  mode: ChatMode,
  result?: WithdrawAnswer,
): PopupContent {
  const entries = permissionEntries(snapshot);
  if (entries.length === 0)
    return {
      kind: 'empty',
      what: snapshot.project.ok ? emptyProjectText(mode) : snapshot.project.text,
      next: EMPTY_SESSION_TEXT,
    };
  return {
    kind: 'list',
    rows: [
      ...sentence('note', `${mode} mode · ${grantNote(mode)}`),
      ...resultRows(result),
      section('blank-project', ''),
      ...projectRows(snapshot, mode, entries),
      section('blank-session', ''),
      ...sessionRows(snapshot, entries),
    ],
  };
}

/** The most entries of the repository's allowlist the Home's popup draws: its heading, its note and these (the last a count when there are more). */
const ALLOWLIST_ENTRY_ROWS = 4;

/** `count` and its noun: `1 command`, `2 commands`. */
const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The repository's `[chat]` allowlist, read-only, under the remembered commands (the Home's variant): a heading with the counts, the one note
 * that a listed command still asks in a chat, and at most {@link ALLOWLIST_ENTRY_ROWS} entries (the last a count of the rest). The entries are the
 * repository's words (the snapshot masked and bounded them), so each is escaped as a command is and passes the popups' one scrub as a row does.
 */
function allowlistRows(
  list: RepoAllowlist | undefined,
  draw: PermissionDraw = permissionText,
): PopupListRow[] {
  if (list === undefined) return [];
  if (!list.ok)
    return [
      section('allowlist', 'This repository · allowlist, read-only'),
      ...sentence('allowlist-text', list.text),
    ];
  const entries = [
    ...list.commands.map((text) => ({ label: 'command', text })),
    ...list.globs.map((text) => ({ label: 'pattern', text })),
  ];
  const counts = `${plural(list.commands.length, 'command')}, ${plural(list.globs.length, 'pattern')}`;
  const heading = section('allowlist', `This repository · allowlist, read-only (${counts})`);
  if (entries.length === 0)
    return [
      heading,
      ...sentence('allowlist-text', 'Nothing is listed in the repository’s [chat] config.'),
    ];
  const total = entries.length + list.omitted;
  const shown =
    total <= ALLOWLIST_ENTRY_ROWS ? entries : entries.slice(0, ALLOWLIST_ENTRY_ROWS - 1);
  return [
    heading,
    ...sentence('allowlist-note', 'A listed command still asks in a chat; its card only says so.'),
    ...shown.map((entry, at) =>
      section(`allowlist-entry:${String(at)}`, `${entry.label.padEnd(8)}${draw(entry.text)}`),
    ),
    ...(total > shown.length
      ? [section('allowlist-more', `… ${String(total - shown.length)} more in the config`)]
      : []),
  ];
}

/**
 * The lists of the bare Home's `/permissions` popup (MVP-11 unit 8, OD-24 D1): the project's remembered commands (a date each, `[d]` withdraws one
 * behind the same two-step line as a chat's), the repository's allowlist read-only, and the one note that only auto mode runs a remembered command
 * unasked. There is no session on the Home, so no *This session* section and no mode: the note is the project surface's own sentence. With
 * nothing remembered it is a report of the same lines (there is no row to select), and says how a command becomes remembered.
 */
export function homePermissionsContent(
  snapshot: PermissionsSnapshot,
  result?: WithdrawAnswer,
): PopupContent {
  const entries = permissionEntries(snapshot);
  const rows: PopupListRow[] = [
    ...sentence('note', grantNote(undefined)),
    ...resultRows(result),
    section('blank-project', ''),
    ...projectRows(snapshot, undefined, entries, homePermissionText),
    ...(snapshot.allowlist === undefined
      ? []
      : [section('blank-allowlist', ''), ...allowlistRows(snapshot.allowlist, homePermissionText)]),
  ];
  if (entries.length === 0) return { kind: 'report', lines: rows.map((row) => row.label) };
  return { kind: 'list', rows };
}

/** The letters the lists answer to: `[d]` only while there is a row to withdraw. */
export function permissionsControls(snapshot: PermissionsSnapshot): readonly PopupControl[] {
  return permissionEntries(snapshot).length > 0 ? [WITHDRAW_CONTROL] : [];
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
export function withdrawLineContent(
  entry: PermissionEntry,
  draw: PermissionDraw = permissionText,
): PopupContent {
  const lines: string[] = [];
  if (entry.kind === 'project') {
    lines.push('Withdraw this remembered command?');
    lines.push(
      ...commandLines(`${entryText(entry, draw)} (remembered ${draw(entry.row.remembered)})`),
    );
    lines.push('Auto mode will ask about this command again.');
  } else {
    lines.push('Withdraw this session approval?');
    lines.push(...commandLines(entryText(entry, draw)));
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
      {
        name: 'Permissions',
        content,
        controls,
        // On the Home the way back names where it goes (OD-24); a chat's popup says `close`, as it did.
        ...(origin === 'home' ? { exitVerb: HOME_EXIT_VERB } : {}),
      },
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
  draw: PermissionDraw = permissionText,
): string {
  if (code !== undefined) return noticeOf('Not withdrawn: ', code);
  const lead: Readonly<Record<WithdrawAnswer['tone'], string>> = {
    done: 'Withdrawn: ',
    note: 'Withdrawn, with a note: ',
    failed: 'Not withdrawn: ',
  };
  return noticeOf(lead[answer.tone], entryText(entry, draw));
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
