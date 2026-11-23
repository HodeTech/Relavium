import type { AgentRow } from '../../history/agents-model.js';
import type { HomeAgentRequest } from '../../home/agent-start.js';
import type { AgentsRead } from '../../home/agents-port.js';
import type { ChatKey } from './chat-input.js';
import type { LegendItem } from './legend.js';
import {
  clampSpans,
  clipLine,
  flushRow,
  windowBody,
  type SheetLine,
  type SheetSpan,
} from './sheet-frame.js';
import { wrapWords } from './viewport.js';

/**
 * The Defined tab of the `/agents` strip of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3 and its 2026-11-23 note, MVP-8 step 5): the project's agent catalog as a list, and one agent's read-only detail. PURE, like
 * `tab-host.ts` it is drawn into: it holds no port call, no clock and no React. The host reads the catalog (an {@link AgentsRead}, through
 * `home/agents-port.ts`) when the tab is entered; this module says what a key does and which lines to draw.
 *
 * - **One row per file.** A file that parsed is `✓ ready`; one that did not is `✗ invalid` and stays a row, with the catalog's own reason
 *   on the line under the list while it is selected. The model sanitized and bounded every string, so nothing here trusts a label.
 * - **Keys.** `↑`/`↓` move and stop at the ends. `Enter` on a ready agent opens its detail page; on an invalid one it says why there is
 *   none, and opens nothing. `Esc` and `Backspace` leave the detail for the list; `Esc` on the list closes the screen (the tab host's own
 *   rule). `c` on a detail (and Caps Lock's `C`) asks the host to start a chat bound to that agent: the request carries the catalog's own path of
 *   the file the detail showed, never a label, and the definition the detail was drawn from, and the host does the rest (it reads the file once
 *   through the catalog's hardened read, refuses it unless it is still that definition, and binds it through the session build `chat --agent`
 *   uses; the Home adds no authority). Every other key is nothing: no letter of another strip is answered here, and the list has no letter at all.
 * - **The detail is a fixed list of fields**, read-only: the model, the provider, the temperature, the reasoning effort, the tool grant
 *   as the definition declares it and the head of the system prompt. It shows nothing else of the file, and it takes no more rows than
 *   {@link AGENT_DETAIL_ROWS}, so it fits the tab host's budget at the smallest terminal the screen is drawn in.
 */

export type { AgentsPort, AgentsRead } from '../../home/agents-port.js';

/** The Defined agents tab as it stands: what was read, where the cursor is, the open detail, and what the last key had to say. */
export interface AgentsTabState {
  readonly read: AgentsRead;
  /** The selected row; `0` when the list is empty. */
  readonly cursor: number;
  /** The agent whose detail page is open (always a ready row); absent at the list. */
  readonly detail?: AgentRow | undefined;
  /** One sentence the last key left on the list; the next key drops it. */
  readonly message?: string | undefined;
}

/**
 * What a key does on the tab: become another state, or (`c` on a detail) ask the host to start a chat bound to the agent whose file the detail
 * showed. The request is the catalog's own path of that file and the definition the page was drawn from, both read through the port with the
 * row's entry index, so a label (which can look like anything) is never what a chat is bound by, and the host can tell whether the file is still
 * the agent the person read.
 */
export type AgentsStep =
  | { readonly kind: 'state'; readonly state: AgentsTabState }
  | { readonly kind: 'chat'; readonly agent: HomeAgentRequest; readonly state: AgentsTabState };

