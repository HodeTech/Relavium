import type { BoundAgentView } from '../../chat/bound-agent-view.js';
import { NO_TOOLS_DECLARED } from '../../history/agents-model.js';
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
import { displayWidth, sliceDisplayColumns } from './viewport.js';

/**
 * The `/agent` sheet ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §3,
 * MVP-8 step 5): the agent the CURRENT chat is bound to, with the fields of the `/agents` detail and the provider and model the session
 * runs on. A docked, keyboard-owning overlay of the family `/permissions` belongs to ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §1), and the same pure half: the lines to draw and the fold of one keystroke. It owns no `useInput` and imports no React.
 *
 * Read-only by construction: the state is the {@link BoundAgentView} the session's own definition made, so there is nothing to select, to
 * arm or to withdraw. It says two things the definition alone cannot: which declared tools this chat's host does not wire (a mark after the
 * name, and how many are offered), and the file the agent was read from, as a relative label. `Esc` and `Ctrl+C` close it, and every other key is dropped (no key is typing into the composer behind it). It takes
 * no more rows than the permissions sheet does ({@link cardRowBudget}: twelve at 80×24), the rule that carries its title and the legend
 * always drawn, and a field that does not fit is cut with `…` rather than scrolled, because a sheet that scrolls needs keys to scroll with.
 */

/** What a keystroke does to the open sheet: close it, or nothing (the key is dropped). */
export type AgentSheetStep = 'close' | 'stay';

/** The rows the sheet always draws besides the body: the rule that carries the title, and the legend. */
const FIXED_ROWS = 2;
/** The fields that always take one row: the name, the provider, the model and the temperature with the reasoning effort. */
const FIELD_ROWS = 4;
/** What a declared tool is marked with when the chat's host does not wire it: the model is never offered it. */
export const NOT_WIRED_MARK = '(not available in this chat)';
/** The most lines the tool grant and the system prompt's head take, and the fewest the head keeps. */
const TOOL_LINES_MAX = 3;
const TOOL_LINES_AT_FLOOR = 2;
const PROMPT_LINES_MAX = 5;
const PROMPT_LINES_MIN = 3;
/** The fewest lines of the head a grant with marks leaves: its third line goes to the grant. */
const PROMPT_LINES_AT_MARKS = 2;
/** Below this many rows for the tool grant and the head together, the grant is held to {@link TOOL_LINES_AT_FLOOR} lines (three where it has marks). */
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
const NOTICE_ROOM = FIELD_ROWS + 1 + TOOL_LINES_MAX + PROMPT_LINES_MAX;

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
 * The file label cut to `width` display columns FROM THE FRONT, the cut shown by a leading `…`: what tells one agent file from another is the
 * end of its path, which a cut at the end would remove first. A wide character that straddles the cut is left out.
 */
function tailClipped(text: string, width: number): string {
  const total = displayWidth(text);
  if (total <= width) return text;
  if (width <= 1) return sliceDisplayColumns(text, total - Math.max(0, width), total);
  let from = total - (width - 1);
  let kept = sliceDisplayColumns(text, from, total);
  while (displayWidth(kept) > width - 1 && from < total) {
    from += 1;
    kept = sliceDisplayColumns(text, from, total);
  }
  return `…${kept}`;
}

/** One name of the grant as the sheet says it: with its mark when the host does not wire it. */
interface ToolItem {
  readonly text: string;
  readonly marked: boolean;
}

/** The tool grant as the sheet says it: the count that leads (only where a declared tool is not offered), and the names, each with its mark. */
interface ToolsParts {
  readonly lead: string | undefined;
  readonly items: readonly ToolItem[];
}

function toolsParts(view: BoundAgentView): ToolsParts {
  const { detail } = view;
  if (detail.tools.length === 0 && detail.toolsMore === 0)
    return { lead: undefined, items: [{ text: NO_TOOLS_DECLARED, marked: false }] };
  const offer = view.toolOffer;
  // A grant the host wires whole, or a view made without the host's word, is the plain grant of the `/agents` detail.
  const marks = offer !== undefined && offer.offered !== offer.declared ? offer : undefined;
  const names = detail.tools.map(
    (name, index): ToolItem =>
      marks?.unwired[index] === true
        ? { text: `${name} ${NOT_WIRED_MARK}`, marked: true }
        : { text: name, marked: false },
  );
  return {
    lead:
      marks === undefined
        ? undefined
        : `${String(marks.offered)} of ${String(marks.declared)} offered:`,
    items:
      detail.toolsMore > 0
        ? [...names, { text: `… and ${String(detail.toolsMore)} more`, marked: false }]
        : names,
  };
}

/**
 * The tool grant as the definition declares it, and where this chat's host does not wire a declared tool, a mark after its name and how many of
 * the declared tools are offered, in front so a cut of the line keeps it (`2 of 4 offered: read_file, ask_user (not available in this chat)`).
 * A grant the host wires whole, or a view made without the host's word, is the plain grant of the `/agents` detail, with no mark and no count.
 */
export function boundToolsText(view: BoundAgentView): string {
  const { lead, items } = toolsParts(view);
  const names = items.map((item) => item.text).join(', ');
  return lead === undefined ? names : `${lead} ${names}`;
}

