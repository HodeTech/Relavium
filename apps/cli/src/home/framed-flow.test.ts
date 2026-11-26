/**
 * `framedFlow` (ADR-0148 §1, §3, §6; MVP-11 unit 6, 6.1 and its fix wave): the one helper a flow calls to be drawn as a popup. It sets the
 * channel's descriptor before every prompt (the rail moving on per answered prompt in a `linear` flow, staying put in a `manual` one, named per
 * prompt with `at`, and rewound on a step back), keeps ONE frame across nested stages, takes the frame away around a raw prompt (`unframed`), and
 * ends a flow that wrote in a persistent Done step whose `Esc` never aborts the flow's signal. A note belongs to the prompt it precedes (it goes
 * when that prompt is resolved, and the Done step starts with none), the Done step is ONE shape in both tones, and a step may say what its
 * `Enter` does. Driven on the real channel, its acknowledgement played by hand.
 */
import type { Key } from 'ink';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import {
  FRAMED_DONE_LABEL,
  FRAMED_DONE_VALUE,
  framedFlow,
  type FramedFlowOptions,
} from './framed-flow.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...none, return: true };
const ESC: Key = { ...none, escape: true };
const CTRL_C: [string, Key] = ['c', { ...none, ctrl: true }];

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
] as const;

function rig(options: Partial<FramedFlowOptions> = {}) {
  let clock = 1000;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const flow = framedFlow(channel.flow, {
    title: '/providers',
    origin: 'home',
    stepNames: ['Provider', 'Key', 'Done'],
    progress: 'linear',
    ...options,
  });
  const published: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => published.push(channel.ui.getSnapshot()));
  const settle = (): void => {
    channel.ui.shown(channel.ui.getSnapshot());
    clock += POPUP_SELECT_SETTLE_MS;
  };
  return {
    channel,
    flow,
    published,
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
    step: (): number | undefined => channel.ui.getSnapshot().popup?.stepIndex,
    /** The frame on screen now was measured and flushed, and the flow's opening settle has passed. */
    settle,
    key: (key: Key, input = ''): boolean => channel.ui.input(input, key),
    /** Answer the open prompt with `Enter` (after its frame is seen and the settle has passed). */
    answer: (): void => {
      settle();
      channel.ui.input('', ENTER);
    },
    /** Step back from the open prompt with a lone `Esc`. */
    back: (): void => {
      channel.ui.input('', ESC);
    },
  };
}

