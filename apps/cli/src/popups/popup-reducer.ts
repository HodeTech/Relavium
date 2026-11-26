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
 *
 * On a form (`frame-model.ts` `PopupForm`) `←/→` change its tabs and `↑/↓` (a page, a jump) its radio group's choice, each stopping at the ends;
 * there is no focus to move between them. `Enter` applies the form as a whole (`apply`, with the ids chosen); it is an answer like any other,
 * held behind the opening guard, and the host holds it until the form's own frame has settled (`popup-host.ts`). `←/→` do nothing on any other
 * step (and disarm a confirmation line, as every key but a navigation key does).
 */

import { chordOf, reduceChordKey } from '../render/tui/chord-guard.js';
import { exitKey, waitMark, type LegendExit, type LegendItem } from '../render/tui/legend.js';
import { POPUP_FLOOR, popupGeometry, popupInnerWidth, type PopupKind } from './geometry.js';
import {
  bodyPageRows,
  filterListRows,
  formFits,
  formOptionIndex,
  naturalBodyRows,
  reportLinesFit,
  reportMaxOffset,
  reportPageStep,
  type PopupContent,
  type PopupForm,
  type PopupListRow,
  type PopupOrigin,
} from './frame-model.js';
import type { OpeningKey } from './opening-guard.js';

/** A letter key the step lists, and what it does (`[r] again`). */
export interface PopupControl {
  /** One lower-case letter or digit. */
  readonly key: string;
  readonly verb: string;
  /**
   * The Delete key is this control too (a terminal reports it as `Delete` or as `Backspace`), on a step with no filter, where it edits nothing:
   * `/permissions`' `[d] / Del withdraw`. The legend names both keys.
   */
  readonly deleteKey?: true | undefined;
}

/**
 * The key that answers a confirmation line ({@link PopupStep.chord}): `Ctrl+Y`, a chord typing cannot make (the doctor's deep check, `/cost`'s
 * release), or `Enter` after the line was armed by a control letter (`/permissions`' withdrawal, ADR-0137 §2: `[d]`, then `Enter`). The two
 * are ONE line, answered through the same guard of the host (`popup-host.ts`); only the key differs, and, because `Enter` is a key typing
 * makes, a line answered by it can be armed only by a control letter that no typing came before (the host's rule).
 */
export type LineAnswerKey = 'ctrl-y' | 'enter';

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
   * holds (§2, §4), and the notification channel is held while it is shown. The doctor's and `/cost`'s confirmation lines set `holds: 'chord'`
   * (with `chord`); the rule is the host's (`popup-host.ts`).
   */
  readonly holds?: 'chord' | 'secret' | undefined;
  /**
   * What the `Esc` of this step says it does when it is the first step (default `close`); on a confirmation line that has a step to go back to,
   * what its `Esc` says in place of `back` (`keep`: the withdrawal is not made).
   */
  readonly exitVerb?: string | undefined;
  /**
   * The step `Esc` returns to, and the rail's node before this one. Absent ⇒ the step before it. A popup whose later steps are alternatives
   * reached from its first step, not a sequence (`/doctor`: a row's detail, the deep tier's confirmation line), names it on each of them.
   */
  readonly back?: number | undefined;
  /**
   * The step is the END of a flow: a persistent result the person reads and closes. `Esc` and `Enter` close the popup from it, whatever it
   * shows (there is nothing to go back to: a step back would re-arm what the flow just did), and its legend says `Enter / Esc close`. The rail
   * still counts the steps that led to it (`back`), so it reads `✓ Release ╌╌ ◉ Done`.
   */
  readonly final?: true | undefined;
  /**
   * The step is a confirmation line answered by its answer key and by nothing else (ADR-0148 §3 and §8): `Ctrl+Y` (the default), or `Enter`
   * (`key: 'enter'`, {@link LineAnswerKey}); it also says `holds: 'chord'`. The key answers it only through the host's chord guard
   * (`popup-host.ts`); `Esc`, `Ctrl+C`, a paste and every key that is not a navigation key disarm it (it steps back, answered by nothing).
   * `verb` is the legend's (`[Ctrl+Y] send`, `Enter withdraw`). `deny`, when given, is the verb of the line's explicit No, the one the native
   * chord cards name (`[Ctrl+N] Write nothing`): `Ctrl+N` then denies the line, as `Esc` leaves it (the host tells the command,
   * `PopupHandlers.chordDenied`), and is no key typed over it; a line without one takes `Ctrl+N` as a key typed over it, as before.
   */
  readonly chord?:
    | {
        readonly verb: string;
        readonly key?: LineAnswerKey | undefined;
        readonly deny?: string | undefined;
      }
    | undefined;
  /**
   * The keys the legend keeps longest when the row does not fit, most important first (a control letter, `Enter`); every other key of the
   * step goes first. The way back is always kept.
   */
  readonly legendKeep?: readonly string[] | undefined;
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
  /** The step the popup opens on (default the first): `/doctor --deep` opens on its confirmation line. */
  readonly initialStep?: number | undefined;
  /**
   * What the rail and the top edge's `step 2 of 3` count: `all` (default) every step in order, the ones to come included; `path` only the
   * steps from the first to the current one along `back`, for a popup whose later steps are alternatives rather than a sequence.
   */
  readonly rail?: 'all' | 'path' | undefined;
}

/** The state of one step while the popup is open. */
export interface PopupStepState {
  readonly content: PopupContent;
  /** The highlighted row, an index into the rows the filter leaves. */
  readonly selected: number;
  /** The first line of a report that is shown. */
  readonly offset: number;
  readonly filter: string;
  /**
   * The letters the step answers to NOW, when the command set them with its content ({@link withContent}): a control that exists only once
   * the data is read (`/cost`'s `[r]`, offered only when something is held). Absent ⇒ the step's own `controls`. `[]` ⇒ none.
   */
  readonly controls?: readonly PopupControl[] | undefined;
  /**
   * What `Enter` does on the step NOW, as the legend names it, when the command set it with its content ({@link withContent}): an `Enter` that
   * exists only for some results (the doctor's remedy, offered only on the detail of a row that has one). Absent ⇒ the step's own `enter`;
   * `false` ⇒ none (the step's `Enter` answers nothing, and the legend names no `Enter`).
   */
  readonly enter?: string | false | undefined;
  /** The chosen option of a form's tabs (`selected` is its radio group's). Absent ⇒ the first. */
  readonly tab?: number | undefined;
}

