import { AMOUNT_UNAVAILABLE, cutPathLead, cutPathNames, PATH_ELLIPSIS } from '../notation.js';
import { flowLine } from './flow-text.js';
import { homeMargin } from './home-layout.js';
import { LEGEND_SEPARATOR } from './legend.js';
import { displayWidth, sliceDisplayColumns } from './viewport.js';

/**
 * ONE pure model for the status line of the Home and of a chat
 * ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §2): what the
 * line says, in what order, and what it gives up, in what order, when the terminal is too narrow for it. No ink, no clock, no disk, no
 * keychain: the controller resolves the provider, the model and the mode once and passes them in, so nothing on a render path reads
 * anything.
 *
 * - **The Home:** `next chat: <provider> · <model> · <mode> mode[ · effort <e>]`, then THREE spaces and the directory. The label says that
 *   the group is the default for the NEXT chat, and the gap says the directory is not one of those defaults. With neither a provider nor a
 *   model the label goes too (the line says nothing about a model it does not have).
 * - **A chat:** `<provider> · <model> · <mode> mode[ · effort <e>] · <n> turn(s) · <cost>[ · ctx <p>% used]`.
 * - **The budget** is `columns − homeMargin(columns)` (74 at 80 columns, the hint line's), or `columns − leftMargin` when the caller names the
 *   margin it draws at. **What goes first**, stopping as soon as the line
 *   fits. On the Home: the directory (its leading names become `…`, the last name stays whole, down to `…/<last>`), then the model id cut
 *   in its MIDDLE (never under {@link MODEL_FLOOR} columns), then the provider cut at its end (never under {@link PROVIDER_FLOOR}), and
 *   only then, for a last name wider than everything else can spare, the directory by characters (gone altogether below
 *   {@link DIRECTORY_FRAGMENT_MIN} columns). In a chat: the turns, then the context, then the cost switches to its short form, then the
 *   model and the provider as above (the ADR's refinement of OD-9: cost is the signal a person watches against a budget, and
 *   `ctx 18% used` says which way it counts). **The mode word and the effort are NEVER cut or dropped**: they are words the host
 *   enumerates, not free text, so a line is wider than its budget only when they alone, with the label, the two floors and the
 *   separators, are (59 columns on the Home with an effort set: a terminal the Home does not draw, it needs 80).
 * - **A qualified cost never reads as a clean amount.** A cost the accounting could not verify (a lower bound; usage unverified) carries a
 *   qualifier in BOTH of its forms; the caller writes both (`full`: `$0.12 known; usage unverified`, `short`: with its own visible marker),
 *   and this model never writes one of its own. It never drops the cost, it uses the short form only when the full one does not fit, and
 *   it refuses to draw a form that has no qualifier (a bare amount or `free`) for a qualified cost: it draws `unavailable` instead, so a
 *   caller's mistake shows as a missing figure, never as a wrong one.
 * - **Every free string** (provider, model, directory, mode, effort, the cost forms) goes through `flowLine` BEFORE it is measured or cut
 *   (secrets, control and bidirectional characters, host glyphs and chord tokens made inert, a ` · ` inside a value made a ` - `), and every
 *   width is a DISPLAY width, so a wide character cannot overflow the budget. Cuts write the host's own `…` AFTER that pass (the pass
 *   folds an ellipsis a value brought into three dots, which is how a cut stays distinguishable from a value).
 *
 * A data module: it imports nothing from `ink`, `react`, `chalk` or `node:` (ADR-0145 §10).
 */

/** The three spaces between the next chat's defaults and the directory. */
export const HOME_DIRECTORY_GAP = '   ';

/** The label before the Home's defaults: what a person is told the group is. */
export const NEXT_CHAT_LABEL = 'next chat:';

/** The narrowest a model id is cut to; one that is already narrower is not cut. */
export const MODEL_FLOOR = 12;

/** The narrowest a provider name is cut to: its first column and the ellipsis. */
export const PROVIDER_FLOOR = 2;

/** The narrowest a directory that was cut by characters is kept at (`…` and three characters); narrower, it is dropped. */
export const DIRECTORY_FRAGMENT_MIN = 4;

/** What the line can lose or shorten, in the names a caller can show in a `title` or a test can assert. */
export type StatusPart = 'directory' | 'model' | 'provider' | 'turns' | 'context' | 'cost';