describe('the descriptor a framed flow draws', () => {
  it('is set at `begin`, on the first step, with the title, the origin, the names, `close` and depth one', () => {
    const r = rig();
    r.flow.begin();
    expect(r.snapshot().popup).toEqual({
      title: '/providers',
      origin: 'home',
      stepIndex: 0,
      stepCount: 3,
      stepNames: ['Provider', 'Key', 'Done'],
      exitLabel: 'close',
      depth: 1,
    });
  });

  it('says the flow’s own words for the way back where given (`skip for now`), and a step’s own words for that step’s prompts', async () => {
    const r = rig({ exitLabel: 'skip for now', progress: 'manual' });
    r.flow.begin();
    expect(r.snapshot().popup?.exitLabel).toBe('skip for now');
    const key = r.flow.at(1, { exitLabel: 'back' }).password({ message: 'Key' });
    expect(r.snapshot().popup?.exitLabel).toBe('back');
    expect(r.step()).toBe(1);
    r.flow.cancel();
    await key;
    await r.flow.end();
    r.flow.begin();
    void r.flow.at(0).select({ message: 'Provider', options: OPTIONS });
    expect(r.snapshot().popup?.exitLabel).toBe('skip for now');
  });

  it('an empty list of names is one step: no rail', () => {
    const r = rig({ stepNames: [] });
    r.flow.begin();
    expect(r.snapshot().popup?.stepCount).toBe(1);
    expect(r.snapshot().popup?.stepIndex).toBe(0);
  });

  it('publishes the descriptor once per step: a prompt on the same step adds no frame of its own', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const before = r.published.length;
    const answer = r.flow.at(0).select({ message: 'Q', options: OPTIONS });
    // the prompt's own publication only: the step did not change
    expect(r.published.length).toBe(before + 1);
    r.answer();
    await answer;
  });

  it('`end` clears the descriptor, and the next flow starts on the first step again', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({ message: 'Q', options: OPTIONS });
    r.answer();
    await answer;
    void r.flow.text({ message: 'Next' });
    expect(r.step()).toBe(1);
    r.flow.cancel();
    await r.flow.end();
    expect(r.snapshot().popup).toBeUndefined();
    expect(r.snapshot().active).toBe(false);
    r.flow.begin();
    void r.flow.text({ message: 'Again' });
    expect(r.step()).toBe(0);
  });

  it('passes every prompt’s options through untouched (escape, initial value, guarded options) and `confirm`’s escape', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({
      message: 'Allow?',
      options: [
        { value: 'use', label: 'Use it', guarded: true },
        { value: 'later', label: 'Not now' },
      ],
      initialValue: 'later',
      escape: 'back',
    });
    expect(r.snapshot().selected).toBe(1);
    expect(r.snapshot().escape).toBe('back');
    expect(r.snapshot().options[0]?.guarded).toBe(true);
    r.flow.cancel();
    await answer;
    await r.flow.end();
    r.flow.begin();
    void r.flow.confirm('Sure?', true, 'back');
    expect(r.snapshot().escape).toBe('back');
    expect(r.snapshot().selected).toBe(0);
  });
});

describe('a `linear` flow (`/init`, `/import`, `/export`)', () => {
  it('each answered prompt moves the rail on by one, clamped to the last; a note and a wait stay where the flow is', async () => {
    const r = rig();
    r.flow.begin();
    for (let index = 0; index < 5; index += 1) {
      const answer = r.flow.select({ message: `Q${String(index)}`, options: OPTIONS });
      expect(r.step()).toBe(Math.min(index, 2));
      r.answer();
      expect(await answer).toBe('a');
      r.flow.note('a note');
      r.flow.busy('Working');
      expect(r.step()).toBe(Math.min(index, 2));
    }
  });

  it('`at(i)` names ONE prompt’s step; the next unnamed prompt follows from it', async () => {
    const r = rig();
    r.flow.begin();
    const named = r.flow.at(1).select({ message: 'one', options: OPTIONS });
    expect(r.step()).toBe(1);
    r.answer();
    await named;
    void r.flow.text({ message: 'two' });
    expect(r.step()).toBe(2);
  });

  it('a step back rewinds the rail: the prompt asked again after it is on the step it was on', async () => {
    const r = rig();
    r.flow.begin();
    const provider = r.flow.select({ message: 'Provider', options: OPTIONS });
    r.answer();
    await provider;
    const key = r.flow.password({ message: 'Key', escape: 'back' });
    expect(r.step()).toBe(1);
    r.back();
    expect(await key).toBe(NATIVE_PROMPT_BACK);
    void r.flow.select({ message: 'Provider again', options: OPTIONS });
    expect(r.step()).toBe(0);
  });

  it('a cancel leaves the rail where it was (the flow is ending)', async () => {
    const r = rig();
    r.flow.begin();
    const first = r.flow.select({ message: 'One', options: OPTIONS });
    r.answer();
    await first;
    const second = r.flow.text({ message: 'Two' });
    r.key(CTRL_C[1], CTRL_C[0]);
    expect(await second).toBe(NATIVE_PROMPT_CANCEL);
    expect(r.step()).toBe(1);
  });

  it('clamps a named step to the steps there are, and a step that is not a number to the first', async () => {
    const r = rig();
    r.flow.begin();
    void r.flow.at(99).text({ message: 'Last' });
    expect(r.step()).toBe(2);
    r.flow.cancel();
    await r.flow.end();
    r.flow.begin();
    void r.flow.at(-3).text({ message: 'First' });
    expect(r.step()).toBe(0);
    r.flow.cancel();
    await r.flow.end();
    r.flow.begin();
    void r.flow.at(Number.NaN).text({ message: 'First' });
    expect(r.step()).toBe(0);
  });
});