/** What a form was answered with: the id of the chosen option of its tabs and of its radio group (absent for a field the form does not have). */
export interface PopupFormValues {
  readonly tab?: string | undefined;
  readonly radio?: string | undefined;
}

/** One open popup: its spec, the step it is on and every step's state (a step it went back from keeps its own). */
export interface PopupFrame {
  readonly spec: PopupSpec;
  /** The popup's run: an asynchronous result carries it, and one for a run that is closed or replaced lands nowhere. */
  readonly runId: number;
  readonly stepIndex: number;
  readonly steps: readonly PopupStepState[];
  /**
   * The steps the popup has been on, the one it opened on included ({@link visitStep}): the rail marks an earlier step done only when it was
   * one of them, so a popup that opens on a later step (`/cost --release`) never says it went through the steps before it. Absent ⇒ every
   * step before the current one counts as visited (a frame built outside the host).
   */
  readonly visited?: readonly number[] | undefined;
}

/** The `ink` `Key` fields the popup reads (a structural subset, so a test needs no ink import). */
export interface PopupKey {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  /** `←` and `→`: they change a form's tabs, and do nothing on any other step (a confirmation line is disarmed by them, as by any key). */
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  /** `Shift`: an `Enter` with it held is not the answer of a line answered by `Enter`. */
  readonly shift?: boolean;
  /** Which event of the key it was, from a terminal that reports key events (`chord-guard.ts` `ChordKey`); absent ⇒ a press. */
  readonly eventType?: 'press' | 'repeat' | 'release' | undefined;
}

export type PopupKeyAction =
  | { readonly kind: 'leave' }
  | { readonly kind: 'close-all' }
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'page'; readonly delta: 1 | -1 }
  | { readonly kind: 'jump'; readonly to: 'first' | 'last' }
  /** `←` (`-1`) or `→` (`1`): a form's tabs move to the option before or after the chosen one, and stop at the ends. */
  | { readonly kind: 'adjust'; readonly delta: 1 | -1 }
  | { readonly kind: 'enter' }
  | { readonly kind: 'control'; readonly key: string }
  | { readonly kind: 'append'; readonly text: string }
  | { readonly kind: 'backspace' }
  /**
   * The line's answer key on a confirmation line (`Ctrl+Y`, or `Enter` on a line answered by it): the host's chord guard decides whether it
   * answers. `held` marks a key event that is not a press (a held key's repeat or its release, from a terminal that reports key events): it is
   * the answer key that reached the line, and it never answers.
   */
  | { readonly kind: 'chord'; readonly held?: true }
  /**
   * `Ctrl+N` on a confirmation line that names an explicit No (`PopupStep.chord.deny`), a press or a held key's repeat alike: the line is
   * denied. It answers nothing as a Yes, so it needs no wait: it steps back as `Esc` does (closing a line with nothing to go back to), and the
   * host tells the command.
   */
  | { readonly kind: 'deny' }
  /**
   * Any key on a confirmation line that is not its answer key, its deny key, `Esc` or a navigation key: the line is disarmed. `interrupt` is
   * `Ctrl+C` (a cancel, as `Esc` is: the host says nothing); `typed` is every other key (a letter, `Enter` on a `Ctrl+Y` line, `Ctrl+Y` on an
   * `Enter` line, another chord, a `Ctrl+N` on a line that names no No), which the host tells the command about.
   */
  | { readonly kind: 'disarm'; readonly cause: 'typed' | 'interrupt' }
  | { readonly kind: 'none' };

