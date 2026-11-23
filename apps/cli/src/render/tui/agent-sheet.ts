import type { BoundAgentView } from '../../chat/bound-agent-view.js';
import { agentToolsText } from '../../history/agents-model.js';
import type { ChatKey } from './chat-input.js';
import { sanitizeInline } from '../sanitize.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { legend, legendSpans } from './legend.js';
import {
  SHEET_LEGEND_EMPTY_ITEMS,
  SHEET_MIN_COLUMNS,
  SHEET_MIN_ROWS,
  tooSmallSheetLines,
} from './permissions-sheet.js';
import {
  clampSpans,
  clipLine,
  titleRule,
  usableColumns,
  wrappedLines,
  type SheetGeometry,
  type SheetLine,
  type SheetSpan,
} from './sheet-frame.js';
import { cardRowBudget } from './tool-review-card.js';

/**
 * The `/agent` sheet ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3,
 * MVP-8 step 5): the agent the CURRENT chat is bound to, with the fields of the `/agents` detail and the provider and model the session
 * runs on. A docked, keyboard-owning overlay of the family `/permissions` belongs to ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §1), and the same pure half: the lines to draw and the fold of one keystroke. It owns no `useInput` and imports no React.
 *
 * Read-only by construction: the state is the {@link BoundAgentView} the session's own definition made, so there is nothing to select, to
 * arm or to withdraw. `Esc` and `Ctrl+C` close it, and every other key is dropped (no key is typing into the composer behind it). It takes
 * no more rows than the permissions sheet does ({@link cardRowBudget}: twelve at 80×24), the rule that carries its title and the legend
 * always drawn, and a field that does not fit is cut with `…` rather than scrolled, because a sheet that scrolls needs keys to scroll with.
 */

/** What a keystroke does to the open sheet: close it, or nothing (the key is dropped). */
export type AgentSheetStep = 'close' | 'stay';

/** The rows the sheet always draws besides the body: the rule that carries the title, and the legend. */
const FIXED_ROWS = 2;
/** The fields that always take one row: the name, the provider, the model and the temperature with the reasoning effort. */
const FIELD_ROWS = 4;
/** The most lines the tool grant and the system prompt's head take, and the fewest the head keeps. */
const TOOL_LINES_MAX = 3;
const TOOL_LINES_AT_FLOOR = 2;
const PROMPT_LINES_MAX = 5;
const PROMPT_LINES_MIN = 3;
/** Below this many rows for the tool grant and the head together, the grant is held to {@link TOOL_LINES_AT_FLOOR} lines. */
const ROOM_FOR_FULL_GRANT = 8;
const LABEL_WIDTH = 18;
const INDENT = '  ';
/** The width the first of two fields on one row takes after its label, so the second label starts in one column. */
const PAIR_VALUE_WIDTH = 12;
/** What a row says of a field the definition leaves out, and of a tier the session does not use. */
const NOT_SET = 'not set';
/** What the name row says of the built-in default agent. */
export const BUILT_IN_AGENT_NOTE = 'the built-in chat agent';
/** What the prompt rows say of an agent whose prompt is empty. */
const EMPTY_PROMPT = '(empty)';
/** What a host says when the view of the bound agent cannot be made and the sheet therefore does not open. */
export const AGENT_UNREADABLE = 'Could not read the agent.';
/** The width and the room of the same fields as a notice (a chat with no sheet to open): a notice is not clipped to a terminal. */
const NOTICE_WIDTH = 78;
const NOTICE_ROOM = FIELD_ROWS + TOOL_LINES_MAX + PROMPT_LINES_MAX;

/** The keys that close the sheet: `Esc` and `Ctrl+C`. Every other key, a paste included, is dropped by the host. */
export function foldAgentSheetKey(input: string, key: ChatKey): AgentSheetStep {
  return key.escape === true || isInterruptKey(input, key) ? 'close' : 'stay';
}

