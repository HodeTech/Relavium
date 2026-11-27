/**
 * The `/workflows` popup on the Home ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10 as amended
 * 2026-11-27, [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D1; frames `14-workflows-list.png` and `17-workflow-detail.png`): the
 * project's workflows as a catalogue (a name, its node count, how its last run stands, `pinned` as a word) and one workflow's detail (its description, the
 * inputs it asks, the chain of its nodes, its file and its last three runs), from which `[r]` runs it, `[x]` exports it and `[p]` pins it. It replaces the
 * Defined tab of the tab host; the run browser is the Runs screen (`[h]`).
 *
 * - **Rows name their entry by index, never by slug.** A slug is the file's word (a pin's ref is whatever `history.db` holds): a row's id is the entry
 *   index of the catalogue's read, and the slug a request carries is what the read says for it (`slugOf`), so a crafted name is a line of text and never
 *   a key, a path or a request. A file that did not parse, a pin whose workflow left the catalogue and a pin of another project stay rows (shown, never
 *   hidden), with a word and a reason; none can be run or exported, and the last two can be unpinned, which keeps the store's cap from holding a slot no
 *   one can free.
 * - **Every stored word** (a name, a description, an input, a node, a file's place, a run's id) goes through the Home's row scrub (`home-text.ts`).
 * - **Every state has a word as well as a glyph**: `✓ done 3h ago`, `‖ waiting 5m`, `✗ failed 2h ago`, `✗ invalid`, `pinned`.
 *
 * Pure builders and the spec; the state machine that answers the keys is `home-workflows-session.ts`. Loaded when the person first opens the popup.
 */

import type { RunStatus } from '@relavium/shared';

import {
  NOT_IN_CATALOG,
  OTHER_PROJECT,
  type DefinedRead,
  type DefinedRow,
} from '../history/defined-model.js';
import type { WorkflowDetail } from '../home/workflow-detail.js';
import { formatAgeOfIso } from '../render/notation.js';
import type { StatusGlyphRole } from '../render/tui/glyphs.js';
import { waitingLabel, rowId } from '../render/tui/home-projection.js';
import { keyToken } from '../render/tui/legend.js';
import {
  HOME_EXIT_VERB,
  type PopupContent,
  type PopupListRow,
  type PopupOrigin,
  type PopupRowTail,
} from './frame-model.js';
import type { HomeWorkflowRun } from './home-port.js';
import { stored, storedParagraph } from './home-text.js';
import type { PopupControl, PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, wrapHanging } from './popup-text.js';

/** The popup's steps: the catalogue, and the detail `Enter` opens. */
export const WORKFLOWS_STEP = { list: 0, detail: 1 } as const;

/** How many of a workflow's last runs the detail lists. */
export const LAST_RUNS = 3;

/** The controls of the catalogue: `[r] run` and `[h] runs`; `[x]` and `[p]` live in the detail, which has the room for them. */
export const RUN_CONTROL: PopupControl = { key: 'r', verb: 'run' };
export const EXPORT_CONTROL: PopupControl = { key: 'x', verb: 'export' };
export const RUNS_CONTROL: PopupControl = { key: 'h', verb: 'runs' };
/** `[p]`: the verb says what it does NOW, for the workflow in front. */
export const pinControl = (pinned: boolean): PopupControl => ({
  key: 'p',
  verb: pinned ? 'unpin' : 'pin',
});
export const LIST_CONTROLS: readonly PopupControl[] = [RUN_CONTROL, RUNS_CONTROL];

/** What `Enter` says on the catalogue, and on a detail that lists runs. */
export const LIST_ENTER = 'details';
export const DETAIL_ENTER = 'open run';

/** What the catalogue says while it is read, and when there is nothing in it. */
export const WORKFLOWS_LOADING_CONTENT: PopupContent = {
  kind: 'loading',
  what: 'Reading the workflows',
};
export const WORKFLOWS_EMPTY_CONTENT: PopupContent = {
  kind: 'empty',
  what: 'No workflows in this project.',
  next: 'Add one under .relavium/workflows (see /init).',
};

/** What the catalogue says when it could not be read at all: the next action is inside the TUI. */
export function workflowsUnreadableContent(reason?: string): PopupContent {
  return {
    kind: 'error',
    what: 'The workflows of this project could not be listed.',
    next: reason === undefined || reason === '' ? 'Close this and try again.' : reason,
  };
}

/** What the detail says while it is read. */
export const DETAIL_LOADING_CONTENT: PopupContent = {
  kind: 'loading',
  what: 'Reading the workflow',
};

