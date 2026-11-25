/**
 * A flow drawn as a POPUP ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1, §3, §6): the
 * ONE thing a flow of the native prompt channel calls to be framed (`/providers` and the first run, `/init`, `/import`, `/pricing`, `/export`,
 * `/resume`, `/run`). It wraps the flow and sets the channel's `popup` descriptor before every prompt the flow asks, so each prompt is drawn in
 * the popup frame: the command's name and its origin on the top edge, the rail with the step names and `step N of M`, and the way back in the
 * flow's own words. Nothing else of the flow changes: its prompts, their answers, their `escape`, their guards and the secret field are the
 * channel's.
 *
 * - **The step.** The first prompt is on the first step and each later prompt on the next (clamped to the last), unless the flow said where it is
 *   with `step(i)` (a flow that steps back says so: `NATIVE_PROMPT_BACK` comes back to it, and it knows which step it returns to). A note or a
 *   wait is no prompt: it is drawn on the step the flow is on.
 * - **The Done step** (§6): a flow that WRITES ends in `done(…)`, a persistent last step that names what was written (project-relative, the
 *   caller's words) and is closed by `Enter` or `Esc`; a timed notification is not evidence of a write. Its legend says `Enter / Esc close`.
 * - **The end.** `end()` ends the flow and clears the descriptor, as the channel's `end` always did.
 *
 * Never used where no popup slot is drawn: the stand-alone chat's pre-chat mount draws the channel's card alone (`standalone-native-flow.ts`),
 * where a framed prompt would draw nothing and every key would be dropped as unseen. That mount's coordinator receives the raw flow.
 */

import type {
  NativeChordPort,
  NativePopupDescriptor,
  NativePromptFlow,
} from '../render/tui/native-prompt-channel.js';

/** What the popup frame says around a flow. */
export interface FramedFlowOptions {
  /** The command's name on the top edge (`/providers`, or `Connect a provider` for the first run). */
  readonly title: string;
  readonly origin: NativePopupDescriptor['origin'];
  /** The steps the rail names, in order (`Provider`, `Key`, `Done`). A flow of one step passes one name and draws no rail. */
  readonly stepNames: readonly string[];
  /** What the way back says where `Esc` (or `Ctrl+C`) closes the popup (`skip for now` on the first run); default `close`. */
  readonly exitLabel?: string;
}

/** What the persistent last step says. */
export interface FramedDone {
  /** The result, one sentence (`Created the project directories.`). */
  readonly message: string;
  /** The lines under it (what was written, one per line); none by default. */
  readonly lines?: readonly string[];
  /** Where the write went, project-relative: the hint of the step's one option. Absent ⇒ the option names nothing. */
  readonly target?: string;
}

/** The value the Done step's one option answers with. */
export const FRAMED_DONE_VALUE = 'done';
/** The words of the Done step's one option. */
export const FRAMED_DONE_LABEL = 'Done';

/** A flow framed as a popup: the channel's flow (without its descriptor setter: the frame is this helper's), the step, and the Done step. */
export interface FramedFlow extends Omit<NativePromptFlow, 'popup'> {
  /** Say which step the NEXT prompt is on (`0` is the first), for a flow that steps back or skips; clamped to the steps there are. */
  readonly step: (index: number) => void;
  /**
   * The persistent last step of a flow that wrote (ADR-0148 §6): drawn on the rail's last step, resolved by `Enter` or `Esc` (or `Ctrl+C`),
   * never by anything else. It resolves once the person closed it, or at once when the flow was already cancelled.
   */
  readonly done: (options: FramedDone) => Promise<void>;
}

type Prompt<Args extends unknown[], Result> = (...args: Args) => Promise<Result>;

