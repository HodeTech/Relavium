/**
 * The popup's reducer driver ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §2 and §3):
 * a PURE `(key) → action` mapping and a pure `(frame, action) → step` fold, the pattern the palette uses (`palette-reducer.ts`), so the pickers,
 * the sheets and the reports a command turns into a popup are driven without mounting ink. The popup host (`popup-host.ts`) owns the state and
 * calls this; the Home controller and the chat hosts only route keys to the host.
 *
 * The keys (§3): `↑/↓` select (they skip a row that cannot act, and stop at the ends); `PgUp/PgDn` page and `Home/End` jump; `Enter` answers
 * the step (the command decides what that is: the next step, an apply, a child popup); `Esc` clears a filter first, then goes back one step, and
 * closes on the first step; `Ctrl+C` closes the whole popup and arms no exit window. A letter is a control when the step lists it, typing into
 * the filter when the step has one, and otherwise nothing at all: typed text goes only into a text field. Neither `Esc` nor `Ctrl+C` ever answers.
 */

import { exitKey, type LegendExit, type LegendItem } from '../render/tui/legend.js';
import type { PopupKind } from './geometry.js';
import {
  reportMaxOffset,
  type PopupContent,
  type PopupListRow,
  type PopupOrigin,
} from './frame-model.js';
import type { OpeningKey } from './opening-guard.js';

/** A letter key the step lists, and what it does (`[r] again`). */
export interface PopupControl {
  /** One lower-case letter or digit. */
  readonly key: string;
  readonly verb: string;
}

/** One step of a popup. */
export interface PopupStep {
  /** The rail's name of the step. */
  readonly name: string;
  readonly content: PopupContent;
  /** The letters the step answers to; each is in the legend. */
  readonly controls?: readonly PopupControl[] | undefined;
  /** What `Enter` does on this step, as the legend says it (`apply`, `select`, `details`); absent ⇒ `Enter` does nothing here. */
  readonly enter?: string | undefined;
  /** The step has a filter line that typed text goes into. */
  readonly filter?: boolean | undefined;
  /** The row a list step opens on: the CURRENT value, so a bare `Enter` changes nothing (§3). Absent ⇒ the first row that can act. */
  readonly initialRow?: string | undefined;
  /**
   * The step holds a chord answer or a secret: a sheet that arrives, or a resize below the floor, closes it unanswered and clears what it
   * holds (§2, §4). None of this part's popups has one; the rule is the host's and is pinned here.
   */
  readonly holds?: 'chord' | 'secret' | undefined;
  /** What the `Esc` of this step says it does when it is the first step (default `close`). */
  readonly exitVerb?: string | undefined;
}

/** What a command opens. */
export interface PopupSpec {
  /** A stable name of the command's popup (tests and notifications name it). */
  readonly id: string;
  /** The command's name, drawn on the top edge (`/doctor`). */
  readonly title: string;
  readonly origin: PopupOrigin;
  readonly kind?: PopupKind | undefined;
  readonly steps: readonly PopupStep[];
}

/** The state of one step while the popup is open. */
export interface PopupStepState {
  readonly content: PopupContent;
  /** The highlighted row, an index into the rows the filter leaves. */
  readonly selected: number;
  /** The first line of a report that is shown. */
  readonly offset: number;
  readonly filter: string;
}

/** One open popup: its spec, the step it is on and every step's state (a step it went back from keeps its own). */
export interface PopupFrame {
  readonly spec: PopupSpec;
  /** The popup's run: an asynchronous result carries it, and one for a run that is closed or replaced lands nowhere. */
  readonly runId: number;
  readonly stepIndex: number;
  readonly steps: readonly PopupStepState[];
}

/** The `ink` `Key` fields the popup reads (a structural subset, so a test needs no ink import). */
export interface PopupKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