describe('a `manual` flow: the rail stays where the flow put it (`/providers`, `/pricing`, `/run`)', () => {
  it('`/providers`: provider, key, the check (the key step’s wait), a failed check’s retry (still the key step), the key again', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const provider = r.flow.at(0).select({ message: 'Which provider?', options: OPTIONS });
    expect(r.step()).toBe(0);
    r.answer();
    await provider;
    const key = r.flow.at(1).password({ message: 'Key' });
    expect(r.step()).toBe(1);
    r.key(none, 'sk-x');
    r.answer();
    await key;
    r.flow.at(1).busy('Checking your key · one request to api.example.com');
    expect(r.step()).toBe(1);
    const retry = r.flow.select({ message: 'The check failed', options: OPTIONS });
    expect(r.step()).toBe(1);
    r.answer();
    await retry;
    void r.flow.password({ message: 'Key again' });
    expect(r.step()).toBe(1);
  });

  it('`/providers`: `Esc` back from the key returns the provider list to its own step', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const provider = r.flow.at(0).select({ message: 'Which provider?', options: OPTIONS });
    r.answer();
    await provider;
    const key = r.flow.at(1).password({ message: 'Key', escape: 'back' });
    r.back();
    expect(await key).toBe(NATIVE_PROMPT_BACK);
    // the flow asks the provider again without naming a step: the rail rewound to where that prompt was
    void r.flow.select({ message: 'Which provider?', options: OPTIONS });
    expect(r.step()).toBe(0);
  });

  it('`/pricing`: four names over six prompts never drift past the step the flow named', async () => {
    const r = rig({ progress: 'manual', stepNames: ['Model', 'Price', 'Confirm', 'Done'] });
    r.flow.begin();
    const action = r.flow.at(0).select({ message: 'Set or clear?', options: OPTIONS });
    r.answer();
    await action;
    const model = r.flow.select({ message: 'Model', options: OPTIONS });
    expect(r.step()).toBe(0);
    r.answer();
    await model;
    for (const field of ['input', 'output', 'cached']) {
      const price = r.flow.at(1).text({ message: field });
      expect(r.step()).toBe(1);
      r.key(none, '1');
      r.answer();
      await price;
    }
    void r.flow.at(2).text({ message: 'confirm stand-in' });
    expect(r.step()).toBe(2);
  });

  it('`/pricing`: a step back inside a step stays on that step', async () => {
    const r = rig({ progress: 'manual', stepNames: ['Model', 'Price', 'Confirm'] });
    r.flow.begin();
    const one = r.flow.at(1).text({ message: 'input', escape: 'back' });
    r.key(none, '1');
    r.answer();
    await one;
    const two = r.flow.text({ message: 'output', escape: 'back' });
    expect(r.step()).toBe(1);
    r.back();
    expect(await two).toBe(NATIVE_PROMPT_BACK);
    void r.flow.text({ message: 'input again', escape: 'back' });
    expect(r.step()).toBe(1);
  });
});