export function agentSheetTitle(view: BoundAgentView): string {
  return `Agent · ${view.id}`;
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

/** Two fields on one row, the second label in one column wherever the first value ends. */
function pairedFields(
  first: readonly [label: string, value: string],
  second: readonly [label: string, value: string],
  width: number,
): SheetLine {
  const firstLead = `${INDENT}${first[0].padEnd(LABEL_WIDTH)}`;
  const firstShown = clipLine(first[1], PAIR_VALUE_WIDTH - 1).padEnd(PAIR_VALUE_WIDTH);
  const secondAt = firstLead.length + firstShown.length;
  const text = clipLine(`${firstLead}${firstShown}${second[0]}  ${second[1]}`, width);
  const spans: readonly SheetSpan[] = [
    { from: 0, to: firstLead.length, role: 'dim' },
    { from: secondAt, to: secondAt + second[0].length, role: 'dim' },
  ];
  return { kind: 'row', text, spans: clampSpans(spans, text.length) };
}

/** A field whose value takes up to `max` lines: the label on the first, the rest under the value. */
function wrappedField(label: string, value: string, width: number, max: number): SheetLine[] {
  const valueWidth = Math.max(1, width - INDENT.length - LABEL_WIDTH);
  return wrappedLines(value, valueWidth, max).map((text, index) =>
    index === 0
      ? field(label, text, width)
      : { kind: 'row', text: clipLine(`${INDENT}${' '.repeat(LABEL_WIDTH)}${text}`, width) },
  );
}

/** What the name row says: the agent's own name, and that it is the built-in agent when it is. */
function nameText(view: BoundAgentView): string {
  const name = view.name ?? NOT_SET;
  return view.builtIn ? `${name} · ${BUILT_IN_AGENT_NOTE}` : name;
}

/**
 * What the reasoning-effort field says: the tier the SESSION is using now (the footer's: `/effort` and the `/models` effort step change it on
 * the session and never on the definition), and, only where it differs, the tier the definition declares, so the row never contradicts the
 * footer and never hides what the file says. `not set` is no tier (a model that takes none, or none chosen).
 */
export function effortText(view: BoundAgentView): string {
  const current = view.sessionEffort;
  const declared = view.detail.reasoningEffort;
  if (current === declared) return current ?? NOT_SET;
  return `${current ?? NOT_SET} (declared: ${declared ?? NOT_SET})`;
}

/**
 * The fields of the bound agent, at most `room` lines of them, each clipped to `width`: the name, the provider and model the session runs on,
 * the temperature and reasoning effort, the tool grant as the definition declares it, and the head of the system prompt. The name, provider,
 * model and the pair are always drawn; the grant and the head share what is left (the grant at most two lines where the room is short, the
 * head at least three), and a cut is shown by `…`. Nothing else of the definition is shown: no path, no full prompt, no MCP reference.
 */
export function agentSheetBody(
  view: BoundAgentView,
  width: number,
  room: number,
): readonly SheetLine[] {
  const { detail } = view;
  const left = Math.max(0, room - FIELD_ROWS);
  const toolMax = left >= ROOM_FOR_FULL_GRANT ? TOOL_LINES_MAX : TOOL_LINES_AT_FLOOR;
  const tools = wrappedField('Tools', agentToolsText(detail), width, toolMax);
  const promptMax = Math.max(PROMPT_LINES_MIN, Math.min(PROMPT_LINES_MAX, left - tools.length));
  const prompt = wrappedField(
    'System prompt',
    detail.promptHead === '' ? EMPTY_PROMPT : detail.promptHead,
    width,
    promptMax,
  );
  return [
    field('Name', nameText(view), width),
    field('Provider', detail.provider, width),
    field('Model', detail.model, width),
    pairedFields(
      ['Temperature', detail.temperature === undefined ? NOT_SET : String(detail.temperature)],
      ['Reasoning effort', effortText(view)],
      width,
    ),
    ...tools,
    ...prompt,
  ].slice(0, room);
}

/**
 * The last floor of everything this sheet draws: every line passes `sanitizeInline` once more, as the tab host's lines do at its painter. Every
 * string of the view is already scrubbed where the view is made, so this changes nothing a view built through `boundAgentView` holds; it is
 * here so that a field added later, or a view built another way, cannot put a control sequence on a terminal. A span that the cut leaves
 * outside its line is clamped.
 */
function floored(lines: readonly SheetLine[]): readonly SheetLine[] {
  return lines.map((line) => {
    const text = sanitizeInline(line.text);
    if (text === line.text) return line;
    return {
      ...line,
      text,
      ...(line.spans === undefined ? {} : { spans: clampSpans(line.spans, text.length) }),
    };
  });
}

/**
 * The sheet's lines, top to bottom, for a terminal of this size: the rule that carries the title, the fields, and the legend; below the
 * floor of 80×24 (ADR-0122 §7.3) the title, why, and the way out, exactly as the permissions sheet draws it.
 */
export function agentSheetLines(
  view: BoundAgentView,
  geometry: SheetGeometry,
): readonly SheetLine[] {
  return floored(layoutLines(view, geometry));
}

function layoutLines(view: BoundAgentView, geometry: SheetGeometry): readonly SheetLine[] {
  const title = agentSheetTitle(view);
  if (geometry.columns < SHEET_MIN_COLUMNS || geometry.terminalRows < SHEET_MIN_ROWS)
    return tooSmallSheetLines(title);
  const width = usableColumns(geometry.columns);
  const legendText = clipLine(legend(SHEET_LEGEND_EMPTY_ITEMS), width);
  return [
    titleRule(title, width),
    ...agentSheetBody(view, width, cardRowBudget(geometry.terminalRows) - FIXED_ROWS),
    {
      kind: 'legend',
      text: legendText,
      spans: clampSpans(legendSpans(SHEET_LEGEND_EMPTY_ITEMS), legendText.length),
    },
  ];
}

/**
 * The same fields as a notice, for a chat that has no sheet to open (a plain, `--json` or one-shot chat, which the sheet's keys cannot
 * reach): the title and the body lines, trailing blanks removed, joined by newlines. Built from {@link agentSheetBody}, so the two cannot
 * name different fields.
 */
export function agentNotice(view: BoundAgentView): string {
  return [
    sanitizeInline(agentSheetTitle(view)),
    ...floored(agentSheetBody(view, NOTICE_WIDTH, NOTICE_ROOM)).map((line) => line.text.trimEnd()),
  ].join('\n');
}