/** The rows a list step shows: its rows with the filter applied (`filterListRows`, the one filter the body draws with too). */
export function visibleRows(step: PopupStepState): readonly PopupListRow[] {
  return step.content.kind === 'list' ? filterListRows(step.content.rows, step.filter) : [];
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

/**
 * The choices of a form as it is (re)built: each field on the option with the id it had in `previous` (a form whose content is replaced keeps
 * what the person chose, by id), else on its own initial option (the CURRENT value).
 */
function formChoices(
  form: PopupForm,
  previous: PopupStepState | undefined,
): { readonly selected: number; readonly tab: number } {
  const before = previous?.content.kind === 'form' ? previous.content : undefined;
  const idOf = (field: 'tabs' | 'radio', index: number | undefined): string | undefined =>
    before?.[field]?.options[index ?? 0]?.id;
  return {
    tab: formOptionIndex(form.tabs, idOf('tabs', previous?.tab)),
    selected: formOptionIndex(form.radio, idOf('radio', previous?.selected)),
  };
}

/** The state a step opens in: on its current value when it names one, else on the first row that can act; a form on its fields' initial options. */
export function initialStepState(step: PopupStep): PopupStepState {
  const base: PopupStepState = { content: step.content, selected: 0, offset: 0, filter: '' };
  if (step.content.kind === 'form') return { ...base, ...formChoices(step.content, undefined) };
  const rows = visibleRows(base);
  const current =
    step.initialRow === undefined ? -1 : rows.findIndex((row) => row.id === step.initialRow);
  return {
    ...base,
    selected: current >= 0 && canAct(rows[current]) ? current : firstEnabled(rows),
  };
}

/**
 * The frame moved to `stepIndex` by the command (not by `Esc`): a form step is entered on its fields' initial options (the CURRENT value, §3),
 * never on the ones a person left on it the last time (a form for another mode or model that finds `New chats` still chosen would write a
 * default where `This chat` was meant). `withContent` keeps a form's choices when its content is replaced under the person's hands (a result
 * landing); entering is not that.
 */
export function enterStep(frame: PopupFrame, stepIndex: number): PopupFrame {
  const steps = frame.steps.map((state, index) =>
    index === stepIndex && index !== frame.stepIndex && state.content.kind === 'form'
      ? { ...state, ...formChoices(state.content, undefined) }
      : state,
  );
  return { ...frame, steps, stepIndex };
}

/** A popup frame as it opens: on its initial step (the first unless the spec names another), every step in its initial state. */
export function openFrame(spec: PopupSpec, runId: number): PopupFrame {
  const initial = spec.initialStep ?? 0;
  const stepIndex =
    Number.isSafeInteger(initial) && initial >= 0 && initial < spec.steps.length ? initial : 0;
  return { spec, runId, stepIndex, steps: spec.steps.map(initialStepState), visited: [stepIndex] };
}

/** The frame with its current step counted as visited ({@link PopupFrame.visited}); the same frame when it already was. */
export function visitStep(frame: PopupFrame): PopupFrame {
  const visited = frame.visited ?? [];
  return visited.includes(frame.stepIndex)
    ? frame
    : { ...frame, visited: [...visited, frame.stepIndex] };
}

/**
 * Whether a confirmation line's content is WHOLLY on a page of `pageRows` rows of `innerWidth` columns ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §8: the line names what leaves and to whom, so it can be answered only when every one of its lines is on screen at once, and whole): a
 * report of at least one line, of no more lines than the page draws, and none of them wider, as drawn, than the row (`reportLinesFit`). A line
 * cut short (`▼ N more`), one whose row is cut with the ellipsis, one that says there is nothing to show, and any other content offer no
 * answer. The host's rule and the legend's are this one function.
 */
export function lineFitsPage(content: PopupContent, pageRows: number, innerWidth: number): boolean {
  return (
    content.kind === 'report' &&
    content.lines.length > 0 &&
    content.lines.length <= pageRows &&
    reportLinesFit(content.lines, innerWidth)
  );
}

/** The step before `index` along `back`, else the one before it, or `-1` from the first: the chain the rail counts. */
function chainBackOf(spec: PopupSpec, index: number): number {
  if (index <= 0) return -1;
  const back = spec.steps[index]?.back;
  return back !== undefined && Number.isSafeInteger(back) && back >= 0 && back < index
    ? back
    : index - 1;
}

/**
 * The step `Esc` returns to from step `index` of `spec` (its `back`, else the one before), or `-1` from the first and from a `final` step:
 * `Esc` closes the popup there.
 */
export function backOf(spec: PopupSpec, index: number): number {
  return spec.steps[index]?.final === true ? -1 : chainBackOf(spec, index);
}

/**
 * The rail and the top edge's count for `frame` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1): every step's name and the current index (`rail: 'all'`), or only the steps from the first to the current one along `back`
 * (`rail: 'path'`), so a detail reached from a report reads `✓ Checks ╌╌ ◉ Detail` and `step 2 of 2`, never a step that is not to come.
 * `done` says, node by node, whether a step before the current one was visited ({@link PopupFrame.visited}): one the popup opened past
 * (`/cost --release` opens on its line) is drawn as a step not done, `○ Cost ╌╌ ◉ Release`, never `✓`.
 */
export function railOf(frame: PopupFrame): {
  readonly names: readonly string[];
  readonly index: number;
  readonly done: readonly boolean[];
} {
  const names = frame.spec.steps.map((step) => step.name);
  const visited = (at: number): boolean =>
    frame.visited === undefined || frame.visited.includes(at);
  if (frame.spec.rail !== 'path')
    return {
      names,
      index: frame.stepIndex,
      done: names.map((_, at) => at < frame.stepIndex && visited(at)),
    };
  const path: number[] = [];
  for (let at = frame.stepIndex; at >= 0; at = chainBackOf(frame.spec, at)) path.unshift(at);
  const index = path.length - 1;
  return {
    names: path.map((at) => names[at] ?? ''),
    index,
    done: path.map((at, node) => node < index && visited(at)),
  };
}

/** Whether the frame's current step is a confirmation line (its `chord`), whichever its answer key. */
export function onChordStep(frame: PopupFrame): boolean {
  return currentStep(frame).spec.chord !== undefined;
}

/** The key that answers `step`'s confirmation line, or `undefined` for a step that is not one. */
export function lineAnswerKeyOf(step: PopupStep): LineAnswerKey | undefined {
  return step.chord === undefined ? undefined : (step.chord.key ?? 'ctrl-y');
}

/** Whether a line of `spec` is answered by `Enter`: then a control letter of it arms nothing after typing (the host's rule). */
export function hasEnterLine(spec: PopupSpec): boolean {
  return spec.steps.some((step) => lineAnswerKeyOf(step) === 'enter');
}

/**
 * Whether `key` is the answer key of a line of `spec` (a press, a repeat or a release): `Ctrl+Y` in every popup, and `Enter` in a popup that has
 * a line answered by it. On a step that is not that line it answers nothing: the host stamps it as a refused affirmative.
 */
export function answersALine(input: string, key: PopupKey, spec: PopupSpec): boolean {
  return (
    lineAnswerOf(input, key, 'ctrl-y') !== undefined ||
    (hasEnterLine(spec) && lineAnswerOf(input, key, 'enter') !== undefined)
  );
}

/** The highlighted row of the frame's current step when it is a list (what a control letter acts on), else `undefined`. */
export function highlightedRow(frame: PopupFrame): PopupListRow | undefined {
  const { state } = currentStep(frame);
  return state.content.kind === 'list' ? visibleRows(state)[state.selected] : undefined;
}

/**
 * The step the frame is on: its spec with the controls and the `Enter` the command set for it now ({@link PopupStepState.controls},
 * {@link PopupStepState.enter}) in place of the spec's, so the key reducer, the legend and the host all read one answer.
 */
export function currentStep(frame: PopupFrame): {
  readonly spec: PopupStep;
  readonly state: PopupStepState;
} {
  const spec = frame.spec.steps[frame.stepIndex] ?? frame.spec.steps[0];
  const state = frame.steps[frame.stepIndex] ?? frame.steps[0];
  if (spec === undefined || state === undefined) throw new Error('a popup has no steps');
  if (state.controls === undefined && state.enter === undefined) return { spec, state };
  const controls = state.controls === undefined ? {} : { controls: state.controls };
  return { spec: { ...spec, ...controls, ...enterOverride(state.enter) }, state };
}

/** What a step's state sets over its spec's `enter` ({@link PopupStepState.enter}): nothing when it sets none, no `Enter` for `false`. */
function enterOverride(enter: string | false | undefined): { readonly enter?: string | undefined } {
  if (enter === undefined) return {};
  return { enter: enter === false ? undefined : enter };
}

/** `Ctrl+C`, as a key and as the byte a terminal sends for it: the interrupt that closes a popup (and only disarms a confirmation line). */
function isInterrupt(input: string, key: PopupKey): boolean {
  return (
    (key.ctrl === true && key.meta !== true && input.toLowerCase() === 'c') || input === '\u0003'
  );
}

/** A key that moves the highlight or scrolls: one of the navigation actions. */
type NavigationAction = Extract<PopupKeyAction, { readonly kind: 'move' | 'page' | 'jump' }>;

/** The navigation keys, in the order they are read (the first flag that is set wins): one table for every step, a line's included. */
const NAVIGATION: readonly (readonly [
  'upArrow' | 'downArrow' | 'pageUp' | 'pageDown' | 'home' | 'end',
  NavigationAction,
])[] = [
  ['upArrow', { kind: 'move', delta: -1 }],
  ['downArrow', { kind: 'move', delta: 1 }],
  ['pageUp', { kind: 'page', delta: -1 }],
  ['pageDown', { kind: 'page', delta: 1 }],
  ['home', { kind: 'jump', to: 'first' }],
  ['end', { kind: 'jump', to: 'last' }],
];

/** The navigation action of `key`, or `undefined` when it is no navigation key. */
function navigationOf(key: PopupKey): NavigationAction | undefined {
  return NAVIGATION.find(([flag]) => key[flag] === true)?.[1];
}

/**
 * Whether `key` is a line's answer key `answer`: a first press (`press`), a held key's repeat or its release (`held`), or `undefined` for any
 * other key. `Ctrl+Y` is the one chord the guard reads (`chordOf`, a press only through `reduceChordKey`); `Enter` is a plain one, with no
 * `Ctrl`, `Meta` or `Shift` held (`Esc` then `Enter` inside a terminal's escape window arrives as `Meta+Enter`, and is not an answer).
 */
function lineAnswerOf(
  input: string,
  key: PopupKey,
  answer: LineAnswerKey,
): 'press' | 'held' | undefined {
  if (answer === 'enter') {
    if (key.return !== true || key.ctrl === true || key.meta === true || key.shift === true)
      return undefined;
    return key.eventType === 'repeat' || key.eventType === 'release' ? 'held' : 'press';
  }
  if (chordOf(input, key) !== 'allow') return undefined;
  return reduceChordKey(input, key) === 'allow' ? 'press' : 'held';
}

/**
 * A key on a confirmation line (a step with `chord`, ADR-0148 §3 and §8): exactly its answer key is the answer (`Ctrl+Y`, or `Enter` on a line
 * answered by it: {@link lineAnswerOf}), `Esc` steps back, the navigation keys move (they disarm nothing), and EVERY other key disarms the line:
 * `Ctrl+C` first disarms rather than closes (a cancel, `interrupt`), and a letter, the other line's key, a `Ctrl+N` on a line that names no
 * explicit No or a key the reducer cannot name is not an answer either (`typed`). On a line that names one, `Ctrl+N` denies it (`deny`). An
 * answer key that is a held key's repeat or its release is still the answer key that reached the line, marked `held`: the host refuses it as
 * one.
 */
function reduceChordStepKey(input: string, key: PopupKey, step: PopupStep): PopupKeyAction {
  const answered = lineAnswerOf(input, key, lineAnswerKeyOf(step) ?? 'ctrl-y');
  if (answered !== undefined)
    return answered === 'press' ? { kind: 'chord' } : { kind: 'chord', held: true };
  if (step.chord?.deny !== undefined && chordOf(input, key) === 'deny') return { kind: 'deny' };
  if (key.escape === true && key.ctrl !== true) return { kind: 'leave' };
  return (
    navigationOf(key) ?? { kind: 'disarm', cause: isInterrupt(input, key) ? 'interrupt' : 'typed' }
  );
}

/**
 * Whether an `Enter` is a plain first press: no `Ctrl`, `Meta` or `Shift` held, and not a held key's repeat or its release from a terminal that
 * reports key events. Anything else answers nothing, on any step: `Esc` then `Enter` inside a terminal's escape window arrives as `Meta+Enter`
 * (the `Enter` of a line is refused the same way, {@link lineAnswerOf}), and a repeat is a key that is held, not pressed: the first one after
 * the terminal's initial repeat delay would otherwise answer what the press before it only opened (a form applied by the held `Enter` that
 * reached it; MVP-11 step 5, security round 1).
 */
function plainEnter(key: PopupKey): boolean {
  if (key.ctrl === true || key.meta === true || key.shift === true) return false;
  return key.eventType !== 'repeat' && key.eventType !== 'release';
}

/** The control a step lists for the Delete key ({@link PopupControl.deleteKey}): only on a step with no filter, and with no `Ctrl` or `Meta` held. */
function deleteControlOf(key: PopupKey, step: PopupStep): PopupControl | undefined {
  if (step.filter === true || key.ctrl === true || key.meta === true) return undefined;
  return step.controls?.find((entry) => entry.deleteKey === true);
}

/** Map one key to what it means on `step` (see the module header). */
export function reducePopupKey(input: string, key: PopupKey, step: PopupStep): PopupKeyAction {
  if (lineAnswerKeyOf(step) !== undefined) return reduceChordStepKey(input, key, step);
  if (isInterrupt(input, key)) return { kind: 'close-all' };
  if (key.escape === true) return { kind: 'leave' };
  if (key.return === true) return plainEnter(key) ? { kind: 'enter' } : { kind: 'none' };
  const navigation = navigationOf(key);
  if (navigation !== undefined) return navigation;
  if (key.leftArrow === true) return { kind: 'adjust', delta: -1 };
  if (key.rightArrow === true) return { kind: 'adjust', delta: 1 };
  if (key.backspace === true || key.delete === true) {
    const control = deleteControlOf(key, step);
    return control === undefined ? { kind: 'backspace' } : { kind: 'control', key: control.key };
  }
  if (key.ctrl === true || key.meta === true || input.length === 0) return { kind: 'none' };
  const control = step.controls?.find((entry) => entry.key === input);
  if (control !== undefined) return { kind: 'control', key: control.key };
  // Typed text goes only into a text field (§3): a step with no filter takes no typing.
  return step.filter === true ? { kind: 'append', text: input } : { kind: 'none' };
}

/** Whether a step's content offers nothing for `Enter`: it says there is nothing (`empty`) or that it failed (`error`). */
function nothingToChoose(content: PopupContent): boolean {
  return content.kind === 'empty' || content.kind === 'error';
}

/** What a key is, for the opening guard: leaving is always admitted, an answer waits out the settle. */
export function openingKeyOf(action: PopupKeyAction): OpeningKey {
  switch (action.kind) {
    // Disarming a confirmation line answers nothing, like leaving: it is admitted on a frame nobody has seen yet. Neither does denying it: a
    // No is the way out the line names, so it needs no wait and is no key typed over the line.
    case 'leave':
    case 'close-all':
    case 'disarm':
    case 'deny':
      return 'leave';
    // Changing a form's tab (`adjust`) decides nothing (only `Enter` applies the form), as moving a highlight decides nothing.
    case 'move':
    case 'page':
    case 'jump':
    case 'adjust':
      return 'navigate';
    case 'enter':
    case 'control':
    case 'chord':
      return 'answer';
    case 'append':
    case 'backspace':
    case 'none':
      return 'type';
  }
}

/**
 * What a key says about typing, for a line answered by `Enter` (`popup-host.ts`: such a line is armed only by a control letter that no typing
 * came before, the rule of the `/permissions` sheet it replaces, ADR-0137 §2): `true` for a key that is typing (a letter that is not a control,
 * `Enter` where it answers nothing, `Backspace`, a key with `Ctrl`, a key typed over a line), `false` for a navigation key (a person choosing a
 * row), and `undefined` for a key that says neither (`Esc`, `Ctrl+C`, a control letter, a line's own answer key, refused or not).
 */
export function typingOf(action: PopupKeyAction): boolean | undefined {
  switch (action.kind) {
    case 'move':
    case 'page':
    case 'jump':
    case 'adjust':
      return false;
    case 'enter':
    case 'append':
    case 'backspace':
    case 'none':
      return true;
    case 'disarm':
      return action.cause === 'typed' ? true : undefined;
    case 'leave':
    case 'close-all':
    case 'deny':
    case 'control':
    case 'chord':
      return undefined;
  }
}

/** What one key did to the top popup. */
export type PopupFold =
  /** It stays open in this state (a move, a page, a filter edit, a step back). */
  | { readonly kind: 'frame'; readonly frame: PopupFrame }
  /** `Esc` on its first step, or `Esc` or `Enter` on a `final` step: this popup closes (a child returns to its opener). */
  | { readonly kind: 'close' }
  /** `Ctrl+C`: the whole stack closes, and no exit window is armed. */
  | { readonly kind: 'close-all' }
  /** `Enter` on a step that answers it: the command decides (the highlighted row, if the step is a list). */
  | { readonly kind: 'enter'; readonly row: PopupListRow | undefined }
  /** `Enter` on a form: the command applies the options chosen (the host first checks that the form is wholly on its page, `formFits`). */
  | { readonly kind: 'apply'; readonly values: PopupFormValues }
  /** A control letter the step lists. */
  | { readonly kind: 'control'; readonly key: string }
  /** `Ctrl+Y` on a confirmation line that is drawn: the host's chord guard decides whether it answers. */
  | { readonly kind: 'chord' }
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
  if (onward !== target) return onward;
  const opposite: 1 | -1 = direction === 1 ? -1 : 1;
  return nextEnabled(rows, target, opposite);
}

