/**
 * The `/agents` popup on the Home ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10 as amended
 * 2026-11-27, [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D5; frames `09-agents-list.png` and `11-agent-detail.png`): the
 * project's agents as a list (a name, a title, `✓ ready` or `✗ invalid`) and one agent's read-only detail, where `[c] chat` starts a chat bound to it.
 * It replaces the agents strip of the tab host; the strip's Sessions tab went with it (a saved conversation is `/resume`'s), and the detail points there.
 *
 * - **Read in the popup's own work**, after the first frame (`home-session.ts`), through the very port the strip read (`createAgentsPort`: the
 *   catalog's hardened read, so the list is what `relavium list` and `chat --agent` would find). A fault is a state in the popup, in words.
 * - **A file that did not parse stays a row**, `✗ invalid`, with the catalog's reason under the list while it is highlighted; `Enter` on it says why
 *   there is no detail. It is shown, never hidden.
 * - **`[c]` binds what the person read.** The request carries the catalog's own path of the file the detail showed and the definition it was drawn
 *   from, both read through the port with the row's entry index, never a label, and the host (`startAgentChat`, `agent-start.ts`) reads the file once
 *   through the hardened read and refuses it unless it is still that definition. The popup closes and the chat is built; nothing is sent until the
 *   first message. The Home adds no authority.
 * - **Every stored word** (a slug, a title, a model, a tool, the prompt's head, a file's place) goes through the Home's row scrub (`home-text.ts`).
 *
 * Pure builders and the spec; the state machine that answers the keys is `home-agents-session.ts`. Loaded when the person first opens the popup.
 */

import { agentToolsText, type AgentRow } from '../history/agents-model.js';
import { displayWidth, padTo } from '../render/tui/viewport.js';
import {
  HOME_EXIT_VERB,
  type PopupContent,
  type PopupListRow,
  type PopupOrigin,
} from './frame-model.js';
import { endedWithEllipsis, stored, storedParagraph } from './home-text.js';
import type { PopupControl, PopupSpec } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS, wrapHanging } from './popup-text.js';

/** The popup's steps: the list, and the detail `Enter` opens. */
export const AGENTS_STEP = { list: 0, detail: 1 } as const;

/** `[c] chat`: the one control of the detail. */
export const AGENT_CHAT_CONTROL: PopupControl = { key: 'c', verb: 'chat' };

/** What the list says while the catalog is read. */
export const AGENTS_LOADING_CONTENT: PopupContent = { kind: 'loading', what: 'Reading the agents' };

/** What the list says when the project has no agent. */
export const AGENTS_EMPTY_CONTENT: PopupContent = {
  kind: 'empty',
  what: 'No agents in this project.',
  next: 'Add one under .relavium/agents (see /init).',
};

/** What the list says when the catalog could not be read at all (the next action is inside the TUI). */
export function agentsUnreadableContent(reason?: string): PopupContent {
  return {
    kind: 'error',
    what: 'The agents of this project could not be listed.',
    next: reason === undefined || reason === '' ? 'Close this and try again.' : reason,
  };
}

/** What the detail says when it cannot be made (a definition the list held no longer reads). */
export const AGENT_DETAIL_UNREADABLE: PopupContent = {
  kind: 'error',
  what: 'The agent could not be shown.',
  next: 'Go back and open it again.',
};

/** The widest a slug and a title are drawn: three columns of a row of 66 take 22, 26 and `✓ ready`, with their marker and gaps. */
const SLUG_COLUMNS = 22;
const NAME_COLUMNS = 26;
/** The widest a path or a reason is drawn under the list. */
const PATH_COLUMNS = POPUP_TEXT_COLUMNS;

/** The id of a list row: the entry index of the catalog's read, never a label. */
export const agentRowId = (entryIndex: number): string => `agent:${String(entryIndex)}`;

/** The catalog entry index a row id names, or `undefined` for a heading or a foreign row. */
export function entryIndexOfAgentRow(row: PopupListRow | undefined): number | undefined {
  if (row === undefined || row.section === true) return undefined;
  const match = /^agent:(\d+)$/u.exec(row.id);
  return match === null ? undefined : Number(match[1]);
}

/** `row`'s title when it is not its slug: what the list shows beside the slug. */
function titleOf(row: AgentRow): string {
  return row.name !== undefined && row.name !== row.slug ? stored(row.name, NAME_COLUMNS) : '';
}

/** The list: a heading with the count, then a row per agent file, each ending with its state in a glyph and a word. */
export function agentsListContent(rows: readonly AgentRow[]): PopupContent {
  if (rows.length === 0) return AGENTS_EMPTY_CONTENT;
  const slugs = rows.map((row) => stored(row.slug, SLUG_COLUMNS, '?'));
  const titles = rows.map(titleOf);
  const slugWidth = Math.max(...slugs.map(displayWidth));
  const titleWidth = Math.max(...titles.map(displayWidth));
  const list: PopupListRow[] = [
    {
      id: 'head',
      label: `This project · ${String(rows.length)} ${rows.length === 1 ? 'agent' : 'agents'}`,
      section: true,
      enabled: false,
    },
    ...rows.map(
      (row, at): PopupListRow => ({
        id: agentRowId(row.entryIndex),
        label: padTo(slugs[at] ?? '', slugWidth),
        ...(titleWidth > 0 ? { detail: padTo(titles[at] ?? '', titleWidth) } : {}),
        tail:
          row.state === 'ready'
            ? { status: 'completed', words: 'ready' }
            : { status: 'failed', words: 'invalid' },
        // Under the list while highlighted: where the agent's file is, or why it cannot be opened (the reason first, so a cut takes its end).
        effect:
          row.state === 'ready'
            ? stored(row.path, PATH_COLUMNS)
            : `Cannot open: ${stored(row.note ?? 'its file could not be read', PATH_COLUMNS)}`,
      }),
    ),
  ];
  return { kind: 'list', rows: list };
}