/** The cost of a chat in the two forms the caller wrote, and whether it is a qualified figure (a lower bound, or usage unverified). */
export interface StatusCost {
  readonly full: string;
  readonly short: string;
  readonly qualified: boolean;
}

export interface HomeStatusInput {
  readonly surface: 'home';
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly mode: string;
  readonly effort?: string | undefined;
  /** The directory as a label (`directoryLabel` of `notation.ts`); a leading `…` the label itself wrote is kept as a host ellipsis. */
  readonly directory: string;
}

export interface ChatStatusInput {
  readonly surface: 'chat';
  readonly provider?: string | undefined;
  readonly model: string;
  readonly mode: string;
  readonly effort?: string | undefined;
  readonly turns: number;
  readonly cost: StatusCost;
  /** 0 to 100; absent when the model's window is unknown or no turn has completed (the segment is then not drawn). */
  readonly contextPercent?: number | undefined;
}

export type StatusLineInput = HomeStatusInput | ChatStatusInput;

export interface StatusLine {
  readonly text: string;
  /** What was dropped or shortened, in the order it happened: empty when the whole line fits. */
  readonly cut: readonly StatusPart[];
}

// ── measuring and cutting ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The first `columns` display columns of `text` as whole grapheme clusters (a wide character that would straddle the edge is left out). */
function headWithin(text: string, columns: number): string {
  if (columns < 1) return '';
  const head = sliceDisplayColumns(text, 0, columns);
  return displayWidth(head) <= columns ? head : sliceDisplayColumns(text, 0, columns - 1);
}

/** The last `columns` display columns of `text` as whole grapheme clusters (the same rule, from the end). */
function tailWithin(text: string, columns: number): string {
  if (columns < 1) return '';
  const total = displayWidth(text);
  const tail = sliceDisplayColumns(text, total - columns, total);
  return displayWidth(tail) <= columns
    ? tail
    : sliceDisplayColumns(text, total - columns + 1, total);
}

/**
 * `text` cut to at most `width` display columns at its END: the start kept, one `…` after it (`anthropi…`). A text that fits is returned as
 * it is; a width of 1 is the ellipsis alone, and a width of zero or less is the empty string.
 */
export function keepStart(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width < 1) return '';
  return `${headWithin(text, width - 1)}${PATH_ELLIPSIS}`;
}

/**
 * `text` cut to at most `width` display columns in its MIDDLE: both ends kept, one `…` between (`claude-ha…5-5` for `claude-haiku-5-5` in 13
 * columns). The tail takes a quarter of what is kept (a version, an extension), the head the rest; the cut is by whole grapheme clusters,
 * so a wide character is left out rather than split and the result never exceeds `width`. A text that fits is returned as it is. Below three
 * columns there is no room for two ends and the ellipsis, so the start is kept ({@link keepStart}).
 */
export function keepEnds(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width < 3) return keepStart(text, width);
  const kept = width - 1;
  const tailColumns = Math.max(1, Math.floor(kept / 4));
  return `${headWithin(text, kept - tailColumns)}${PATH_ELLIPSIS}${tailWithin(text, tailColumns)}`;
}

/** One free string made safe to draw and measure: the one scrub of a Home flow, one line, trimmed. */
const clean = (text: string): string => flowLine(text).trim();

/** A directory label cleaned, with the ellipsis the LABEL wrote at its front (`…/app`) kept: `clean` would fold it into three dots. */
function cleanDirectory(label: string): string {
  if (!label.startsWith(PATH_ELLIPSIS)) return clean(label);
  return `${PATH_ELLIPSIS}${clean(label.slice(PATH_ELLIPSIS.length))}`;
}

const isText = (text: string | undefined): text is string => text !== undefined && text !== '';

/** `<mode> mode`: a mode is never a bare word, so `auto` reads `auto mode` with or without colour. */
const modeWord = (mode: string): string | undefined => (mode === '' ? undefined : `${mode} mode`);

const effortWord = (effort: string | undefined): string | undefined =>
  isText(effort) ? `effort ${effort}` : undefined;

const joinSegments = (segments: readonly (string | undefined)[]): string =>
  segments.filter(isText).join(LEGEND_SEPARATOR);