export type PopupKeyAction =
  | { readonly kind: 'leave' }
  | { readonly kind: 'close-all' }
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'page'; readonly delta: 1 | -1 }
  | { readonly kind: 'jump'; readonly to: 'first' | 'last' }
  | { readonly kind: 'enter' }
  | { readonly kind: 'control'; readonly key: string }
  | { readonly kind: 'append'; readonly text: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'none' };

/** The rows a list step shows: its rows with the filter applied (the label or the detail contains it, case folded). */
export function visibleRows(step: PopupStepState): readonly PopupListRow[] {
  if (step.content.kind !== 'list') return [];
  const query = step.filter.trim().toLowerCase();
  if (query.length === 0) return step.content.rows;
  return step.content.rows.filter(
    (row) =>
      row.label.toLowerCase().includes(query) ||
      (row.detail?.toLowerCase().includes(query) ?? false),
  );
}

const canAct = (row: PopupListRow | undefined): boolean =>
  row !== undefined && row.enabled !== false;

function firstEnabled(rows: readonly PopupListRow[]): number {
  const index = rows.findIndex(canAct);
  return index < 0 ? 0 : index;
}

function lastEnabled(rows: readonly PopupListRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) if (canAct(rows[index])) return index;
  return 0;
}

/** The state a step opens in: on its current value when it names one, else on the first row that can act. */
export function initialStepState(step: PopupStep): PopupStepState {
  const base: PopupStepState = { content: step.content, selected: 0, offset: 0, filter: '' };
  const rows = visibleRows(base);
  const current =
    step.initialRow === undefined ? -1 : rows.findIndex((row) => row.id === step.initialRow);
  return {
    ...base,
    selected: current >= 0 && canAct(rows[current]) ? current : firstEnabled(rows),
  };
}

/** A popup frame as it opens: its first step, every step in its initial state. */
export function openFrame(spec: PopupSpec, runId: number): PopupFrame {
  return { spec, runId, stepIndex: 0, steps: spec.steps.map(initialStepState) };
}

/** The step the frame is on. */
export function currentStep(frame: PopupFrame): {
  readonly spec: PopupStep;
  readonly state: PopupStepState;
} {
  const spec = frame.spec.steps[frame.stepIndex] ?? frame.spec.steps[0];
  const state = frame.steps[frame.stepIndex] ?? frame.steps[0];
  if (spec === undefined || state === undefined) throw new Error('a popup has no steps');
  return { spec, state };
}

/** Map one key to what it means on `step` (see the module header). */
export function reducePopupKey(input: string, key: PopupKey, step: PopupStep): PopupKeyAction {
  if (key.ctrl === true && key.meta !== true && input.toLowerCase() === 'c')
    return { kind: 'close-all' };
  if (input === '\u0003') return { kind: 'close-all' };
  if (key.escape === true) return { kind: 'leave' };
  if (key.return === true) return { kind: 'enter' };
  if (key.upArrow === true) return { kind: 'move', delta: -1 };
  if (key.downArrow === true) return { kind: 'move', delta: 1 };
  if (key.pageUp === true) return { kind: 'page', delta: -1 };
  if (key.pageDown === true) return { kind: 'page', delta: 1 };
  if (key.home === true) return { kind: 'jump', to: 'first' };
  if (key.end === true) return { kind: 'jump', to: 'last' };
  if (key.backspace === true || key.delete === true) return { kind: 'backspace' };
  if (key.ctrl === true || key.meta === true || input.length === 0) return { kind: 'none' };
  const control = step.controls?.find((entry) => entry.key === input);
  if (control !== undefined) return { kind: 'control', key: control.key };
  // Typed text goes only into a text field (§3): a step with no filter takes no typing.
  return step.filter === true ? { kind: 'append', text: input } : { kind: 'none' };
}

/** What a key is, for the opening guard: leaving is always admitted, an answer waits out the settle. */
export function openingKeyOf(action: PopupKeyAction): OpeningKey {
  switch (action.kind) {
    case 'leave':
    case 'close-all':
      return 'leave';
    case 'move':
    case 'page':
    case 'jump':
      return 'navigate';
    case 'enter':
    case 'control':
      return 'answer';
    case 'append':
    case 'backspace':
    case 'none':
      return 'type';
  }
}