/**
 * How far a report scrolls for one `move` or `page`: a line, or a page's step (`reportPageStep`: the rows between its marker rows, so that the
 * line under a marker of one page is drawn on the next and paging alone shows every line).
 */
function scrollDelta(action: NavigationAction, pageRows: number): number {
  if (action.kind === 'move') return action.delta;
  if (action.kind === 'page') return action.delta * reportPageStep(pageRows);
  return 0;
}

/** A report's first shown line after a navigation key: a line or a page on, or an end, never past either end. */
function moveInReport(
  frame: PopupFrame,
  state: PopupStepState,
  lines: number,
  action: NavigationAction,
  pageRows: number,
): PopupFold {
  const max = reportMaxOffset(lines, pageRows);
  let offset: number;
  if (action.kind === 'jump') offset = action.to === 'first' ? 0 : max;
  else offset = Math.max(0, Math.min(max, state.offset + scrollDelta(action, pageRows)));
  return offset === state.offset
    ? { kind: 'unchanged' }
    : { kind: 'frame', frame: withStep(frame, { ...state, offset }) };
}

/** A list's highlighted row after a navigation key (it skips a row that cannot act and stops at the ends). */
function selectedAfter(
  rows: readonly PopupListRow[],
  from: number,
  action: NavigationAction,
  pageRows: number,
): number {
  switch (action.kind) {
    case 'move':
      return nextEnabled(rows, from, action.delta);
    case 'page':
      return pageEnabled(rows, from, action.delta, pageRows);
    case 'jump':
      return action.to === 'first' ? firstEnabled(rows) : lastEnabled(rows);
  }
}