// ── the fit loop ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One thing the line gives up: it returns the shape it would draw given by how many columns the line is over, or the same shape when it has nothing to give. */
interface CutStep<Shape> {
  readonly part: StatusPart;
  readonly apply: (shape: Shape, over: number) => Shape;
}

/**
 * Runs `steps` in order over a shape until `measure` says it fits `budget`. A step counts only when it made the line strictly narrower
 * (a short form wider than the full one is not taken, and a part that is already at its floor is not "cut").
 */
function fit<Shape>(
  start: Shape,
  steps: readonly CutStep<Shape>[],
  measure: (shape: Shape) => number,
  budget: number,
): { readonly shape: Shape; readonly cut: readonly StatusPart[] } {
  let shape = start;
  const cut: StatusPart[] = [];
  for (const step of steps) {
    const over = measure(shape) - budget;
    if (over <= 0) break;
    const next = step.apply(shape, over);
    if (measure(next) >= measure(shape)) continue;
    shape = next;
    if (!cut.includes(step.part)) cut.push(step.part);
  }
  return { shape, cut };
}

/**
 * The columns the line has: the terminal's width less the left margin (0 for a width that is not a number). The margin is
 * {@link homeMargin} unless the caller says it draws the line at another left edge (a chat before it has a margin: 0).
 */
function budgetOf(columns: number, leftMargin: number | undefined): number {
  if (!Number.isFinite(columns)) return 0;
  const margin =
    leftMargin !== undefined && Number.isFinite(leftMargin)
      ? Math.max(0, Math.floor(leftMargin))
      : homeMargin(columns);
  return Math.max(0, Math.floor(columns) - margin);
}

/**
 * `text` made `over` columns narrower by `cutter`, but never narrower than `floor` columns: a text that is already within `floor` comes back
 * as it is (the cutter returns a text that fits unchanged).
 */
function narrowed(
  text: string,
  over: number,
  floor: number,
  cutter: (text: string, width: number) => string,
): string {
  return cutter(text, Math.max(floor, displayWidth(text) - over));
}

// ── the Home ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface HomeShape {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly mode: string;
  readonly effort: string | undefined;
  readonly directory: string;
}

function homeText(shape: HomeShape): string {
  const defaults = joinSegments([
    shape.provider,
    shape.model,
    modeWord(shape.mode),
    effortWord(shape.effort),
  ]);
  const named = isText(shape.provider) || isText(shape.model);
  const group = named ? `${NEXT_CHAT_LABEL} ${defaults}` : defaults;
  if (shape.directory === '') return group;
  return group === '' ? shape.directory : `${group}${HOME_DIRECTORY_GAP}${shape.directory}`;
}

/**
 * The directory when nothing else is left to give: the end of its label by characters, to what remains of the budget, and gone altogether
 * (with its gap) when fewer than {@link DIRECTORY_FRAGMENT_MIN} columns remain: a lone `…` or one letter after the gap says nothing.
 */
function lastResortDirectory(directory: string, over: number): string {
  const cutDown = cutPathLead(directory, displayWidth(directory) - over);
  return displayWidth(cutDown) < DIRECTORY_FRAGMENT_MIN ? '' : cutDown;
}

const HOME_STEPS: readonly CutStep<HomeShape>[] = [
  {
    part: 'directory',
    apply: (shape, over) => ({
      ...shape,
      directory: narrowed(shape.directory, over, 1, cutPathNames),
    }),
  },
  {
    part: 'model',
    apply: (shape, over) => ({
      ...shape,
      model:
        shape.model === undefined ? undefined : narrowed(shape.model, over, MODEL_FLOOR, keepEnds),
    }),
  },
  {
    part: 'provider',
    apply: (shape, over) => ({
      ...shape,
      provider:
        shape.provider === undefined
          ? undefined
          : narrowed(shape.provider, over, PROVIDER_FLOOR, keepStart),
    }),
  },
  {
    part: 'directory',
    apply: (shape, over) => ({ ...shape, directory: lastResortDirectory(shape.directory, over) }),
  },
];

function homeStatus(input: HomeStatusInput, budget: number): StatusLine {
  const start: HomeShape = {
    provider: isText(input.provider) ? clean(input.provider) : undefined,
    model: isText(input.model) ? clean(input.model) : undefined,
    mode: clean(input.mode),
    effort: isText(input.effort) ? clean(input.effort) : undefined,
    directory: cleanDirectory(input.directory),
  };
  const fitted = fit(start, HOME_STEPS, (shape) => displayWidth(homeText(shape)), budget);
  return { text: homeText(fitted.shape), cut: fitted.cut };
}