describe('one frame across stages (`/resume`: the picker, then the restore)', () => {
  it('a stage that begins and ends the flow itself, inside an outer `begin`/`end`, closes no frame between the stages', async () => {
    const r = rig({ progress: 'manual', stepNames: ['Session'] });
    const outer = r.flow.begin();
    // stage 1: a picker stage that begins and ends the flow itself
    const inner = r.flow.begin();
    expect(inner).toBe(outer);
    const pick = r.flow.select({ message: 'Resume a session', options: OPTIONS });
    r.answer();
    expect(await pick).toBe('a');
    const before = r.published.length;
    await r.flow.end();
    // nothing closed: no `initial` was published, the flow is still open and framed
    expect(r.published.slice(before).some((snapshot) => !snapshot.active)).toBe(false);
    expect(r.snapshot().active).toBe(true);
    expect(r.snapshot().popup?.title).toBe('/providers');
    // stage 2: the restore, in the same frame
    r.flow.busy('Restoring the conversation');
    expect(r.snapshot().popup).toBeDefined();
    await r.flow.end();
    expect(r.snapshot().active).toBe(false);
  });

  it('the opening settle is not started again by the second stage', async () => {
    const r = rig({ progress: 'manual', stepNames: ['Session'] });
    r.flow.begin();
    r.flow.begin();
    const pick = r.flow.select({ message: 'Pick', options: OPTIONS });
    r.answer();
    await pick;
    await r.flow.end();
    const retry = r.flow.select({ message: 'Retry?', options: OPTIONS });
    r.channel.ui.shown(r.snapshot());
    r.key(ENTER);
    expect(await retry).toBe('a');
    await r.flow.end();
  });
});

describe('a raw prompt asked while a framed flow is open (`unframed`)', () => {
  it('a chord card and a select asked on the raw channel are cards (no descriptor), and the frame comes back on the step the flow was on', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    r.flow.at(2).busy('Starting the run…');
    expect(r.step()).toBe(2);
    const raw: NativePromptFlow = r.channel.flow;
    const consent = r.flow.unframed(async () => {
      const card = r.channel.flow.chord({
        message: 'Start this server?',
        allow: 'Allow',
        deny: 'Deny',
      });
      expect(r.snapshot().kind).toBe('chord');
      expect(r.snapshot().popup).toBeUndefined();
      r.key({ ...none, ctrl: true }, 'n');
      const answer = await card;
      const choice = raw.select({ message: 'Again?', options: OPTIONS });
      expect(r.snapshot().popup).toBeUndefined();
      r.key(ENTER);
      return [answer, await choice] as const;
    });
    expect(await consent).toEqual(['deny', 'a']);
    expect(r.snapshot().popup?.stepIndex).toBe(2);
  });

  it('nested `unframed` puts the frame back only at the outermost; a framed prompt asked inside is remembered, not drawn', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    await r.flow.unframed(async () => {
      await r.flow.unframed(() => Promise.resolve());
      expect(r.snapshot().popup).toBeUndefined();
      r.flow.at(1).busy('Working');
      expect(r.snapshot().popup).toBeUndefined();
    });
    expect(r.step()).toBe(1);
  });

  it('a throw inside puts the frame back too', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    await expect(r.flow.unframed(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(r.snapshot().popup).toBeDefined();
  });

  it('frames the chord step of a flow that has one, and has no chord where the flow has none', async () => {
    const r = rig({ progress: 'manual' });
    expect(typeof r.flow.chord).toBe('function');
    r.flow.begin();
    const answer = r.flow.at(1).chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
    expect(r.snapshot().kind).toBe('chord');
    expect(r.step()).toBe(1);
    r.key(ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    const { chord, ...withoutChord } = createNativePromptChannel().flow;
    void chord;
    const bare: NativePromptFlow = withoutChord;
    const framed = framedFlow(bare, {
      title: '/x',
      origin: 'chat',
      stepNames: ['One'],
      progress: 'linear',
    });
    expect('chord' in framed).toBe(false);
    expect('chord' in framed.at(0)).toBe(false);
  });
});