/** What stands for a run of offered names a cut left out. */
const LEFT_OUT = '…';

/**
 * `lead` and `items` packed into lines of at most `width` columns, wrapping BETWEEN names and never inside one, so a mark is not split from its
 * name over two lines. A name wider than a line is cut with `…`. Every name is followed by a comma but the last, and a run left out ({@link LEFT_OUT}) by none.
 */
function packedTools(lead: string | undefined, items: readonly string[], width: number): string[] {
  const tokens = [
    ...(lead === undefined ? [] : [lead]),
    ...items.map((item, index) =>
      index < items.length - 1 && item !== LEFT_OUT ? `${item},` : item,
    ),
  ];
  const rows: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current !== '' && displayWidth(`${current} ${token}`) <= width) current += ` ${token}`;
    else {
      if (current !== '') rows.push(current);
      current = token;
    }
  }
  rows.push(current);
  return rows.map((row) => clipLine(row, width));
}

/**
 * The tool grant as lines of at most `max`. Where it does not fit, a cut leaves out OFFERED names before it leaves out a mark, from the last
 * offered name backwards, each run left out shown by one `…`: the count in front says how many are offered, and what the person opened the sheet
 * to see is which tool is not. Only when the marked names alone do not fit is the end of the grant cut, as a grant with no mark always is.
 */
function fittedTools(parts: ToolsParts, width: number, max: number): string[] {
  const { lead, items } = parts;
  let rows = packedTools(
    lead,
    items.map((item) => item.text),
    width,
  );
  if (rows.length <= max || !items.some((item) => item.marked)) return cutToLines(rows, max, width);
  const offered = items.flatMap((item, index) => (item.marked ? [] : [index])).reverse();
  for (let count = 1; count <= offered.length; count += 1) {
    const gone = new Set(offered.slice(0, count));
    const kept: string[] = [];
    items.forEach((item, index) => {
      if (!gone.has(index)) kept.push(item.text);
      else if (kept.at(-1) !== LEFT_OUT) kept.push(LEFT_OUT);
    });
    rows = packedTools(lead, kept, width);
    if (rows.length <= max) return rows;
  }
  return cutToLines(rows, max, width);
}

/** `rows` held to `max` lines, a cut shown by `…` on the last. */
function cutToLines(rows: readonly string[], max: number, width: number): string[] {
  const kept = rows.slice(0, max);
  if (rows.length > max) kept[max - 1] = clipLine(`${kept[max - 1] ?? ''}…`, width);
  return kept;
}

/** The tool grant as a field of at most `max` lines ({@link fittedTools}). */
function toolsField(parts: ToolsParts, width: number, max: number): SheetLine[] {
  const valueWidth = Math.max(1, width - INDENT.length - LABEL_WIDTH);
  return fittedTools(parts, valueWidth, max).map((text, index) =>
    index === 0
      ? field('Tools', text, width)
      : { kind: 'row', text: `${INDENT}${' '.repeat(LABEL_WIDTH)}${text}` },
  );
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
 * The fields of the bound agent, at most `room` lines of them, each clipped to `width`: the name, the file it was read from (a relative label,
 * only for an agent read from a file), the provider and model the session runs on, the temperature and reasoning effort, the tool grant as
 * the definition declares it with the tools this chat does not wire marked ({@link boundToolsText}), and the head of the system prompt. The
 * name, file, provider, model and the pair are always drawn; the grant and the head share what is left (the grant at most two lines where
 * the room is short, the head at least three), and a cut is shown by `…`. Nothing else of the definition is shown: no absolute path, no full
 * prompt, no MCP reference.
 */
export function agentSheetBody(
  view: BoundAgentView,
  width: number,
  room: number,
): readonly SheetLine[] {
  const { detail, sourceLabel } = view;
  const file: SheetLine[] =
    sourceLabel === undefined
      ? []
      : [
          field(
            'File',
            tailClipped(sourceLabel, Math.max(1, width - INDENT.length - LABEL_WIDTH)),
            width,
          ),
        ];
  const left = Math.max(0, room - FIELD_ROWS - file.length);
  // A grant with marks takes its third line, and the head of the prompt keeps two lines instead of three: a mark is what the person opened
  // the sheet to see, and the whole prompt is on the `/agents` page.
  const parts = toolsParts(view);
  const marked = parts.lead !== undefined;
  const promptMin = marked ? PROMPT_LINES_AT_MARKS : PROMPT_LINES_MIN;
  const toolMax =
    left >= ROOM_FOR_FULL_GRANT || (marked && left >= TOOL_LINES_MAX + promptMin)
      ? TOOL_LINES_MAX
      : TOOL_LINES_AT_FLOOR;
  const tools = toolsField(parts, width, toolMax);
  const promptMax = Math.max(promptMin, Math.min(PROMPT_LINES_MAX, left - tools.length));
  const prompt = wrappedField(
    'System prompt',
    detail.promptHead === '' ? EMPTY_PROMPT : detail.promptHead,
    width,
    promptMax,
  );
  return [
    field('Name', nameText(view), width),
    ...file,
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
