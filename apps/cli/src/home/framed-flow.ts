/**
 * A flow drawn as a POPUP ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6): the
 * ONE thing a flow of the native prompt channel calls to be framed (`/providers` and the first run, `/init`, `/import`, `/pricing`, `/export`,
 * `/resume`, `/run`). It wraps the flow and sets the channel's `popup` descriptor before every prompt, so each prompt is drawn in the popup
 * frame: the command's name and its origin on the top edge, the rail with the step names and `step N of M`, and the way back in the flow's own
 * words. Nothing else of the flow changes: its prompts, their answers, their `escape`, their guards and the secret field are the channel's.
 *
 * **Where a prompt sits on the rail.** A flow says how its rail moves (`progress`):
 * - `linear` (`/init`, `/import`, `/export`): each answered prompt moves the rail on by one, and the first prompt is on the first step;
 * - `manual` (`/providers`, `/pricing`, `/run`, `/resume`): the rail stays where the flow put it, and the flow names a step with
 *   `at(i).select(…)` (a coarse rail over a variable number of prompts, or a flow whose steps are not in a line).
 * In both, `at(i)` names the step of that one prompt, and **a prompt that comes back with `NATIVE_PROMPT_BACK` rewinds the rail**: the next
 * prompt that names no step is on the step of the prompt answered before the one that went back (a `walk` that asks the previous prompt
 * again finds it where it was). A note or a wait is no prompt: it is drawn on the step the flow is on (`at(i).busy(…)` moves the rail there).
 *
 * **One frame across stages.** `begin`/`end` nest: a stage that begins and ends the flow itself (a picker, then the restore it leads to) run
 * inside an outer `begin`/`end` keeps ONE frame, with no closed frame between the stages and no second opening settle.
 *
 * **A prompt that is not the popup's.** `unframed(run)` takes the descriptor away while `run` asks something on the RAW channel (the MCP
 * consent card a run raises while it starts, which is the run's own card, not a step of the popup) and puts it back after.
 *
 * **A note belongs to the step it precedes.** A note a flow sets (the key step's disclosure, a failed write's reason, the sentence that goes
 * with a recovery question) is the line above the NEXT prompt, and it goes when that prompt is resolved, whether it was answered, stepped back
 * from or aborted: a note never outlives its step, so it is never found above a later step, the list a step back returns to, or the Done step.
 * The Done step starts with no note at all. What the person must still read there is the Done step's own `lines`. A disclosure that must be on
 * screen while a write publishes is set after the prompt that came before it and is gone only when the NEXT prompt is resolved or the Done
 * step opens, both after the write.
 *
 * **The Done step** (§6): a flow that WRITES ends in `done(…)`, a persistent last step that says what was written or that it failed, closed
 * by `Enter` or `Esc`; a timed notification is not evidence of a write. It has ONE shape: the sentence led by its mark (`✓` for a write that
 * happened, `✗` for one that did not; `ok` and `x` where the glyphs are plain), the target (project-relative, the caller's words) once under
 * it, the caller's lines, and one option, `Close`. `Esc` there steps back (it never aborts the flow's signal: a flow that reads the signal
 * after its Done step must not take a completed write for a cancel); `Ctrl+C` still cancels. A step the flow passed without doing it (`skipped`:
 * the setup's `Key` step after a granted environment key) is drawn on its rail as not done, never `✓`.
 *
 * **What a step's keys say.** `at(i, { exitLabel, enterVerb, escapeVerb })` gives that one step's prompts their own words: the way back, what
 * `Enter` does on a field (`check`), and what `Esc` does where it steps back and the step back is more than a step (`skip for now` on the first
 * run's first step, whose step back IS the skip). Product constants, never data.
 *
 * Never used where no popup slot is drawn: the stand-alone chat's pre-chat mount draws the channel's card alone (`standalone-native-flow.ts`),
 * where a framed prompt would draw nothing and every key would be dropped as unseen. That mount's coordinator receives the raw flow.
 */