describe('the Done step (ADR-0148 §6)', () => {
  it('is the last step: a select of one option `Close`, the target once and then its lines above it, marked final (ok), closed by `Enter`', async () => {
    const r = rig();
    r.flow.begin();
    const done = r.flow.done({
      message: 'Connected · Anthropic · claude-haiku-5-5',
      lines: ['Type a message to start, or /init to set up this folder'],
      target: '~/.relavium/config.toml',
    });
    const snapshot = r.snapshot();
    expect(snapshot.popup?.stepIndex).toBe(2);
    expect(snapshot.kind).toBe('select');
    expect(snapshot.final).toBe('ok');
    expect(snapshot.escape).toBe('back');
    expect(snapshot.message).toBe('Connected · Anthropic · claude-haiku-5-5');
    expect(snapshot.details).toEqual([
      '~/.relavium/config.toml',
      'Type a message to start, or /init to set up this folder',
    ]);
    expect(snapshot.options).toEqual([{ value: FRAMED_DONE_VALUE, label: 'Close' }]);
    r.answer();
    await expect(done).resolves.toBeUndefined();
    // the mark belongs to the step that set it: the flow's next state carries none
    expect(r.snapshot().final).toBeUndefined();
  });

  it('says a failure in its own words and tone, in the same one shape as a success', () => {
    const r = rig();
    r.flow.begin();
    void r.flow.done({
      message: 'Could not save the key.',
      lines: ['The keychain refused the write.'],
      tone: 'failed',
    });
    expect(r.snapshot().final).toBe('failed');
    expect(r.snapshot().options).toEqual([{ value: FRAMED_DONE_VALUE, label: 'Close' }]);
    expect(r.snapshot().details).toEqual(['The keychain refused the write.']);
  });

  it.each(['ok', 'failed'] as const)(
    'ONE option label in the %s tone, whatever a caller passes (the deprecated `label` is ignored): the legend under it says `close`',
    (tone) => {
      const r = rig();
      r.flow.begin();
      void r.flow.done({ message: 'Done.', label: 'Finish', tone });
      expect(r.snapshot().options.map((option) => option.label)).toEqual([FRAMED_DONE_LABEL]);
      expect(FRAMED_DONE_LABEL).toBe('Close');
    },
  );

  it('draws the target ONCE: as the first row under the sentence, never as the option’s hint, and not again when a line is the target word for word', () => {
    const r = rig();
    r.flow.begin();
    void r.flow.done({
      message: 'Created',
      lines: ['.relavium/', '.relavium/workflows/', 'No files were written.'],
      target: '.relavium/',
    });
    expect(r.snapshot().details).toEqual([
      '.relavium/',
      '.relavium/workflows/',
      'No files were written.',
    ]);
    expect(r.snapshot().options[0]?.hint).toBeUndefined();
  });

  it('a step with no target and no lines has no body rows of its own', () => {
    const r = rig();
    r.flow.begin();
    void r.flow.done({ message: 'Setup skipped' });
    expect(r.snapshot().details).toEqual([]);
  });

  it.each([
    ['Enter', false],
    ['Esc', false],
    ['Ctrl+C', true],
  ] as const)('closed by %s: the flow’s signal is aborted %s', async (how, aborted) => {
    const r = rig();
    const signal = r.flow.begin();
    const done = r.flow.done({ message: 'Created.' });
    r.settle();
    if (how === 'Enter') r.key(ENTER);
    else if (how === 'Esc') r.key(ESC);
    else r.key(CTRL_C[1], CTRL_C[0]);
    await expect(done).resolves.toBeUndefined();
    expect(signal.aborted).toBe(aborted);
  });

  it('resolves at once when the flow was cancelled before it', async () => {
    const r = rig();
    r.flow.begin();
    r.flow.cancel();
    await expect(r.flow.done({ message: 'Too late' })).resolves.toBeUndefined();
  });

  it('is not answered inside the flow’s opening settle', async () => {
    const r = rig();
    r.flow.begin();
    const done = r.flow.done({ message: 'Created.' });
    r.channel.ui.shown(r.snapshot());
    r.key(ENTER);
    const early = await Promise.race([
      done.then(() => 'closed'),
      new Promise<string>((resolve) => setImmediate(() => resolve('open'))),
    ]);
    expect(early).toBe('open');
    r.flow.cancel();
    await done;
  });
});