/** What one key did to the top popup. */
export type PopupFold =
  /** It stays open in this state (a move, a page, a filter edit, a step back). */
  | { readonly kind: 'frame'; readonly frame: PopupFrame }
  /** `Esc` on its first step: this popup closes (a child returns to its opener). */
  | { readonly kind: 'close' }
  /** `Ctrl+C`: the whole stack closes, and no exit window is armed. */
  | { readonly kind: 'close-all' }
  /** `Enter` on a step that answers it: the command decides (the highlighted row, if the step is a list). */
  | { readonly kind: 'enter'; readonly row: PopupListRow | undefined }
  /** A control letter the step lists. */
  | { readonly kind: 'control'; readonly key: string }
  /** A key the popup has no use for. */
  | { readonly kind: 'unchanged' };

function withStep(frame: PopupFrame, state: PopupStepState): PopupFrame {
  return {
    ...frame,
    steps: frame.steps.map((step, index) => (index === frame.stepIndex ? state : step)),
  };
}

/** The next row from `from` in `direction` that can act, or `from` when there is none (no wrap-around). */
function nextEnabled(rows: readonly PopupListRow[], from: number, direction: 1 | -1): number {
  for (let at = from + direction; at >= 0 && at < rows.length; at += direction)
    if (canAct(rows[at])) return at;
  return from;
}

/** A page of a list: `pageRows` rows on, then the nearest row that can act; it stops at the ends. */
function pageEnabled(
  rows: readonly PopupListRow[],
  from: number,
  direction: 1 | -1,
  pageRows: number,
): number {
  const target = Math.max(0, Math.min(rows.length - 1, from + direction * Math.max(1, pageRows)));
  if (canAct(rows[target])) return target;
  const onward = nextEnabled(rows, target, direction);
  return onward !== target ? onward : nextEnabled(rows, target, direction === 1 ? -1 : 1);
}

function moveIn(
  frame: PopupFrame,
  state: PopupStepState,
  action: PopupKeyAction,
  pageRows: number,
): PopupFold {
  if (state.content.kind === 'report') {
    const max = reportMaxOffset(state.content.lines.length, pageRows);
    const delta =
      action.kind === 'move'
        ? action.delta
        : action.kind === 'page'
          ? action.delta * Math.max(1, pageRows)
          : 0;
    const offset =
      action.kind === 'jump'
        ? action.to === 'first'
          ? 0
          : max
        : Math.max(0, Math.min(max, state.offset + delta));
    return offset === state.offset
      ? { kind: 'unchanged' }
      : { kind: 'frame', frame: withStep(frame, { ...state, offset }) };
  }
  const rows = visibleRows(state);
  if (rows.length === 0) return { kind: 'unchanged' };
  let selected = state.selected;
  if (action.kind === 'move') selected = nextEnabled(rows, state.selected, action.delta);
  else if (action.kind === 'page')
    selected = pageEnabled(rows, state.selected, action.delta, pageRows);
  else if (action.kind === 'jump')
    selected = action.to === 'first' ? firstEnabled(rows) : lastEnabled(rows);
  return selected === state.selected
    ? { kind: 'unchanged' }
    : { kind: 'frame', frame: withStep(frame, { ...state, selected }) };
}

function edited(frame: PopupFrame, state: PopupStepState, filter: string): PopupFold {
  const next = { ...state, filter };
  return {
    kind: 'frame',
    frame: withStep(frame, { ...next, selected: firstEnabled(visibleRows(next)) }),
  };
}

/**
 * Fold one action into the top popup. `pageRows` is the rows a page moves (the list window the frame draws, from the one geometry function).
 */