/**
 * A form option `delta` away from `from` in a field of `count` options, stopping at the ends (no wrap-around, as a list's highlight); a page
 * or a jump goes to the end it points at.
 */
function optionAfter(from: number, count: number, action: NavigationAction): number {
  if (count <= 0) return from;
  const last = count - 1;
  switch (action.kind) {
    case 'move':
      return Math.max(0, Math.min(last, from + action.delta));
    case 'page':
      return action.delta < 0 ? 0 : last;
    case 'jump':
      return action.to === 'first' ? 0 : last;
  }
}

/** `↑/↓` (and a page or a jump) on a form: its radio group's choice moves, and nothing happens on a form that has none. */
function moveInForm(
  frame: PopupFrame,
  state: PopupStepState,
  form: PopupForm,
  action: NavigationAction,
): PopupFold {
  const selected = optionAfter(state.selected, form.radio?.options.length ?? 0, action);
  return selected === state.selected
    ? { kind: 'unchanged' }
    : { kind: 'frame', frame: withStep(frame, { ...state, selected }) };
}

/** `←/→` on a form: its tabs' choice moves one option, stopping at the ends; nothing happens on any other content. */
function adjustIn(frame: PopupFrame, state: PopupStepState, delta: 1 | -1): PopupFold {
  if (state.content.kind !== 'form') return { kind: 'unchanged' };
  const from = state.tab ?? 0;
  const tab = optionAfter(from, state.content.tabs?.options.length ?? 0, {
    kind: 'move',
    delta,
  });
  return tab === from
    ? { kind: 'unchanged' }
    : { kind: 'frame', frame: withStep(frame, { ...state, tab }) };
}