describe('a note belongs to the prompt it precedes (it never outlives its step)', () => {
  const KEY_NOTE =
    'Stored in your OS keychain, never on disk. Sent only to api.example.com, once, to check it.';

  it('shows on the prompt it was set before, and is gone when that prompt is answered (the key step’s disclosure is not on the next step)', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    r.flow.note(KEY_NOTE);
    const key = r.flow.at(1).password({ message: 'Key' });
    expect(r.snapshot().note).toBe(KEY_NOTE);
    r.key(none, 'sk-x');
    r.answer();
    await key;
    expect(r.snapshot().note).toBe('');
    r.flow.at(1).busy('Checking your key · one request to api.example.com');
    expect(r.snapshot().note).toBe('');
    const retry = r.flow.select({ message: 'The check failed', options: OPTIONS });
    expect(r.snapshot().note).toBe('');
    r.flow.cancel();
    await retry;
  });

  it('is gone when the prompt is stepped back from: the list a step back returns to has no heading above it (`/providers`, a provider action)', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const list = r.flow.at(0).select({ message: 'Which provider?', options: OPTIONS });
    expect(r.snapshot().note).toBe('');
    r.answer();
    await list;
    r.flow.note('Anthropic: a key is stored in the OS keychain.');
    const action = r.flow
      .at(0, { exitLabel: 'close' })
      .select({ message: 'Provider action', options: OPTIONS, escape: 'back' });
    expect(r.snapshot().note).toBe('Anthropic: a key is stored in the OS keychain.');
    r.back();
    expect(await action).toBe(NATIVE_PROMPT_BACK);
    expect(r.snapshot().note).toBe('');
    const again = r.flow.select({ message: 'Which provider?', options: OPTIONS });
    expect(r.snapshot().note, 'nothing of the action is above the list').toBe('');
    expect(r.snapshot().message).toBe('Which provider?');
    r.flow.cancel();
    await again;
  });

  it('is gone with a flow that was aborted: the next flow on the channel starts with none', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    r.flow.note('Setup note');
    const first = r.flow.select({ message: 'One', options: OPTIONS });
    r.flow.cancel();
    expect(await first).toBe(NATIVE_PROMPT_CANCEL);
    await r.flow.end();
    r.flow.begin();
    const next = r.flow.select({ message: 'Two', options: OPTIONS });
    expect(r.snapshot().note).toBe('');
    r.flow.cancel();
    await next;
  });

  it('a note set after one prompt and before the next is the next one’s, and only its', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const one = r.flow.at(0).select({ message: 'One', options: OPTIONS });
    r.answer();
    await one;
    r.flow.note('Could not save source consent.');
    const recovery = r.flow
      .at(0)
      .select({ message: 'How would you like to continue?', options: OPTIONS });
    expect(r.snapshot().note).toBe('Could not save source consent.');
    r.answer();
    await recovery;
    const after = r.flow.at(0).select({ message: 'Next', options: OPTIONS });
    expect(r.snapshot().note).toBe('');
    r.flow.cancel();
    await after;
  });

  it('a note set after a chord card resolved shows on the next prompt (the restore a flow does after its card)', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const card = r.flow.at(2).chord({ message: 'Start?', allow: 'Start', deny: 'Not now' });
    r.key(none, 'n');
    r.key({ ...none, ctrl: true }, 'n');
    expect(await card).toBe('deny');
    r.flow.note('Not offered, the file is not valid: broken.');
    const picker = r.flow.at(0).select({ message: 'Run which workflow?', options: OPTIONS });
    expect(r.snapshot().note).toBe('Not offered, the file is not valid: broken.');
    r.flow.cancel();
    await picker;
  });

  it('a wait clears nothing: a disclosure set for a write is on screen while the write publishes, and goes at the Done step (after it)', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const consent = r.flow.at(0).select({ message: 'Use it?', options: OPTIONS });
    r.answer();
    await consent;
    // the Home's disclosure-before-write: noted on the RAW channel (it does not go through the framed flow), then a wait, then the write
    r.channel.flow.note(
      'Saving preferences rewrites the global config and removes its comments and ordering.',
    );
    r.flow.at(0).busy('Saving preferences…');
    let writing: () => void = () => undefined;
    const write = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const written = write.then(() => r.snapshot().note);
    expect(r.snapshot().note).toContain('rewrites the global config');
    writing();
    expect(await written, 'still up when the write completed').toContain(
      'rewrites the global config',
    );
    void r.flow.done({ message: 'Connected', lines: ['Type a message to start.'] });
    expect(r.snapshot().note).toBe('');
  });

  it('the Done step starts with no note, wherever it came from: the key step’s, the keychain’s, a rewrite disclosure on the raw channel', () => {
    for (const [source, set] of [
      ['the key step’s disclosure', (r: ReturnType<typeof rig>) => r.flow.note(KEY_NOTE)],
      [
        'the keychain note',
        (r: ReturnType<typeof rig>) => r.flow.note('The keychain is still unavailable.'),
      ],
      [
        'a raw rewrite disclosure',
        (r: ReturnType<typeof rig>) =>
          r.channel.flow.note(
            'Saving preferences rewrites the global config and removes its comments and ordering.',
          ),
      ],
    ] as const) {
      const r = rig({ progress: 'manual' });
      r.flow.begin();
      set(r);
      expect(r.snapshot().note, source).not.toBe('');
      void r.flow.done({ message: 'Connected · Anthropic', lines: ['Kept by the Done step'] });
      expect(r.snapshot().note, source).toBe('');
      expect(r.snapshot().details, source).toEqual(['Kept by the Done step']);
      expect(r.snapshot().final).toBe('ok');
    }
  });

  it('the retry question’s sentence goes with the question, with no explicit clear (`/resume`’s restore: the wait that follows has none)', async () => {
    const r = rig({ progress: 'manual', stepNames: ['Session', 'Restore'] });
    r.flow.begin();
    r.flow.begin();
    r.flow.at(1).busy('Restoring session…');
    r.flow.note('Saved display text could not be read.');
    const retry = r.flow.select({ message: 'Restore session history?', options: OPTIONS });
    expect(r.snapshot().note).toBe('Saved display text could not be read.');
    r.answer();
    await retry;
    r.flow.at(1).busy('Restoring session…');
    expect(r.snapshot().note).toBe('');
    await r.flow.end();
    await r.flow.end();
  });
});