export function foldPopupAction(
  frame: PopupFrame,
  action: PopupKeyAction,
  pageRows: number,
): PopupFold {
  const { spec, state } = currentStep(frame);
  switch (action.kind) {
    case 'close-all':
      return { kind: 'close-all' };
    case 'leave':
      // `Esc` clears a filter first, then steps back, and closes on the first step (§3).
      if (state.filter.length > 0) return edited(frame, state, '');
      if (frame.stepIndex > 0)
        return { kind: 'frame', frame: { ...frame, stepIndex: frame.stepIndex - 1 } };
      return { kind: 'close' };
    case 'enter': {
      if (spec.enter === undefined) return { kind: 'unchanged' };
      if (state.content.kind !== 'list') return { kind: 'enter', row: undefined };
      const row = visibleRows(state)[state.selected];
      // A row that cannot act answers nothing.
      return canAct(row) ? { kind: 'enter', row } : { kind: 'unchanged' };
    }
    case 'control':
      return { kind: 'control', key: action.key };
    case 'append':
      return edited(frame, state, state.filter + action.text);
    case 'backspace':
      return state.filter.length === 0
        ? { kind: 'unchanged' }
        : edited(frame, state, Array.from(state.filter).slice(0, -1).join(''));
    case 'move':
    case 'page':
    case 'jump':
      return moveIn(frame, state, action, pageRows);
    case 'none':
      return { kind: 'unchanged' };
  }
}

/** The keys the legend names, as the fold above reads them (one table, so a hint cannot say a key does what its handler does not). */
export const POPUP_KEYS = {
  select: '↑/↓',
  scroll: '↑/↓',
  enter: 'Enter',
  leave: 'Esc',
  closeAll: 'Ctrl+C',
} as const;

/**
 * The legend of the top popup's step, built by the one legend builder ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §3): its keys in the order a person reaches for them, then the way back, which is always last and always written. On the first step `Esc`
 * closes (the `close` class, in the step's own word); on a later step it goes back (the `step` class) and `[Ctrl+C] close` is named before it;
 * with a filter typed `Esc` clears it first (a step too). A step that is loading says its `Esc` cancels, which it really does (closing aborts
 * the popup's work).
 */
export function popupLegend(frame: PopupFrame): {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
} {
  const { spec, state } = currentStep(frame);
  const items: LegendItem[] = [];
  if (state.content.kind === 'list' && visibleRows(state).length > 1)
    items.push({ keys: POPUP_KEYS.select, verb: 'select' });
  if (state.content.kind === 'report') items.push({ keys: POPUP_KEYS.scroll, verb: 'scroll' });
  if (spec.enter !== undefined) items.push({ keys: POPUP_KEYS.enter, verb: spec.enter });
  for (const control of spec.controls ?? []) items.push({ keys: control.key, verb: control.verb });
  // Where `Esc` does not close, `Ctrl+C` is named as the key that does, and `Esc` is still the way back the legend ends with: a step (ADR-0145 §2).
  if (state.filter.length > 0) {
    items.push({ keys: POPUP_KEYS.closeAll, verb: 'close' });
    return { items, exit: exitKey.step(POPUP_KEYS.leave, 'clear the filter') };
  }
  if (frame.stepIndex > 0) {
    items.push({ keys: POPUP_KEYS.closeAll, verb: 'close' });
    return { items, exit: exitKey.step(POPUP_KEYS.leave, 'back') };
  }
  const verb = state.content.kind === 'loading' ? 'cancel' : (spec.exitVerb ?? 'close');
  return { items, exit: exitKey.close(POPUP_KEYS.leave, verb) };
}

/** The frame with one step's content replaced (an asynchronous result landing): its selection is kept inside the new rows. */
export function withContent(
  frame: PopupFrame,
  stepIndex: number,
  content: PopupContent,
): PopupFrame {
  return {
    ...frame,
    steps: frame.steps.map((state, index) => {
      if (index !== stepIndex) return state;
      const next = { ...state, content };
      const rows = visibleRows(next);
      const selected = canAct(rows[state.selected]) ? state.selected : firstEnabled(rows);
      return { ...next, selected, offset: 0 };
    }),
  };
}