export function framedFlow(
  flow: NativePromptFlow & NativeChordPort,
  options: FramedFlowOptions,
): FramedFlow & NativeChordPort;
export function framedFlow(flow: NativePromptFlow, options: FramedFlowOptions): FramedFlow;
export function framedFlow(
  flow: NativePromptFlow & Partial<NativeChordPort>,
  options: FramedFlowOptions,
): FramedFlow & Partial<NativeChordPort> {
  const count = Math.max(1, options.stepNames.length);
  const last = count - 1;
  const clampStep = (index: number): number =>
    Math.max(0, Math.min(last, Number.isFinite(index) ? Math.trunc(index) : 0));
  /** The step the flow is on; `undefined` before its first prompt. */
  let current: number | undefined;
  /** A step the flow named for its next prompt (`step(i)`), which wins over the advance. */
  let named: number | undefined;
  /** The step the descriptor last drawn says, so an unchanged step publishes nothing new. */
  let drawn: number | undefined;

  const describe = (index: number): NativePopupDescriptor => ({
    title: options.title,
    origin: options.origin,
    stepIndex: index,
    stepCount: count,
    stepNames: options.stepNames,
    exitLabel: options.exitLabel ?? 'close',
    depth: 1,
  });
  const draw = (index: number): void => {
    if (drawn === index) return;
    drawn = index;
    flow.popup?.(describe(index));
  };
  /** Before a prompt: the step it is on (the named one, else the next after the last prompt's), drawn before the prompt is published. */
  const enterPrompt = (): void => {
    const next = named ?? (current === undefined ? 0 : Math.min(last, current + 1));
    named = undefined;
    current = next;
    draw(next);
  };
  const framed =
    <Args extends unknown[], Result>(ask: Prompt<Args, Result>): Prompt<Args, Result> =>
    (...args) => {
      enterPrompt();
      return ask(...args);
    };

  const wrapped: FramedFlow & Partial<NativeChordPort> = {
    begin: () => {
      current = undefined;
      named = undefined;
      drawn = undefined;
      const signal = flow.begin();
      // The flow is a popup from its first frame (a wait before the first prompt is drawn in the frame too, on the first step).
      draw(0);
      return signal;
    },
    end: async () => {
      await flow.end();
      current = undefined;
      named = undefined;
      drawn = undefined;
    },
    cancel: () => flow.cancel(),
    note: (message, title) => flow.note(message, title),
    ...(flow.committedNote === undefined
      ? {}
      : {
          committedNote: (message: string, title?: string) => flow.committedNote?.(message, title),
        }),
    busy: (message) => {
      // A wait belongs to the step the flow is on (the check is the busy state of the key step), or the one it named next.
      if (named !== undefined) draw(named);
      flow.busy(message);
    },
    pick: framed((pickOptions: Parameters<NativePromptFlow['pick']>[0]) => flow.pick(pickOptions)),
    select: framed((selectOptions: Parameters<NativePromptFlow['select']>[0]) =>
      flow.select(selectOptions),
    ),
    confirm: framed(
      (
        message: string,
        initialValue?: boolean,
        escape?: Parameters<NativePromptFlow['confirm']>[2],
      ) => flow.confirm(message, initialValue, escape),
    ),
    text: framed((textOptions: Parameters<NativePromptFlow['text']>[0]) => flow.text(textOptions)),
    password: framed((passwordOptions: Parameters<NativePromptFlow['password']>[0]) =>
      flow.password(passwordOptions),
    ),
    step: (index) => {
      named = clampStep(index);
    },
    done: async (done) => {
      named = last;
      enterPrompt();
      await flow.select({
        message: done.message,
        options: [
          {
            value: FRAMED_DONE_VALUE,
            label: FRAMED_DONE_LABEL,
            ...(done.target === undefined ? {} : { hint: done.target }),
          },
        ],
        ...(done.lines === undefined ? {} : { details: done.lines }),
        escape: 'cancel',
        final: true,
      });
    },
  };
  const chord = flow.chord;
  if (chord === undefined) return wrapped;
  return {
    ...wrapped,
    chord: framed((chordOptions: Parameters<NativeChordPort['chord']>[0]) => chord(chordOptions)),
  };
}