/** The keys the tab's legend names that are its own. The test presses every one of them. */
export const AGENTS_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  open: { keys: 'Enter', verb: 'open' },
  chat: { keys: '[c]', verb: 'chat' },
  back: { keys: 'Esc', verb: 'back' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** What the tab says when the project has no agent to list. */
export const AGENTS_EMPTY =
  'No agents in this project. Add one under .relavium/agents (see /init).';
/** What the tab says when its port cannot be read, or the Home has none. */
export const AGENTS_UNREADABLE = 'The agents of this project could not be listed.';

/** The most rows the detail page draws: its heading, four fields (the tool grant taking up to three lines), a heading and five lines of the prompt's head. */
export const AGENT_DETAIL_ROWS = 14;
const TOOL_LINES_MAX = 3;
const PROMPT_LINES_MAX = 5;
const LABEL_WIDTH = 18;
const POINTER = '› ';
const INDENT = '  ';

/** The tab opened on `read`, the cursor where it was (kept inside the rows there are now). */
export function openAgentsTab(read: AgentsRead, cursor: number): AgentsTabState {
  const last = read.model.rows.length - 1;
  return { read, cursor: Math.max(0, Math.min(cursor, last)) };
}

/** Why `row` has no detail, in one sentence: the reason comes first, so a narrow terminal cuts the label and not the cause. */
function noDetail(row: AgentRow): string {
  return `${row.slug} cannot be opened: ${row.note ?? 'its file could not be read'}.`;
}

/** Why a detail cannot start a chat: its file is not in the read it was opened from (the list says it, as `Enter` on an invalid row does). */
function noChat(row: AgentRow): string {
  return `${row.slug} cannot be started: its file is not in the catalog.`;
}

/** Fold one key (already past the tab host's own tab keys and `Esc` on the list) into the tab. */
export function foldAgentsKey(state: AgentsTabState, input: string, key: ChatKey): AgentsStep {
  const cleared: AgentsTabState =
    state.message === undefined ? state : { ...state, message: undefined };
  const stay: AgentsStep = { kind: 'state', state: cleared };
  // A chord (`Ctrl+X`, a meta key) is never one of these keys: `c` is a bare letter, and `Ctrl+C` is the tab host's own close.
  if (key.ctrl === true || key.meta === true) return stay;
  if (state.detail !== undefined) {
    if (key.escape === true || key.backspace === true)
      return { kind: 'state', state: { ...cleared, detail: undefined } };
    // A bare letter is the same key with Caps Lock on. Only a READY agent has a detail, so there is no `c` for an invalid one.
    if (input.toLowerCase() !== 'c') return stay;
    const path = state.read.pathOf(state.detail.entryIndex);
    const listed = state.read.definitionOf(state.detail.entryIndex);
    if (path === undefined || listed === undefined)
      return {
        kind: 'state',
        state: { ...cleared, detail: undefined, message: noChat(state.detail) },
      };
    return { kind: 'chat', agent: { path, listed }, state: cleared };
  }
  const rows = state.read.model.rows;
  if (key.upArrow === true || key.downArrow === true) {
    const to = Math.max(
      0,
      Math.min(state.cursor + (key.upArrow === true ? -1 : 1), rows.length - 1),
    );
    return to === state.cursor ? stay : { kind: 'state', state: { ...cleared, cursor: to } };
  }
  if (key.return !== true) return stay;
  const row = rows[state.cursor];
  if (row === undefined) return stay;
  if (row.state !== 'ready' || row.detail === undefined)
    return { kind: 'state', state: { ...cleared, message: noDetail(row) } };
  return { kind: 'state', state: { ...cleared, detail: row } };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

/** The words after the name that say what the row is: a glyph and a word, so the state reads without colour. */
function stateWords(row: AgentRow): string {
  return row.state === 'ready' ? '✓ ready' : '✗ invalid';
}

function rowLine(row: AgentRow, selected: boolean, width: number): SheetLine {
  const name = row.name !== undefined && row.name !== row.slug ? row.name : '';
  const left = `${selected ? POINTER : INDENT}${[row.slug, name].filter((part) => part !== '').join('  ')}`;
  const right = stateWords(row);
  const text = flushRow(left, right, width);
  const spans: SheetSpan[] = [];
  if (!selected && text.endsWith(right))
    spans.push({ from: text.length - right.length, to: text.length, role: 'dim' });
  return { kind: selected ? 'selected' : 'row', text, spans: clampSpans(spans, text.length) };
}

/** What the selected row says about itself, under the list: its file, or why it has no detail. */
function detailLine(row: AgentRow, width: number): SheetLine {
  if (row.state === 'ready') return { kind: 'text', text: clipLine(row.path, width) };
  // What the row cannot do comes first, so a long parse error is the part that is cut.
  return {
    kind: 'text',
    text: clipLine(`Cannot open: ${row.note ?? 'its file could not be read'}`, width),
  };
}

/** A label and its value on one row: the label dimmed. */
function field(label: string, value: string, width: number): SheetLine {
  const lead = `${INDENT}${label.padEnd(LABEL_WIDTH)}`;
  const text = clipLine(`${lead}${value}`, width);
  return {
    kind: 'row',
    text,
    spans: clampSpans([{ from: 0, to: lead.length, role: 'dim' }], text.length),
  };
}

/** `text` wrapped to `width` into at most `max` lines, a cut shown by `…` on the last; never an empty list. */
function wrappedLines(text: string, width: number, max: number): readonly string[] {
  const wrapped = wrapWords(text, Math.max(1, width)).map((line) => line.trimEnd());
  if (wrapped.length <= max) return wrapped;
  const kept = wrapped.slice(0, max);
  kept[max - 1] = clipLine(`${kept[max - 1] ?? ''}…`, width);
  return kept;
}

/** The tool grant as the definition declares it, one string: the names the model kept, then how many it left out. */
function toolsText(row: AgentRow): string {
  const detail = row.detail;
  if (detail === undefined || (detail.tools.length === 0 && detail.toolsMore === 0))
    return 'none declared';
  const names = detail.tools.join(', ');
  return detail.toolsMore > 0
    ? `${names}${names === '' ? '' : ', '}… and ${String(detail.toolsMore)} more`
    : names;
}

/** The detail page of one agent: the fixed fields, and the head of its system prompt. At most {@link AGENT_DETAIL_ROWS} lines. */
function agentDetailLines(row: AgentRow, width: number, room: number): readonly SheetLine[] {
  const detail = row.detail;
  if (detail === undefined) return [{ kind: 'text', text: clipLine(noDetail(row), width) }];
  const name = row.name !== undefined && row.name !== row.slug ? `  ${row.name}` : '';
  const valueWidth = Math.max(1, width - INDENT.length - LABEL_WIDTH);
  const tools = wrappedLines(toolsText(row), valueWidth, TOOL_LINES_MAX);
  const toolRows: SheetLine[] = tools.map((text, index) =>
    index === 0
      ? field('Tools', text, width)
      : { kind: 'row', text: `${INDENT}${' '.repeat(LABEL_WIDTH)}${text}` },
  );
  const head = wrappedLines(
    detail.promptHead === '' ? '(empty)' : detail.promptHead,
    width - INDENT.length,
    PROMPT_LINES_MAX,
  );
  const lines: readonly SheetLine[] = [
    { kind: 'heading', text: clipLine(`${row.slug}${name}`, width) },
    field('Model', detail.model, width),
    field('Provider', detail.provider, width),
    field(
      'Temperature',
      detail.temperature === undefined ? 'not set' : String(detail.temperature),
      width,
    ),
    field('Reasoning effort', detail.reasoningEffort ?? 'not set', width),
    ...toolRows,
    { kind: 'heading', text: 'System prompt (the first characters)' },
    ...head.map((text): SheetLine => ({ kind: 'text', text: `${INDENT}${text}` })),
  ];
  return lines.slice(0, room);
}

/**
 * The tab's lines between the strip and the legend, at most `room` of them. The list (windowed around the cursor, a `▲`/`▼` marker standing
 * for the rows it hides), the selected row's detail line and the message row; or, with a detail open, that agent's page. The detail line and
 * the message keep their lines whether or not they have anything to say, so the list does not move as a message comes and goes.
 */
export function agentsBody(
  state: AgentsTabState,
  width: number,
  room: number,
): readonly SheetLine[] {
  if (state.detail !== undefined) return agentDetailLines(state.detail, width, room);
  const rows = state.read.model.rows;
  const message: SheetLine =
    state.message === undefined
      ? { kind: 'text', text: '' }
      : { kind: 'notice', text: clipLine(state.message, width) };
  if (rows.length === 0) {
    const empty: SheetLine = { kind: 'text', text: clipLine(AGENTS_EMPTY, width) };
    return [empty, message].slice(0, room);
  }
  const height = Math.max(3, room - 2);
  const { start, end } = windowBody(rows.length, state.cursor, height);
  const list: SheetLine[] = rows
    .slice(start, end)
    .map((row, at) => rowLine(row, start + at === state.cursor, width));
  if (start > 0 && list.length > 0)
    list[0] = { kind: 'marker', text: `▲ ${String(start + 1)} more` };
  if (end < rows.length && list.length > 0)
    list[list.length - 1] = { kind: 'marker', text: `▼ ${String(rows.length - end + 1)} more` };
  const selected = rows[state.cursor];
  const detail: SheetLine =
    selected === undefined ? { kind: 'text', text: '' } : detailLine(selected, width);
  return [...list, detail, message];
}

/** The legend's items for the tab: the tab host's own, then the keys that act (only when there is a row, or a detail, to act on). */
export function agentsLegendItems(
  state: AgentsTabState,
  tabItems: readonly LegendItem[],
  closeItem: LegendItem,
): readonly LegendItem[] {
  if (state.detail !== undefined) return [...tabItems, AGENTS_KEYS.chat, AGENTS_KEYS.back];
  if (state.read.model.rows.length === 0) return [...tabItems, closeItem];
  return [...tabItems, AGENTS_KEYS.select, AGENTS_KEYS.open, closeItem];
}