function moveIn(
  frame: PopupFrame,
  state: PopupStepState,
  action: NavigationAction,
  pageRows: number,
): PopupFold {
  if (state.content.kind === 'report')
    return moveInReport(frame, state, state.content.lines.length, action, pageRows);
  if (state.content.kind === 'form') return moveInForm(frame, state, state.content, action);
  const rows = visibleRows(state);
  if (rows.length === 0) return { kind: 'unchanged' };
  const selected = selectedAfter(rows, state.selected, action, pageRows);
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
 * `Esc` (`leave`) or a disarmed confirmation line: `Esc` clears a filter first, then steps back (to the step's `back`), and closes on the first
 * step (§3). A disarmed line steps back the same way, answered by nothing.
 */
function foldBack(frame: PopupFrame, state: PopupStepState, leaving: boolean): PopupFold {
  if (leaving && state.filter.length > 0) return edited(frame, state, '');
  const back = backOf(frame.spec, frame.stepIndex);
  return back >= 0 ? { kind: 'frame', frame: { ...frame, stepIndex: back } } : { kind: 'close' };
}

/** The ids of the options a form's state has chosen: what `Enter` applies (a field the form does not have, or one with no option, is absent). */
export function formValues(state: PopupStepState, form: PopupForm): PopupFormValues {
  const tab = form.tabs?.options[state.tab ?? 0]?.id;
  const radio = form.radio?.options[state.selected]?.id;
  return { ...(tab === undefined ? {} : { tab }), ...(radio === undefined ? {} : { radio }) };
}

/** `Enter` on the step the frame is on. */
function foldEnter(spec: PopupStep, state: PopupStepState): PopupFold {
  // The end of a flow closes on `Enter` as on `Esc`, whatever it shows (a failed result too): its legend says `Enter / Esc close`.
  if (spec.final === true) return { kind: 'close' };
  // A step that is loading, or that says there is nothing (empty) or that it failed (error), has nothing for `Enter` to answer.
  if (
    spec.enter === undefined ||
    state.content.kind === 'loading' ||
    nothingToChoose(state.content)
  )
    return { kind: 'unchanged' };
  if (state.content.kind === 'form')
    return { kind: 'apply', values: formValues(state, state.content) };
  if (state.content.kind !== 'list') return { kind: 'enter', row: undefined };
  const row = visibleRows(state)[state.selected];
  // A row that cannot act answers nothing.
  return canAct(row) ? { kind: 'enter', row } : { kind: 'unchanged' };
}

/**
 * Fold one action into the top popup. `pageRows` is the rows of the page the frame draws the step's body in (from the one geometry function):
 * a list's page moves the highlight by it, and a report's by its step between the marker rows (`reportPageStep`). A host that has judged a
 * `Ctrl+Y` itself folds every other action, and gets no `chord` back (the first signature).
 */
export function foldPopupAction(
  frame: PopupFrame,
  action: Exclude<PopupKeyAction, { readonly kind: 'chord' }>,
  pageRows: number,
): Exclude<PopupFold, { readonly kind: 'chord' }>;
export function foldPopupAction(
  frame: PopupFrame,
  action: PopupKeyAction,
  pageRows: number,
): PopupFold;
export function foldPopupAction(
  frame: PopupFrame,
  action: PopupKeyAction,
  pageRows: number,
): PopupFold {
  const { spec, state } = currentStep(frame);
  // A step that is still loading has nothing to answer: its `Enter`, its controls and its chord do nothing until its content lands.
  const loading = state.content.kind === 'loading';
  switch (action.kind) {
    case 'close-all':
      return { kind: 'close-all' };
    case 'leave':
    case 'disarm':
    case 'deny':
      return foldBack(frame, state, action.kind === 'leave');
    case 'chord':
      // Only a line that is drawn can be answered: one still being prepared, or one with nothing to confirm, takes no chord.
      return spec.chord === undefined || state.content.kind !== 'report'
        ? { kind: 'unchanged' }
        : { kind: 'chord' };
    case 'enter':
      return foldEnter(spec, state);
    case 'control':
      return loading ? { kind: 'unchanged' } : { kind: 'control', key: action.key };
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
    case 'adjust':
      return adjustIn(frame, state, action.delta);
    case 'none':
      return { kind: 'unchanged' };
  }
}

/** The keys the legend names, as the fold above reads them (one table, so a hint cannot say a key does what its handler does not). */
export const POPUP_KEYS = {
  select: '↑/↓',
  scroll: '↑/↓',
  /** The keys that change a form's tabs (`←/→ effort`). */
  adjust: '←/→',
  enter: 'Enter',
  leave: 'Esc',
  closeAll: 'Ctrl+C',
  chord: 'Ctrl+Y',
  /** The explicit No of a line that names one (`PopupStep.chord.deny`). */
  deny: 'Ctrl+N',
  /** The Delete key, named beside the control letter it also is (`[d] / Del withdraw`). */
  delete: 'Del',
  /** The keys that close the result step of a flow (`Enter / Esc close`). */
  finish: ['Enter', 'Esc'],
} as const;

/**
 * The rows of the page `frame`'s step is drawn in on a standard popup at the floor (80×24, the alternate screen; `bodyPageRows`): the page
 * {@link popupLegend} judges an overflow, a confirmation line and a form on when its caller has no geometry of its own.
 */
function floorPageRows(frame: PopupFrame): number {
  const { spec, state } = currentStep(frame);
  const filter = spec.filter === true ? state.filter : undefined;
  const kind = frame.spec.kind ?? 'standard';
  const geometry = popupGeometry({
    columns: POPUP_FLOOR.columns,
    rows: POPUP_FLOOR.rows,
    kind,
    placement: 'overlay',
    rail: railOf(frame).names.length > 1,
    bodyRows: naturalBodyRows(
      state.content,
      { ...state, filter },
      undefined,
      popupInnerWidth(POPUP_FLOOR.columns, kind),
    ),
  });
  return geometry.fits ? bodyPageRows(state.content, filter !== undefined, geometry) : 1;
}

/** The columns a row of `frame`'s body may use on a popup of its kind at the floor (80×24): the row {@link popupLegend} judges a line's width on when its caller has no geometry of its own. */
function floorInnerWidth(frame: PopupFrame): number {
  return popupInnerWidth(POPUP_FLOOR.columns, frame.spec.kind ?? 'standard');
}

/**
 * The legend of the top popup's step, built by the one legend builder ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §3): its keys in the order a person reaches for them, then the way back, which is always last and always written. The way back says what
 * `Esc` does there: it goes back (the `step` class, `Esc back`) wherever the step has a step to go back to, and `[Ctrl+C] close` is named before
 * it on a step that is not a confirmation line; it closes on the first step (the `close` class, in the step's own word); with a filter typed it
 * clears the filter first (a step too); and it says `cancel` only where it stops work in flight: a first step that is loading (closing aborts
 * the popup's work). `↑/↓ scroll` is named only for a report that does not fit its page, a confirmation line names its answer only when it
 * does fit, every line of it whole, and a form names its `Enter` only when it is wholly on its page: `pageRows`, the rows the frame draws the
 * step's body in (`bodyPageRows`), and `innerWidth`, the columns of each of its rows (the slot passes its geometry's); absent ⇒ the page and the
 * row of a popup of the frame's kind at the floor. `locked` is the host's lock (`PopupHost.lock`): while it holds, a confirmation line's answer
 * and a guarded form's `Enter` wait (`[Ctrl+Y] send (wait)`, `Enter apply (wait)`: dim, ADR-0145 §3); no other key ever does.
 */
export function popupLegend(
  frame: PopupFrame,
  pageRows?: number,
  innerWidth?: number,
  locked = false,
): PopupLegend {
  const { spec, state } = currentStep(frame);
  // The end of a flow is a result: `Enter` and `Esc` both close it, and it names nothing else (a result that is still being read says so).
  if (spec.final === true)
    return { items: [], exit: exitKey.close(POPUP_KEYS.finish, spec.exitVerb ?? 'close') };
  const back = backOf(frame.spec, frame.stepIndex) >= 0;
  const page = (): number => pageRows ?? floorPageRows(frame);
  const width = (): number => innerWidth ?? floorInnerWidth(frame);
  if (spec.chord !== undefined) return chordLegend(spec, state, back, page, width, locked);
  const items = stepItems(spec, state, page, width, locked);
  const keep = spec.legendKeep;
  const finish = (exit: LegendExit): PopupLegend =>
    keep === undefined ? { items, exit } : { items, exit, priority: legendPriority(items, keep) };
  // Where `Esc` does not close, `Ctrl+C` is named as the key that does, and `Esc` is still the way back the legend ends with: a step (ADR-0145
  // §2). With a filter typed `Esc` clears it first; otherwise it goes back.
  const filtered = state.filter.length > 0;
  if (filtered || back) {
    items.push({ keys: POPUP_KEYS.closeAll, verb: 'close' });
    return finish(exitKey.step(POPUP_KEYS.leave, filtered ? 'clear the filter' : 'back'));
  }
  return finish(exitKey.close(POPUP_KEYS.leave, closingVerb(spec, state)));
}

/** A popup step's legend: its items, the way back, and how long each item is kept when the row does not fit. */
export interface PopupLegend {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
  /** How long each item is kept when the row does not fit (higher is kept longer), parallel to `items`; absent ⇒ by position. */
  readonly priority?: readonly number[];
}

/** What the `Esc` of a first step says: `cancel` where closing stops work in flight (it is loading), else the step's own word. */
function closingVerb(spec: PopupStep, state: PopupStepState): string {
  return state.content.kind === 'loading' ? 'cancel' : (spec.exitVerb ?? 'close');
}

/** The mark of a step's `Enter` while the host's lock holds: only a guarded form's (`PopupForm.guarded`) waits, never another step's. */
function enterWaits(locked: boolean, state: PopupStepState): { readonly wait?: true } {
  return waitMark(locked && state.content.kind === 'form' && state.content.guarded === true);
}

/** The key each kind of line is answered by, as the legend names it. */
const LINE_KEYS: Readonly<Record<LineAnswerKey, string>> = {
  'ctrl-y': POPUP_KEYS.chord,
  enter: POPUP_KEYS.enter,
};

/**
 * A confirmation line says its one answer and nothing else; `Ctrl+C` disarms it too, so it is not named as closing. It names its answer (its
 * key: `Ctrl+Y` or `Enter`) only when the line is wholly on its page ({@link lineFitsPage}): while it is being prepared, when there is nothing
 * to confirm and when it is cut short or a row of it is cut it names none (the host takes none then). With its answer it names its explicit No
 * where it has one (`[Ctrl+N] Write nothing`, after the answer: the frame's fit drops it before the answer and the way out). Its `Esc` steps
 * back to the step it came from (it disarms; `back`, or the step's own word: `keep`), and on a first step it closes.
 */
function chordLegend(
  spec: PopupStep,
  state: PopupStepState,
  back: boolean,
  page: () => number,
  innerWidth: () => number,
  locked: boolean,
): PopupLegend {
  const items: LegendItem[] = [];
  const answer = lineAnswerKeyOf(spec);
  if (
    spec.chord !== undefined &&
    answer !== undefined &&
    lineFitsPage(state.content, page(), innerWidth())
  ) {
    items.push({ keys: LINE_KEYS[answer], verb: spec.chord.verb, ...waitMark(locked) });
    if (spec.chord.deny !== undefined) items.push({ keys: POPUP_KEYS.deny, verb: spec.chord.deny });
  }
  const exit = back
    ? exitKey.step(POPUP_KEYS.leave, spec.exitVerb ?? 'back')
    : exitKey.close(POPUP_KEYS.leave, closingVerb(spec, state));
  return { items, exit };
}

/** A form's own keys, in the order a person reaches for them: `←/→` for its tabs and `↑/↓` for its radio group, each only with a choice to make. */
function formItems(form: PopupForm): LegendItem[] {
  const items: LegendItem[] = [];
  if (form.tabs !== undefined && form.tabs.options.length > 1)
    items.push({ keys: POPUP_KEYS.adjust, verb: form.tabs.verb });
  if (form.radio !== undefined && form.radio.options.length > 1)
    items.push({ keys: POPUP_KEYS.select, verb: form.radio.verb });
  return items;
}

/**
 * The keys of a step that is not a line, in the order a person reaches for them. A step that is loading answers nothing yet, so it names no
 * key that answers (ADR-0148 §5: its cancel key is the one it really has); one that says there is nothing, or that it failed, names no `Enter`,
 * and a form that is not wholly on its page ({@link formFits}) names none either.
 */
function stepItems(
  spec: PopupStep,
  state: PopupStepState,
  page: () => number,
  width: () => number,
  locked: boolean,
): LegendItem[] {
  const items: LegendItem[] = [];
  if (state.content.kind === 'list' && visibleRows(state).length > 1)
    items.push({ keys: POPUP_KEYS.select, verb: 'select' });
  if (state.content.kind === 'report' && state.content.lines.length > page())
    items.push({ keys: POPUP_KEYS.scroll, verb: 'scroll' });
  if (state.content.kind === 'form') items.push(...formItems(state.content));
  if (state.content.kind === 'loading') return items;
  const answers =
    !nothingToChoose(state.content) &&
    (state.content.kind !== 'form' || formFits(state.content, page(), width()));
  if (spec.enter !== undefined && answers)
    items.push({
      keys: POPUP_KEYS.enter,
      verb: spec.enter,
      ...enterWaits(locked, state),
    });
  for (const control of spec.controls ?? [])
    items.push({
      keys: control.deleteKey === true ? [control.key, POPUP_KEYS.delete] : control.key,
      verb: control.verb,
    });
  return items;
}

/**
 * How long each of `items` is kept when the legend does not fit: the keys `keep` names, most important first, above every other key, which
 * keeps its order among the rest (an earlier one is kept longer). The leaving keys are kept by the frame whatever this says.
 */
function legendPriority(items: readonly LegendItem[], keep: readonly string[]): readonly number[] {
  return items.map((item, index) => {
    const named = 'keys' in item && typeof item.keys === 'string' ? keep.indexOf(item.keys) : -1;
    return named >= 0 ? 10_000 - named : items.length - index;
  });
}

/**
 * The frame with one step's content replaced (an asynchronous result landing): its selection is kept inside the new rows. `controls`, when
 * given, replaces the letters the step answers to from now on (`[]` takes them away); when absent the step keeps the ones it has. `enter`,
 * when given, replaces what `Enter` does there from now on ({@link PopupStepState.enter}: `false` takes it away); absent keeps it.
 */
export function withContent(
  frame: PopupFrame,
  stepIndex: number,
  content: PopupContent,
  controls?: readonly PopupControl[],
  enter?: string | false,
): PopupFrame {
  return {
    ...frame,
    steps: frame.steps.map((state, index) => {
      if (index !== stepIndex) return state;
      const next = {
        ...state,
        content,
        ...(controls === undefined ? {} : { controls }),
        ...(enter === undefined ? {} : { enter }),
      };
      // A form keeps the options the person chose, by id, when its content is replaced (a step that becomes a form opens on its initial options).
      if (content.kind === 'form') return { ...next, ...formChoices(content, state), offset: 0 };
      // The highlight stays on the row it was on, by id: rows that land (a refreshed catalog) may sort before it, and a highlight kept by index
      // would slide off the model in force onto another (a bare `Enter` chain would then choose it). A row that is gone leaves it at its index.
      const heldId = visibleRows(state)[state.selected]?.id;
      const rows = visibleRows(next);
      const sameRow = heldId === undefined ? -1 : rows.findIndex((row) => row.id === heldId);
      const selected =
        sameRow >= 0 && canAct(rows[sameRow])
          ? sameRow
          : canAct(rows[state.selected])
            ? state.selected
            : firstEnabled(rows);
      return { ...next, selected, offset: 0 };
    }),
  };
}