/** What the detail says when it could not be read: the reason (the catalogue's own words, scrubbed) and the way on. */
export function detailUnreadableContent(reason?: string): PopupContent {
  return {
    kind: 'error',
    what: 'This workflow could not be read.',
    next:
      reason === undefined || reason === ''
        ? 'Go back and open it again.'
        : `${reason} Go back and open it again.`,
  };
}

const SLUG_COLUMNS = 22;
const NAME_COLUMNS = 40;
const NODES_WIDTH = 8;
/** The id of a catalogue row: the catalogue's entry index (a catalog row), or the pin's row id (a pin the catalogue has no entry for). */
export function workflowRowId(row: DefinedRow): string {
  return row.entryIndex !== undefined
    ? `wf:${String(row.entryIndex)}`
    : `pin:${String(row.pinRowid ?? -1)}`;
}

/** The row of the catalogue's read an id names, or `undefined` for a heading or a foreign id. */
export function definedRowOf(
  read: DefinedRead | undefined,
  row: Pick<PopupListRow, 'id' | 'section'> | undefined,
): DefinedRow | undefined {
  if (read === undefined || row === undefined || row.section === true) return undefined;
  return read.model.rows.find((candidate) => workflowRowId(candidate) === row.id);
}

const padTo = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - [...text].length));

const nodeCountWords = (count: number): string =>
  `${String(count)} ${count === 1 ? 'node' : 'nodes'}`;

/** The glyph role and the word of each run status as the catalogue says it (`completed` is `done`, `paused` is `waiting`). */
const RUN_WORDS: Readonly<
  Record<RunStatus, { readonly status: StatusGlyphRole; readonly word: string }>
> = {
  completed: { status: 'completed', word: 'done' },
  failed: { status: 'failed', word: 'failed' },
  paused: { status: 'paused', word: 'waiting' },
  running: { status: 'running', word: 'running' },
  pending: { status: 'pending', word: 'pending' },
  cancelled: { status: 'cancelled', word: 'cancelled' },
};

/**
 * How a run stands, in words: `done 3h ago`, `failed 2h ago`, `waiting 5m` (the time it has been parked), `running`. The time only with a clock
 * and a time that parses; a run that is going on has none.
 */
export function runStanding(status: RunStatus, at: string | undefined, nowMs: number): string {
  const { word } = RUN_WORDS[status];
  if (status === 'paused') return waitingLabel(at, nowMs) ?? word;
  if (status === 'running' || status === 'pending' || at === undefined) return word;
  const age = formatAgeOfIso(at, nowMs);
  return age === '' ? word : `${word} ${age}`;
}

/** The tail of a catalogue row: how its last run stands (a glyph and words), padded so the `pinned` word after them lines up; none when it has no run. */
function tailOf(row: DefinedRow, nowMs: number, wordsWidth: number): PopupRowTail | undefined {
  if (row.state === 'invalid') return { status: 'failed', words: padTo('invalid', wordsWidth) };
  if (row.state === 'not-in-catalog')
    return { status: 'warning', words: padTo('not in catalog', wordsWidth) };
  if (row.state === 'other-project')
    return { status: 'warning', words: padTo('other project', wordsWidth) };
  const after = row.pinned ? 'pinned' : undefined;
  if (row.lastRunStatus === undefined)
    return after === undefined
      ? undefined
      : { status: 'pending', words: padTo('no run yet', wordsWidth), after };
  return {
    status: RUN_WORDS[row.lastRunStatus].status,
    words: padTo(runStanding(row.lastRunStatus, row.lastRunAt, nowMs), wordsWidth),
    ...(after === undefined ? {} : { after }),
  };
}

/** What the highlighted row says under the catalogue: its file, or why it cannot be run (what it cannot do first, so a cut takes the end). */
function effectOf(row: DefinedRow): string {
  if (row.state === 'ready') return stored(row.path ?? '', POPUP_TEXT_COLUMNS);
  if (row.state === 'invalid')
    return `Cannot run or export: ${stored(row.note ?? 'its file could not be read', POPUP_TEXT_COLUMNS)}`;
  if (row.state === 'not-in-catalog')
    return 'Pinned, but not in the catalog any more. Open it to unpin it.';
  const where = row.projectRoot === undefined ? '' : ` (${stored(row.projectRoot, 30)})`;
  return `Pinned in another project${where}. Open it to unpin it.`;
}