// ── a chat ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ChatShape {
  readonly provider: string | undefined;
  readonly model: string;
  readonly mode: string;
  readonly effort: string | undefined;
  readonly turns: string | undefined;
  /** The cost as drawn now: the full form first, the short one after the step that switches. */
  readonly cost: string;
  readonly shortCost: string;
  readonly context: string | undefined;
}

function chatText(shape: ChatShape): string {
  return joinSegments([
    shape.provider,
    shape.model,
    modeWord(shape.mode),
    effortWord(shape.effort),
    shape.turns,
    shape.cost,
    shape.context,
  ]);
}

const CHAT_STEPS: readonly CutStep<ChatShape>[] = [
  { part: 'turns', apply: (shape) => ({ ...shape, turns: undefined }) },
  { part: 'context', apply: (shape) => ({ ...shape, context: undefined }) },
  {
    part: 'cost',
    // a short form that is empty is no form: the cost is never dropped
    apply: (shape) => (isText(shape.shortCost) ? { ...shape, cost: shape.shortCost } : shape),
  },
  {
    part: 'model',
    apply: (shape, over) => ({
      ...shape,
      model: narrowed(shape.model, over, MODEL_FLOOR, keepEnds),
    }),
  },
  {
    part: 'provider',
    apply: (shape, over) => ({
      ...shape,
      provider:
        shape.provider === undefined
          ? undefined
          : narrowed(shape.provider, over, PROVIDER_FLOOR, keepStart),
    }),
  },
];

/** A figure with nothing but its amount: `$0.1234`, `$12`, `$1,200.50`, and `free` (the compact form of a verified zero). */
const BARE_AMOUNT = /^(?:\$\s?\d[\d,]*(?:\.\d+)?|free)$/iu;

/** A form of a QUALIFIED cost: as the caller wrote it when it carries a qualifier, `unavailable` when it is a bare amount. */
const qualifiedForm = (form: string): string =>
  BARE_AMOUNT.test(form) ? AMOUNT_UNAVAILABLE : form;

function costForms(cost: StatusCost): { readonly full: string; readonly short: string } {
  const full = clean(cost.full);
  const short = clean(cost.short);
  return cost.qualified
    ? { full: qualifiedForm(full), short: qualifiedForm(short) }
    : { full, short };
}

const turnsWord = (turns: number): string => {
  const count = Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0;
  return `${count} ${count === 1 ? 'turn' : 'turns'}`;
};

/** The context figure as the line says it, clamped to 0 to 100; nothing for a figure that is not a number. */
function contextWord(percent: number | undefined): string | undefined {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return `ctx ${Math.min(100, Math.max(0, Math.round(percent)))}% used`;
}

function chatStatus(input: ChatStatusInput, budget: number): StatusLine {
  const cost = costForms(input.cost);
  const start: ChatShape = {
    provider: isText(input.provider) ? clean(input.provider) : undefined,
    model: clean(input.model),
    mode: clean(input.mode),
    effort: isText(input.effort) ? clean(input.effort) : undefined,
    turns: turnsWord(input.turns),
    cost: cost.full,
    shortCost: cost.short,
    context: contextWord(input.contextPercent),
  };
  const fitted = fit(start, CHAT_STEPS, (shape) => displayWidth(chatText(shape)), budget);
  return { text: chatText(fitted.shape), cut: fitted.cut };
}

/**
 * The status line for a surface in `columns` columns: its text, and which parts were dropped or shortened to make it fit
 * (`['turns', 'context']`), for a `title` hint and for a test. See the module header for the wording and the order of loss.
 *
 * `leftMargin` is the columns the caller leaves at the line's left edge; absent, it is the Home's margin ({@link homeMargin}). A chat that draws
 * its status line at column 0 (before it has a margin) passes 0 and has the whole width.
 */
export function statusLine(
  input: StatusLineInput,
  columns: number,
  leftMargin?: number,
): StatusLine {
  const budget = budgetOf(columns, leftMargin);
  return input.surface === 'home' ? homeStatus(input, budget) : chatStatus(input, budget);
}