/** One field of the detail: its label, then its value, which wraps under itself. */
function field(label: string, value: string): string[] {
  const lead = `  ${label.padEnd(LABEL_WIDTH)}`;
  return wrapHanging(`${lead}${value}`, POPUP_TEXT_COLUMNS, lead.length);
}

/** The label column of the detail's fields: `Reasoning effort` is the longest. */
const LABEL_WIDTH = 18;
/** The most rows the tool grant and the prompt's head take: the detail stays on one page (18 rows) at 80×24. */
const TOOL_ROWS = 3;
const PROMPT_ROWS = 4;

/** `lines` cut to `rows`, the last ended with `…` when it was cut. */
function boundedRows(lines: readonly string[], rows: number): string[] {
  if (lines.length <= rows) return [...lines];
  const kept = lines.slice(0, rows);
  kept[rows - 1] = `${(kept[rows - 1] ?? '').trimEnd()}…`;
  return kept;
}

/**
 * The head of a prompt cut at a word: the model cuts it after a fixed number of characters (and ends it with `…`), which can fall inside a word
 * (`INP…`); the last word that was cut is dropped, so what is drawn ends on a whole one.
 */
export function wordCut(head: string): string {
  if (!head.endsWith('…')) return head;
  const body = head.slice(0, -1);
  const at = body.search(/\s\S*$/u);
  return `${at > 0 ? body.slice(0, at).trimEnd() : body}…`;
}

/**
 * The head of a prompt as the detail's rows. The model's own cut mark (`…`) is taken off before the scrub (which folds it to three dots, so a head
 * that ended in a full stop read `anything....`) and put back after, as the one ellipsis ending the last row (review round 2, O2-11).
 */
function promptRows(promptHead: string): string[] {
  const cut = wordCut(promptHead);
  const goesOn = cut.endsWith('…');
  const lines = storedParagraph(
    goesOn ? cut.slice(0, -1).trimEnd() : cut,
    POPUP_TEXT_COLUMNS - 2,
    PROMPT_ROWS,
  );
  const last = lines.at(-1);
  if (goesOn && last !== undefined && !last.endsWith('…'))
    lines[lines.length - 1] = endedWithEllipsis(last, POPUP_TEXT_COLUMNS - 2);
  return lines;
}

/** What the detail says of an agent it has no definition for (a file that did not parse has none): never reached from a ready row. */
export function agentDetailContent(row: AgentRow): PopupContent {
  const detail = row.detail;
  if (row.state !== 'ready' || detail === undefined) return AGENT_DETAIL_UNREADABLE;
  const slug = stored(row.slug, SLUG_COLUMNS, '?');
  const name = titleOf(row);
  const tools = boundedRows(
    field('Tools', stored(agentToolsText(detail), POPUP_TEXT_COLUMNS * TOOL_ROWS)),
    TOOL_ROWS,
  );
  const head = promptRows(detail.promptHead).map((line) => `  ${line}`);
  return {
    kind: 'report',
    page: true,
    lines: [
      // Indented as the fields under it are (review round 3, O3-10).
      `  ${name === '' ? slug : `${slug} · ${name}`}`,
      '',
      ...field('Model', stored(detail.model, POPUP_TEXT_COLUMNS - LABEL_WIDTH - 2, 'unknown')),
      ...field(
        'Provider',
        stored(detail.provider, POPUP_TEXT_COLUMNS - LABEL_WIDTH - 2, 'unknown'),
      ),
      ...field(
        'Temperature',
        detail.temperature === undefined ? 'not set' : String(detail.temperature),
      ),
      ...field(
        'Reasoning effort',
        stored(
          detail.reasoningEffort ?? 'not set',
          POPUP_TEXT_COLUMNS - LABEL_WIDTH - 2,
          'not set',
        ),
      ),
      ...tools,
      '',
      'System prompt (the first characters)',
      ...(head.length === 0 ? ['  (empty)'] : head),
      '',
      // The saved conversations are `/resume`'s: the strip's Sessions tab went with the strip.
      'Conversations: /resume lists them',
    ],
  };
}

/** The popup's spec: the list (its way back names the Home) and the detail (`[c] chat`; `Esc` goes back to the list). */
export function homeAgentsSpec(origin: PopupOrigin): PopupSpec {
  return {
    id: 'agents',
    title: '/agents',
    origin,
    steps: [
      {
        name: 'Agents',
        content: AGENTS_LOADING_CONTENT,
        enter: 'details',
        legendKeep: ['Enter'],
        exitVerb: HOME_EXIT_VERB,
      },
      {
        name: 'Detail',
        content: { kind: 'report', lines: [] },
        back: AGENTS_STEP.list,
        controls: [AGENT_CHAT_CONTROL],
        legendKeep: ['c'],
      },
    ],
  };
}