import {
  NATIVE_PROMPT_BACK,
  type NativeChordPort,
  type NativeFinalTone,
  type NativePopupDescriptor,
  type NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';

/** How the rail moves when a prompt names no step (see the module header). */
export type FramedProgress = 'linear' | 'manual';

/** What the popup frame says around a flow. */
export interface FramedFlowOptions {
  /** The command's name on the top edge (`/providers`, or `Connect a provider` for the first run, which names itself so). */
  readonly title: string;
  readonly origin: NativePopupDescriptor['origin'];
  /** The steps the rail names, in order (`Provider`, `Key`, `Done`). A flow of one step passes one name and draws no rail. */
  readonly stepNames: readonly string[];
  /** How the rail moves when a prompt names no step: required, so every flow says which it is. */
  readonly progress: FramedProgress;
  /** What the way back says where `Esc` (or `Ctrl+C`) closes the popup (`skip for now` on the first run); default `close`. */
  readonly exitLabel?: string;
}

/** What one step's prompts say beside the flow's own words. */
export interface FramedStepOptions {
  /** The way back of THESE prompts (`back` on a later step of the first run, whose first step says `skip for now`). */
  readonly exitLabel?: string;
  /**
   * What `Enter` says on the legend of THESE prompts when they are a text or a masked field whose `Enter` does more than continue (`check` on
   * the key step: that `Enter` sends the key to the provider, once). Default `continue`; it is read for no other kind of prompt. A PRODUCT
   * constant, never data: it is drawn on the legend row as given (sanitised by the channel, not scrubbed), so a word a person, a project or a
   * provider wrote must never reach it. Only this type keeps it so; there is no runtime path that tells where a string came from.
   */
  readonly enterVerb?: string;
  /**
   * What `Esc` says on the legend of THESE prompts where they step back (`escape: 'back'`) and the step back is more than a step (`skip for
   * now` on the first step of the automatic first run, whose step back is the skip). Default `back`. A PRODUCT constant, as `enterVerb` is.
   */
  readonly escapeVerb?: string;
}

/** What the persistent last step says. */
export interface FramedDone {
  /** The result, one sentence in the product's words (`Created the project directories.`, `Could not save the key.`). */
  readonly message: string;
  /** The lines under it: what was written, one per line, or why it failed. None by default. */
  readonly lines?: readonly string[];
  /**
   * Where the write went, project-relative: drawn ONCE, as the first row under the sentence (a line that is the target word for word is not
   * drawn a second time). A caller does not put it in the sentence as well. Absent ⇒ no row.
   */
  readonly target?: string;
  /** @deprecated Ignored: the step has one option, worded {@link FRAMED_DONE_LABEL}, whatever the result (its legend says `Enter / Esc close`). */
  readonly label?: string;
  /** `failed` draws the sentence as a failure (a write that did not happen); default `ok`. */
  readonly tone?: NativeFinalTone;
  /**
   * The steps the flow passed WITHOUT doing them (the setup's `Key` step when an environment key was granted or a keychain that is down was
   * remembered): the rail of the Done step draws them as not done (`○`), never `✓`. Absent ⇒ every step before it was done.
   */
  readonly skipped?: readonly number[];
}

/** The value the Done step's one option answers with. */
export const FRAMED_DONE_VALUE = 'done';
/** The words of the Done step's one option, in both tones: the legend under it says `Enter / Esc close`. */
export const FRAMED_DONE_LABEL = 'Close';

/** The prompts of a framed flow, on the step their caller names (`at`) or on the step the rail is on. */
export type FramedPrompts = Pick<
  NativePromptFlow,
  'busy' | 'pick' | 'select' | 'confirm' | 'text' | 'password'
>;

/** A flow framed as a popup: the channel's flow (without its descriptor setter: the frame is this helper's), the rail, and the Done step. */
export interface FramedFlow extends Omit<NativePromptFlow, 'popup'> {
  /** The prompts of step `step` (`0` is the first; clamped to the steps there are), with this step's own way back where given. */
  readonly at: (step: number, options?: FramedStepOptions) => FramedPrompts;
  /**
   * The persistent last step of a flow that wrote, or failed to (ADR-0148 §6): drawn on the rail's last step, resolved by `Enter`, `Esc` (a
   * step back that leaves the flow's signal as it was) or `Ctrl+C` (a cancel), never by anything else. It resolves once the person closed it,
   * or at once when the flow was already cancelled.
   */
  readonly done: (options: FramedDone) => Promise<void>;
  /** Run `run` with the descriptor taken away (a raw prompt is drawn as the card it is), then put it back on the step the flow was on. */
  readonly unframed: <T>(run: () => Promise<T>) => Promise<T>;
}

/** A framed flow over a flow that has the chord card: the card is a prompt of the rail too. */
export interface FramedChordFlow extends FramedFlow, NativeChordPort {
  readonly at: (step: number, options?: FramedStepOptions) => FramedPrompts & NativeChordPort;
}

/** What a frame says beside its step: its way back, what its `Enter` and its `Esc` do, and the steps before it that were not done. */
interface FrameWords {
  readonly exitLabel?: string | undefined;
  readonly enterVerb?: string | undefined;
  readonly escapeVerb?: string | undefined;
  readonly skipped?: readonly number[] | undefined;
}

/** The step a frame shows and its words, its way back always named. */
interface Shown extends FrameWords {
  readonly step: number;
  readonly exitLabel: string;
}

/** Where a prompt of a step is drawn and what its legend says: a step (or, `undefined`, the one the rail is on) and its words. */
interface StepWords extends FrameWords {
  readonly step: number | undefined;
}

/** Where a flow's rail is and what it remembers (one per framed flow). */
interface RailState {
  /** The step the next prompt that names none is on. */
  next: number;
  /** The steps of the prompts answered (not stepped back from), most recent last: a step back returns to the last of them. */
  readonly trail: number[];
  /** What the descriptor last published says, so an unchanged frame publishes nothing new. */
  drawn: Shown | undefined;
  /** While above zero the descriptor is taken away (`unframed`), and a step is remembered, not drawn. */
  suspended: number;
  /** What the frame should show now (what `unframed` puts back). */
  wanted: Shown;
}

/** The flow's fixed facts the rail reads: its words, its step count and its last step. */
interface RailFacts {
  readonly flow: NativePromptFlow;
  readonly options: FramedFlowOptions;
  readonly count: number;
  readonly last: number;
}

/** The descriptor of the frame `shown`. */
function describeStep(facts: RailFacts, shown: Shown): NativePopupDescriptor {
  return {
    title: facts.options.title,
    origin: facts.options.origin,
    stepIndex: shown.step,
    stepCount: facts.count,
    stepNames: facts.options.stepNames,
    exitLabel: shown.exitLabel,
    ...(shown.enterVerb === undefined ? {} : { enterVerb: shown.enterVerb }),
    ...(shown.escapeVerb === undefined ? {} : { escapeVerb: shown.escapeVerb }),
    ...(shown.skipped === undefined ? {} : { skipped: shown.skipped }),
    depth: 1,
  };
}

/** Whether a frame already drawn says what `wanted` says (the skipped steps compared step by step). */
function sameShown(drawn: Shown | undefined, wanted: Shown): boolean {
  return (
    drawn?.step === wanted.step &&
    drawn.exitLabel === wanted.exitLabel &&
    drawn.enterVerb === wanted.enterVerb &&
    drawn.escapeVerb === wanted.escapeVerb &&
    String(drawn.skipped ?? []) === String(wanted.skipped ?? [])
  );
}

/** Publish the frame the rail wants, unless it is taken away or already published. */
function publishStep(facts: RailFacts, state: RailState): void {
  if (state.suspended > 0 || sameShown(state.drawn, state.wanted)) return;
  state.drawn = state.wanted;
  facts.flow.popup?.(describeStep(facts, state.wanted));
}

/** A prompt on `step` resolved with `result`: the rail moves on (`linear`) or stays (`manual`), or a step back rewinds it. */
function settleStep(facts: RailFacts, state: RailState, step: number, result: unknown): void {
  if (result === NATIVE_PROMPT_BACK) {
    state.next = state.trail.pop() ?? 0;
    return;
  }
  if (typeof result === 'symbol') return;
  state.trail.push(step);
  state.next = facts.options.progress === 'linear' ? Math.min(facts.last, step + 1) : step;
}

/** A step clamped to the steps there are; one that is not a number is the first. */
function clampStep(facts: RailFacts, index: number): number {
  return Math.max(0, Math.min(facts.last, Number.isFinite(index) ? Math.trunc(index) : 0));
}

/** A fresh rail, on the first step. */
function freshRail(options: FramedFlowOptions): RailState {
  const shown: Shown = { step: 0, exitLabel: options.exitLabel ?? 'close' };
  return { next: 0, trail: [], drawn: undefined, suspended: 0, wanted: shown };
}

/** The rail of one framed flow: where it is, what it publishes, and how a prompt's result moves it. */
function createRail(flow: NativePromptFlow, options: FramedFlowOptions) {
  const count = Math.max(1, options.stepNames.length);
  const facts: RailFacts = { flow, options, count, last: count - 1 };
  let state = freshRail(options);
  const show = (step: number, words: FrameWords = {}): void => {
    state.wanted = { ...words, step, exitLabel: words.exitLabel ?? options.exitLabel ?? 'close' };
    publishStep(facts, state);
  };
  return {
    last: facts.last,
    clamp: (index: number): number => clampStep(facts, index),
    reset: (): void => {
      state = freshRail(options);
    },
    next: (): number => state.next,
    /** A wait or a step named for what follows: the rail is there now. */
    moveTo: (step: number, exitLabel?: string): void => {
      state.next = step;
      show(step, { exitLabel });
    },
    show,
    settled: (step: number, result: unknown): void => settleStep(facts, state, step, result),
    /** The prompt the note was set for is resolved: the note goes with it (and the Done step opens with none). */
    clearNote: (): void => flow.note(''),
    suspend: (): void => {
      if (state.suspended === 0 && state.drawn !== undefined) flow.popup?.(undefined);
      state.suspended += 1;
    },
    resume: (active: boolean): void => {
      state.suspended = Math.max(0, state.suspended - 1);
      if (state.suspended > 0) return;
      state.drawn = undefined;
      if (active) publishStep(facts, state);
    },
  };
}

type Rail = ReturnType<typeof createRail>;
type Prompt<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

/**
 * A prompt on `words.step` (or, when `undefined`, on the step the rail is at): drawn before it is published, and, when it resolves (answered,
 * stepped back from, or aborted), recorded on the rail and its note taken away: a note belongs to the prompt it precedes.
 */
function promptOn<Args extends unknown[], Result>(
  rail: Rail,
  ask: Prompt<Args, Result>,
  words: StepWords,
): Prompt<Args, Result> {
  return async (...args) => {
    const at = words.step ?? rail.next();
    rail.show(at, words);
    const result = await ask(...args);
    rail.settled(at, result);
    rail.clearNote();
    return result;
  };
}

/** The prompts of one step (`words.step` ⇒ that step; `undefined` ⇒ wherever the rail is), with this step's way back and `Enter` where given. */
function stepPrompts(
  flow: NativePromptFlow & Partial<NativeChordPort>,
  rail: Rail,
  words: StepWords,
): FramedPrompts & Partial<NativeChordPort> {
  const chord = flow.chord;
  return {
    busy: (message, busyOptions) => {
      if (words.step !== undefined) rail.moveTo(words.step, words.exitLabel);
      flow.busy(message, busyOptions);
    },
    pick: promptOn(rail, (o: Parameters<NativePromptFlow['pick']>[0]) => flow.pick(o), words),
    select: promptOn(rail, (o: Parameters<NativePromptFlow['select']>[0]) => flow.select(o), words),
    confirm: promptOn(
      rail,
      (message: string, initial?: boolean, escape?: Parameters<NativePromptFlow['confirm']>[2]) =>
        flow.confirm(message, initial, escape),
      words,
    ),
    text: promptOn(rail, (o: Parameters<NativePromptFlow['text']>[0]) => flow.text(o), words),
    password: promptOn(
      rail,
      (o: Parameters<NativePromptFlow['password']>[0]) => flow.password(o),
      words,
    ),
    ...(chord === undefined
      ? {}
      : {
          chord: promptOn(rail, (o: Parameters<NativeChordPort['chord']>[0]) => chord(o), words),
        }),
  };
}

/** The flow's `begin` and `end`, nested: the frame opens with the first `begin` and closes with the matching `end`. */
function createNesting(flow: NativePromptFlow, rail: Rail) {
  let depth = 0;
  let signal: AbortSignal | undefined;
  return {
    active: (): boolean => depth > 0,
    begin: (): AbortSignal => {
      if (depth > 0 && signal !== undefined) {
        depth += 1;
        return signal;
      }
      rail.reset();
      signal = flow.begin();
      depth = 1;
      // The flow is a popup from its first frame (a wait before the first prompt is drawn in the frame too, on the first step).
      rail.show(0);
      return signal;
    },
    end: async (): Promise<void> => {
      if (depth > 1) {
        depth -= 1;
        return;
      }
      depth = 0;
      signal = undefined;
      await flow.end();
      rail.reset();
    },
  };
}

/** The rows under the Done step's sentence: the target once (unless a line already is it), then the caller's lines. */
function doneRows(done: FramedDone): readonly string[] {
  const lines = done.lines ?? [];
  return done.target === undefined || lines.includes(done.target) ? lines : [done.target, ...lines];
}

/** The persistent last step (see {@link FramedFlow.done}). */
async function doneStep(flow: NativePromptFlow, rail: Rail, done: FramedDone): Promise<void> {
  // The step starts with no note: what an earlier step said is not what this one reports (its own lines are the place for what must stay).
  rail.clearNote();
  rail.show(rail.last, done.skipped === undefined ? {} : { skipped: done.skipped });
  const rows = doneRows(done);
  await flow.select({
    message: done.message,
    options: [{ value: FRAMED_DONE_VALUE, label: FRAMED_DONE_LABEL }],
    ...(rows.length === 0 ? {} : { details: rows }),
    // A lone `Esc` closes it as a step back: the flow's signal is not aborted by closing what it already did.
    escape: 'back',
    final: done.tone ?? 'ok',
  });
}

export function framedFlow(
  flow: NativePromptFlow & NativeChordPort,
  options: FramedFlowOptions,
): FramedChordFlow;
export function framedFlow(flow: NativePromptFlow, options: FramedFlowOptions): FramedFlow;
export function framedFlow(
  flow: NativePromptFlow & Partial<NativeChordPort>,
  options: FramedFlowOptions,
): FramedFlow & Partial<NativeChordPort> {
  const rail = createRail(flow, options);
  const nesting = createNesting(flow, rail);
  return {
    begin: nesting.begin,
    end: nesting.end,
    cancel: () => flow.cancel(),
    note: (message, title) => flow.note(message, title),
    ...(flow.committedNote === undefined
      ? {}
      : {
          committedNote: (message: string, title?: string) => flow.committedNote?.(message, title),
        }),
    ...stepPrompts(flow, rail, { step: undefined }),
    at: (step, stepOptions) =>
      stepPrompts(flow, rail, {
        step: rail.clamp(step),
        exitLabel: stepOptions?.exitLabel,
        enterVerb: stepOptions?.enterVerb,
        escapeVerb: stepOptions?.escapeVerb,
      }),
    done: (done) => doneStep(flow, rail, done),
    unframed: async (run) => {
      rail.suspend();
      try {
        return await run();
      } finally {
        rail.resume(nesting.active());
      }
    },
  };
}