/** The catalogue: a heading with the count, then a row per workflow (its name, its nodes, how its last run stands, `pinned`). */
export function workflowsListContent(
  read: DefinedRead,
  nowMs: number,
  initialRow?: string,
): PopupContent {
  const rows = read.model.rows;
  if (rows.length === 0) return WORKFLOWS_EMPTY_CONTENT;
  const slugs = rows.map((row) => stored(row.slug, SLUG_COLUMNS, '?'));
  const slugWidth = Math.max(...slugs.map((slug) => [...slug].length));
  const standings = rows.map((row) => tailOf(row, nowMs, 0)?.words ?? '');
  const wordsWidth = Math.max(0, ...standings.map((words) => [...words].length));
  const heading: PopupListRow = {
    id: 'head',
    label: `This project · ${String(read.model.total)} ${read.model.total === 1 ? 'workflow' : 'workflows'}`,
    section: true,
    enabled: false,
  };
  const body = rows.map((row, at): PopupListRow => {
    const tail = tailOf(row, nowMs, wordsWidth);
    return {
      id: workflowRowId(row),
      label: padTo(slugs[at] ?? '', slugWidth),
      ...(row.state === 'ready' && row.nodeCount !== undefined
        ? { detail: padTo(nodeCountWords(row.nodeCount), NODES_WIDTH) }
        : { detail: ' '.repeat(NODES_WIDTH) }),
      ...(tail === undefined ? {} : { tail }),
      effect: effectOf(row),
    };
  });
  const more: PopupListRow[] =
    read.model.more > 0
      ? [
          {
            id: 'more',
            label: `… ${String(read.model.more)} more not listed`,
            section: true,
            enabled: false,
          },
        ]
      : [];
  return {
    kind: 'list',
    rows: [heading, ...body, ...more],
    ...(initialRow === undefined ? {} : { initialRow }),
  };
}

/** The label column of the detail's fields: `Inputs`, `Nodes` and `File` are padded to it. */
const FIELD_LABEL = 9;
const DESCRIPTION_ROWS = 3;

/** What choosing a last run of the detail does, said under the list while that run is highlighted (the legend has no room for `Enter open run`). */
const RUN_EFFECT = 'Opens it on the Runs screen.';

function sectionRow(id: string, label: string): PopupListRow {
  return { id, label, section: true, enabled: false };
}

/** A field of the detail: its label, then its words, which wrap under themselves. Each line is a row of its own. */
function fieldRows(id: string, label: string, words: string): PopupListRow[] {
  const lead = `${label.padEnd(FIELD_LABEL)}`;
  return wrapHanging(`${lead}${words}`, POPUP_TEXT_COLUMNS - 2, lead.length).map((line, at) =>
    sectionRow(`${id}:${String(at)}`, line),
  );
}

/** The inputs as one field: `version (string, required)`, `notes (string)`; `none` when it declares none, a count of the rest past the bound. */
function inputsWords(detail: WorkflowDetail): string {
  if (detail.inputs.length === 0) return 'none';
  const shown = detail.inputs.map(
    (input) =>
      `${stored(input.name, 30, '?')} (${stored(input.type, 12, '?')}${input.required ? ', required' : ''})`,
  );
  return detail.inputsMore > 0
    ? `${shown.join(', ')}, … and ${String(detail.inputsMore)} more`
    : shown.join(', ');
}

/** The node chain as one field: ids in the order a run reaches them, a human gate saying what it is and how long it waits. */
function chainWords(detail: WorkflowDetail): string {
  const chain = detail.nodes.map((node) =>
    node.note === undefined
      ? stored(node.id, 30, '?')
      : `${stored(node.id, 30, '?')} (${stored(node.note, 24)})`,
  );
  return detail.nodesMore > 0
    ? `${chain.join(' → ')} → … ${String(detail.nodesMore)} more`
    : chain.join(' → ');
}

/** The id of a last-run row: its place in the list the detail holds, never the run's id. */
export const runRowId = (index: number): string => `run:${String(index)}`;

/** The index of the run a detail row names, or `undefined` for any other row. */
export function runIndexOfRow(row: Pick<PopupListRow, 'id'> | undefined): number | undefined {
  const match = row === undefined ? null : /^run:(\d+)$/u.exec(row.id);
  return match === null || match === undefined ? undefined : Number(match[1]);
}

/** The last runs as rows: how each stands (a glyph and a word), its age, and its first eight characters. */
function runRows(runs: readonly HomeWorkflowRun[], nowMs: number): PopupListRow[] {
  const heading = sectionRow('runs-head', 'Last runs');
  if (runs.length === 0)
    return [heading, sectionRow('runs-none', '  No run of this workflow in this directory yet.')];
  const ages = runs.map((run) =>
    run.status === 'paused'
      ? (waitingLabel(run.at, nowMs) ?? 'waiting').replace(/^waiting\s*/u, '')
      : run.status === 'running' || run.status === 'pending'
        ? ''
        : formatAgeOfIso(run.at, nowMs),
  );
  const ageWidth = Math.max(0, ...ages.map((age) => [...age].length));
  return [
    heading,
    ...runs.map(
      (run, index): PopupListRow => ({
        id: runRowId(index),
        status: RUN_WORDS[run.status].status,
        statusWord: RUN_WORDS[run.status].word,
        label: padTo(ages[index] ?? '', ageWidth),
        detail: rowId(run.runId),
        // The legend row of a stepped popup keeps `[Ctrl+C] close` to the last, so at the floor it has no room for `Enter open run`: the highlighted run says it.
        effect: RUN_EFFECT,
      }),
    ),
  ];
}