describe('what `Enter` says on a step’s text or masked field (`enterVerb`)', () => {
  it('is carried on the descriptor of THAT step’s prompts and on no other: the key step says `check`, the step after it nothing', async () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    const key = r.flow
      .at(1, { exitLabel: 'back', enterVerb: 'check' })
      .password({ message: 'Key' });
    expect(r.snapshot().popup?.enterVerb).toBe('check');
    expect(r.snapshot().popup?.exitLabel).toBe('back');
    r.key(none, 'sk-x');
    r.answer();
    await key;
    r.flow.at(1).busy('Checking');
    expect(r.snapshot().popup?.enterVerb).toBeUndefined();
    const retry = r.flow.at(1).select({ message: 'The check failed', options: OPTIONS });
    expect(r.snapshot().popup?.enterVerb).toBeUndefined();
    r.flow.cancel();
    await retry;
  });

  it('is part of what makes a frame this frame: the same step and way back with another verb is republished (the legend must change)', () => {
    const r = rig({ progress: 'manual' });
    r.flow.begin();
    r.flow.at(1).busy('Working');
    expect(r.snapshot().popup?.enterVerb).toBeUndefined();
    void r.flow.at(1, { enterVerb: 'check' }).text({ message: 'Name' });
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    expect(r.snapshot().popup?.enterVerb).toBe('check');
  });
});

describe('where it is never used', () => {
  it('the stand-alone chat’s pre-chat mount (which draws no popup slot) does not frame its flows', () => {
    const source = readFileSync(
      new URL('../commands/standalone-native-flow.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/framed-flow|framedFlow|\.popup\?\.\(/u);
  });
});