/** What a detail holds: the workflow's row, what the file said and its last runs. */
export interface WorkflowDetailView {
  readonly row: DefinedRow;
  readonly detail: WorkflowDetail | undefined;
  readonly runs: readonly HomeWorkflowRun[];
}

/**
 * The detail of a workflow that is in the catalogue (ready): its title, its description, the inputs it asks, the chain of its nodes, its file and
 * its last runs (`Enter` opens one in the Runs screen). A row that is not one (a file that did not parse, a pin with no entry) has a short report
 * of what it is and what can be done with it ({@link unlistedContent}).
 */
export function workflowDetailContent(view: WorkflowDetailView, nowMs: number): PopupContent {
  const { row, detail, runs } = view;
  if (row.state !== 'ready' || detail === undefined) return unlistedContent(row);
  const slug = stored(row.slug, SLUG_COLUMNS, '?');
  const name =
    row.name !== undefined && row.name !== row.slug ? ` · ${stored(row.name, NAME_COLUMNS)}` : '';
  const facts = [
    row.nodeCount === undefined ? undefined : nodeCountWords(row.nodeCount),
    row.pinned ? 'pinned' : undefined,
  ].filter((fact): fact is string => fact !== undefined);
  const description =
    detail.description === undefined
      ? []
      : storedParagraph(detail.description, POPUP_TEXT_COLUMNS - 2, DESCRIPTION_ROWS);
  return {
    kind: 'list',
    rows: [
      sectionRow('title', `${slug}${name}${facts.length === 0 ? '' : `  ·  ${facts.join(' · ')}`}`),
      ...description.map((line, at) => sectionRow(`description:${String(at)}`, line)),
      sectionRow('gap-a', ''),
      ...fieldRows('inputs', 'Inputs', inputsWords(detail)),
      ...fieldRows('nodes', 'Nodes', chainWords(detail)),
      ...fieldRows('file', 'File', stored(row.path ?? '', POPUP_TEXT_COLUMNS - FIELD_LABEL - 2)),
      sectionRow('gap-b', ''),
      ...runRows(runs, nowMs),
    ],
  };
}

/** What a row that is not a workflow of the catalogue says on its detail: what it is, and that it can only be unpinned. */
export function unlistedContent(row: DefinedRow): PopupContent {
  const slug = stored(row.slug, SLUG_COLUMNS, '?');
  const why =
    row.state === 'invalid'
      ? `Its file could not be read: ${stored(row.note ?? 'unknown reason', POPUP_TEXT_COLUMNS - 4)}`
      : row.state === 'not-in-catalog'
        ? `It is pinned, but ${NOT_IN_CATALOG} any more.`
        : `${OTHER_PROJECT}${row.projectRoot === undefined ? '' : `: ${stored(row.projectRoot, POPUP_TEXT_COLUMNS - 30)}`}.`;
  return {
    kind: 'report',
    lines: [
      slug,
      '',
      ...wrapHanging(why, POPUP_TEXT_COLUMNS, 0),
      '',
      row.pinned
        ? `It can be unpinned here (${keyToken('p')}); nothing can be run or exported.`
        : 'Nothing can be run or exported.',
    ],
  };
}

/** The controls a detail answers to: `[r]`, `[x]` and `[p]` for a workflow of the catalogue, `[p]` alone for a pin that is no entry of it. */
export function detailControls(row: DefinedRow): readonly PopupControl[] {
  if (row.state === 'ready') return [RUN_CONTROL, EXPORT_CONTROL, pinControl(row.pinned)];
  return row.pinned ? [pinControl(true)] : [];
}

/** The popup's spec: the catalogue (its way back names the Home) and the detail (`Esc` goes back to the catalogue). */
export function homeWorkflowsSpec(origin: PopupOrigin): PopupSpec {
  return {
    id: 'workflows',
    title: '/workflows',
    origin,
    steps: [
      {
        name: 'Workflows',
        content: WORKFLOWS_LOADING_CONTENT,
        enter: LIST_ENTER,
        legendKeep: ['Enter', 'r', 'h'],
        exitVerb: HOME_EXIT_VERB,
      },
      {
        name: 'Detail',
        content: DETAIL_LOADING_CONTENT,
        back: WORKFLOWS_STEP.list,
        legendKeep: ['r', 'x', 'p', 'Enter'],
      },
    ],
  };
}
